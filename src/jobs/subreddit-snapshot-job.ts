/**
 * Subreddit snapshot background job.
 *
 * Periodically records subscriber and active user counts for tracked
 * subreddits by calling `SubredditAnalyzerService.recordSnapshot()`.
 *
 * **Validates: Requirements 5.6**
 */

import type { Job, Worker } from 'bullmq';
import { getPool } from '../db/connection.js';
import { SubredditAnalyzerService } from '../services/subreddit-analyzer-service.js';
import type { RedditScraper } from '../core/reddit-scraper.js';
import { createWorker, getQueue, QUEUE_NAMES } from './queue-setup.js';

// ---------------------------------------------------------------------------
// Job data types
// ---------------------------------------------------------------------------

export interface SubredditSnapshotJobData {
  /** If provided, snapshot only this subreddit. Otherwise snapshot all known subreddits. */
  subreddit?: string;
}

// ---------------------------------------------------------------------------
// Snapshot interval: every 6 hours
// ---------------------------------------------------------------------------

const SNAPSHOT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ---------------------------------------------------------------------------
// Job processor
// ---------------------------------------------------------------------------

/**
 * Creates the subreddit snapshot worker.
 *
 * The worker processes jobs from the `subreddit-snapshot` queue. Each job
 * records a snapshot of subscriber/active user counts for one or all
 * tracked subreddits.
 *
 * @param scraper - The RedditScraper instance for fetching subreddit data
 * @returns The BullMQ Worker instance
 */
export function createSubredditSnapshotWorker(scraper: RedditScraper): Worker<SubredditSnapshotJobData> {
  const subredditService = new SubredditAnalyzerService(scraper);

  return createWorker<SubredditSnapshotJobData>(
    QUEUE_NAMES.SUBREDDIT_SNAPSHOT,
    async (job: Job<SubredditSnapshotJobData>) => {
      const { subreddit } = job.data;

      if (subreddit) {
        // Snapshot a specific subreddit
        console.log(`[subreddit-snapshot] Recording snapshot for r/${subreddit}`);
        await subredditService.recordSnapshot(subreddit);
      } else {
        // Snapshot all subreddits that have been previously tracked
        // (i.e., have existing snapshots in the database)
        const pool = getPool();
        const result = await pool.query<{ subreddit: string }>(
          `SELECT DISTINCT subreddit FROM subreddit_snapshots`,
        );

        const subreddits = result.rows.map((r) => r.subreddit);
        console.log(
          `[subreddit-snapshot] Recording snapshots for ${subreddits.length} subreddit(s)`,
        );

        for (const sub of subreddits) {
          try {
            await subredditService.recordSnapshot(sub);
          } catch (err) {
            console.error(
              `[subreddit-snapshot] Error recording snapshot for r/${sub}:`,
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
 * Adds a repeating subreddit snapshot job to the queue.
 * Records snapshots every 6 hours.
 */
export async function scheduleSubredditSnapshots(): Promise<void> {
  const queue = getQueue(QUEUE_NAMES.SUBREDDIT_SNAPSHOT);

  await queue.add(
    'snapshot-all-subreddits',
    {},
    {
      repeat: {
        every: SNAPSHOT_INTERVAL_MS,
      },
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  );

  console.log(
    `[subreddit-snapshot] Scheduled repeating job every ${SNAPSHOT_INTERVAL_MS / (1000 * 60 * 60)}h`,
  );
}
