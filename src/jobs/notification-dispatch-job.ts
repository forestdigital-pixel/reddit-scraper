/**
 * Notification dispatch background job.
 *
 * Processes queued notifications with retry logic. Failed notifications
 * are retried up to 3 times with exponential backoff.
 *
 * This job handles individual notification delivery tasks and also
 * periodically retries previously failed notifications.
 *
 * **Validates: Requirements 7.5**
 */

import type { Job, Worker } from 'bullmq';
import { NotificationService } from '../services/notification-service.js';
import type { KeywordMatchInfo } from '../services/notification-service.js';
import { createWorker, getQueue, QUEUE_NAMES } from './queue-setup.js';

// ---------------------------------------------------------------------------
// Job data types
// ---------------------------------------------------------------------------

export interface NotificationDispatchJobData {
  /** The user to notify. */
  userId: string;
  /** The keyword match information. */
  match: KeywordMatchInfo;
}

export interface RetryFailedJobData {
  /** Marker to distinguish retry-all jobs from individual dispatches. */
  retryFailed: true;
}

type NotificationJobData = NotificationDispatchJobData | RetryFailedJobData;

// ---------------------------------------------------------------------------
// Retry interval: every 5 minutes
// ---------------------------------------------------------------------------

const RETRY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function isRetryJob(data: NotificationJobData): data is RetryFailedJobData {
  return 'retryFailed' in data && data.retryFailed === true;
}

// ---------------------------------------------------------------------------
// Job processor
// ---------------------------------------------------------------------------

/**
 * Creates the notification dispatch worker.
 *
 * The worker processes jobs from the `notification-dispatch` queue.
 * It handles two types of jobs:
 * 1. Individual notification dispatches (send a notification to a user)
 * 2. Retry-failed sweeps (retry all previously failed notifications)
 *
 * @returns The BullMQ Worker instance
 */
export function createNotificationDispatchWorker(): Worker<NotificationJobData> {
  const notificationService = new NotificationService();

  return createWorker<NotificationJobData>(
    QUEUE_NAMES.NOTIFICATION_DISPATCH,
    async (job: Job<NotificationJobData>) => {
      if (isRetryJob(job.data)) {
        // Retry all previously failed notifications
        console.log('[notification-dispatch] Retrying failed notifications');
        await notificationService.retryFailed();
      } else {
        // Send an individual notification
        const { userId, match } = job.data;
        console.log(
          `[notification-dispatch] Sending notification to user ${userId} for content ${match.contentId}`,
        );
        await notificationService.sendNotification(userId, match);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Enqueue helpers
// ---------------------------------------------------------------------------

/**
 * Enqueues a notification dispatch job for background processing.
 */
export async function enqueueNotificationDispatch(
  data: NotificationDispatchJobData,
): Promise<void> {
  const queue = getQueue(QUEUE_NAMES.NOTIFICATION_DISPATCH);
  await queue.add('send-notification', data, {
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 1000 },
  });
}

/**
 * Schedules a repeating job to retry failed notifications.
 */
export async function scheduleNotificationRetries(): Promise<void> {
  const queue = getQueue(QUEUE_NAMES.NOTIFICATION_DISPATCH);

  await queue.add(
    'retry-failed-notifications',
    { retryFailed: true } satisfies RetryFailedJobData,
    {
      repeat: {
        every: RETRY_INTERVAL_MS,
      },
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  );

  console.log(
    `[notification-dispatch] Scheduled retry sweep every ${RETRY_INTERVAL_MS / (1000 * 60)}m`,
  );
}
