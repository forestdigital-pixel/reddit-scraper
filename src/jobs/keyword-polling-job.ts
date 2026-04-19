/**
 * Keyword polling background job.
 *
 * Polls Reddit every ~10 minutes for each active keyword. When new matches
 * are found, triggers notifications and webhook dispatches.
 *
 * The 10-minute polling interval combined with the processing time ensures
 * the 30-minute SLA for notification delivery (Requirement 7.1).
 *
 * **Validates: Requirements 7.1, 7.4, 10.4**
 */

import type { Job, Worker } from 'bullmq';
import { getPool } from '../db/connection.js';
import { KeywordTrackerService } from '../services/keyword-tracker-service.js';
import { NotificationService } from '../services/notification-service.js';
import { WebhookService } from '../services/webhook-service.js';
import type { RedditScraper } from '../core/reddit-scraper.js';
import type { TrackedKeyword } from '../models/database.js';
import type { KeywordMatchInfo } from '../services/notification-service.js';
import { createWorker, getQueue, QUEUE_NAMES } from './queue-setup.js';

// ---------------------------------------------------------------------------
// Job data types
// ---------------------------------------------------------------------------

export interface KeywordPollingJobData {
  /** If provided, poll only this keyword. Otherwise poll all active keywords. */
  keywordId?: string;
}

// ---------------------------------------------------------------------------
// Polling interval: ~10 minutes
// ---------------------------------------------------------------------------

const POLLING_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Job processor
// ---------------------------------------------------------------------------

/**
 * Creates the keyword polling worker.
 *
 * The worker processes jobs from the `keyword-polling` queue. Each job
 * polls all active keywords (or a specific keyword if `keywordId` is set),
 * detects new matches, and triggers notifications + webhook dispatches.
 *
 * @param scraper - The RedditScraper instance for fetching Reddit data
 * @returns The BullMQ Worker instance
 */
export function createKeywordPollingWorker(scraper: RedditScraper): Worker<KeywordPollingJobData> {
  const keywordService = new KeywordTrackerService(scraper);
  const notificationService = new NotificationService();
  const webhookService = new WebhookService();

  return createWorker<KeywordPollingJobData>(
    QUEUE_NAMES.KEYWORD_POLLING,
    async (job: Job<KeywordPollingJobData>) => {
      const { keywordId } = job.data;

      let keywords: TrackedKeyword[];

      if (keywordId) {
        // Poll a specific keyword
        const pool = getPool();
        const result = await pool.query<TrackedKeyword>(
          `SELECT id, user_id, keyword, is_active, notifications_enabled, last_match_at, created_at
           FROM tracked_keywords
           WHERE id = $1 AND is_active = TRUE`,
          [keywordId],
        );
        keywords = result.rows;
      } else {
        // Poll all active keywords across all users
        const pool = getPool();
        const result = await pool.query<TrackedKeyword>(
          `SELECT id, user_id, keyword, is_active, notifications_enabled, last_match_at, created_at
           FROM tracked_keywords
           WHERE is_active = TRUE`,
        );
        keywords = result.rows;
      }

      console.log(`[keyword-polling] Polling ${keywords.length} active keyword(s)`);

      for (const keyword of keywords) {
        try {
          const newMatches = await keywordService.pollKeyword(keyword);

          if (newMatches.length > 0) {
            console.log(
              `[keyword-polling] Found ${newMatches.length} new match(es) for "${keyword.keyword}"`,
            );

            // Trigger notifications if enabled for this keyword
            if (keyword.notifications_enabled) {
              for (const match of newMatches) {
                const contentId = match.data.id;
                const permalink = match.data.permalink;

                const matchInfo: KeywordMatchInfo = {
                  keywordId: keyword.id,
                  contentId,
                  contentType: match.content_type,
                  permalink,
                };

                await notificationService.sendNotification(keyword.user_id, matchInfo);
              }
            }

            // Dispatch webhook events for keyword matches
            for (const match of newMatches) {
              await webhookService.dispatch('keyword_match', {
                keyword: keyword.keyword,
                keywordId: keyword.id,
                contentId: match.data.id,
                contentType: match.content_type,
                permalink: match.data.permalink,
                matchedAt: new Date().toISOString(),
              });
            }
          }
        } catch (err) {
          console.error(
            `[keyword-polling] Error polling keyword "${keyword.keyword}":`,
            err instanceof Error ? err.message : String(err),
          );
          // Continue polling other keywords even if one fails
        }
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Schedule repeating job
// ---------------------------------------------------------------------------

/**
 * Adds a repeating keyword polling job to the queue.
 * Polls every ~10 minutes to stay within the 30-minute notification SLA.
 */
export async function scheduleKeywordPolling(): Promise<void> {
  const queue = getQueue(QUEUE_NAMES.KEYWORD_POLLING);

  await queue.add(
    'poll-all-keywords',
    {},
    {
      repeat: {
        every: POLLING_INTERVAL_MS,
      },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
    },
  );

  console.log(
    `[keyword-polling] Scheduled repeating job every ${POLLING_INTERVAL_MS / 1000}s`,
  );
}
