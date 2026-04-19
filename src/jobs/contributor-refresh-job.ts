/**
 * Contributor refresh background job.
 *
 * Refreshes contributor rankings for tracked subreddits at least once
 * every 24 hours by calling `ContributorRankerService.refreshRankings()`.
 *
 * **Validates: Requirements 8.5**
 */

import type { Job, Worker } from 'bullmq';
import { getPool } from '../db/connection.js';
import { ContributorRankerService } from '../services/contributor-ranker-service.js';
import type { RedditScraper } from '../core/reddit-scraper.js';
import { createWorker, getQueue, QUEUE_NAMES } from './queue-setup.js';

// ---------------------------------------------------------------------------
// Job data types
// ---------------------------------------------------------------------------

export interface ContributorRefreshJobData {
  /** If provided, refresh only this subreddit. Otherwise refresh all known subreddits. */
  subreddit?: string;
}

// ---------------------------------------------------------------------------
// Refresh interval: every 24 hours
// ---------------------------------------------------------------------------

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Job processor
// ---------------------------------------------------------------------------

/**
 * Creates the contributor refresh worker.
 *
 * The worker processes jobs from the `contributor-refresh` queue. Each job
 * re-scrapes recent posts/comments for one or all tracked subreddits,
 * aggregates contributor stats, and updates influence scores.
 *
 * @param scraper - The RedditScraper instance for fetching Reddit data
 * @returns The BullMQ Worker instance
 */
export function createContributorRefreshWorker(scraper: RedditScraper): Worker<ContributorRefreshJobData> {
  const contributorService = new ContributorRankerService(scraper);

  return createWorker<ContributorRefreshJobData>(
    QUEUE_NAMES.CONTRIBUTOR_REFRESH,
    async (job: Job<ContributorRefreshJobData>) => {
      const { subreddit } = job.data;

      if (subreddit) {
        // Refresh a specific subreddit
        console.log(`[contributor-refresh] Refreshing rankings for r/${subreddit}`);
        await contributorService.refreshRankings(subreddit);
      } else {
        // Refresh all subreddits that have existing contributor scores
        const pool = getPool();
        const result = await pool.query<{ subreddit: string }>(
          `SELECT DISTINCT subreddit FROM contributor_scores`,
        );

        const subreddits = result.rows.map((r) => r.subreddit);
        console.log(
          `[contributor-refresh] Refreshing rankings for ${subreddits.length} subreddit(s)`,
        );

        for (const sub of subreddits) {
          try {
            await contributorService.refreshRankings(sub);
          } catch (err) {
            console.error(
              `[contributor-refresh] Error refreshing rankings for r/${sub}:`,
              err instanceof Error ? err.message : String(err),
            );
            // Continue with other subreddits
          }
        }
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Schedule repeating job
// ---------------------------------------------------------------------------

/**
 * Adds a repeating contributor refresh job to the queue.
 * Refreshes rankings every 24 hours.
 */
export async function scheduleContributorRefresh(): Promise<void> {
  const queue = getQueue(QUEUE_NAMES.CONTRIBUTOR_REFRESH);

  await queue.add(
    'refresh-all-contributors',
    {},
    {
      repeat: {
        every: REFRESH_INTERVAL_MS,
      },
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  );

  console.log(
    `[contributor-refresh] Scheduled repeating job every ${REFRESH_INTERVAL_MS / (1000 * 60 * 60)}h`,
  );
}
