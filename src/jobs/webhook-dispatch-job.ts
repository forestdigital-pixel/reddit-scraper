/**
 * Webhook dispatch background job.
 *
 * Processes queued webhook deliveries with retry logic. Failed deliveries
 * are retried up to 3 times with exponential backoff (1s, 4s, 16s).
 *
 * This job handles individual webhook delivery tasks that are enqueued
 * when events occur (e.g., keyword matches, theme detections).
 *
 * **Validates: Requirements 10.6**
 */

import type { Job, Worker } from 'bullmq';
import { getPool } from '../db/connection.js';
import { sign } from '../services/webhook-service.js';
import type { DeliveryStatus } from '../models/database.js';
import { createWorker, getQueue, QUEUE_NAMES } from './queue-setup.js';

// ---------------------------------------------------------------------------
// Job data types
// ---------------------------------------------------------------------------

export interface WebhookDispatchJobData {
  /** The webhook delivery ID to process. */
  deliveryId: string;
  /** The target URL to POST to. */
  url: string;
  /** The JSON payload string. */
  payload: string;
  /** The HMAC secret for signing. */
  secret: string;
  /** The webhook event type. */
  event: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of delivery retries. */
const MAX_RETRIES = 3;

/** Exponential backoff delays in milliseconds: 1s, 4s, 16s. */
const BACKOFF_DELAYS_MS = [1_000, 4_000, 16_000];

// ---------------------------------------------------------------------------
// Job processor
// ---------------------------------------------------------------------------

/**
 * Creates the webhook dispatch worker.
 *
 * The worker processes jobs from the `webhook-dispatch` queue. Each job
 * attempts to deliver a webhook payload to the registered URL, retrying
 * on failure with exponential backoff.
 *
 * @returns The BullMQ Worker instance
 */
export function createWebhookDispatchWorker(): Worker<WebhookDispatchJobData> {
  return createWorker<WebhookDispatchJobData>(
    QUEUE_NAMES.WEBHOOK_DISPATCH,
    async (job: Job<WebhookDispatchJobData>) => {
      const { deliveryId, url, payload, secret, event } = job.data;

      const signature = sign(payload, secret);
      let lastError: Error | null = null;
      let delivered = false;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        // Wait for backoff delay on retries (not on first attempt)
        if (attempt > 0) {
          const delay =
            BACKOFF_DELAYS_MS[attempt - 1] ??
            BACKOFF_DELAYS_MS[BACKOFF_DELAYS_MS.length - 1];
          await sleep(delay);
        }

        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Webhook-Signature': signature,
              'X-Webhook-Event': event,
            },
            body: payload,
            signal: AbortSignal.timeout(10_000), // 10s timeout
          });

          if (response.ok) {
            delivered = true;
            break;
          }

          lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
        }

        // Update retry count after each failed attempt
        await updateDeliveryStatus(deliveryId, 'pending', attempt + 1);
      }

      // Final status update
      const finalStatus: DeliveryStatus = delivered ? 'delivered' : 'failed';
      const retryCount = delivered ? 0 : MAX_RETRIES;
      await updateDeliveryStatus(deliveryId, finalStatus, retryCount);

      if (!delivered && lastError) {
        console.error(
          `[webhook-dispatch] Delivery ${deliveryId} to ${url} failed after ${MAX_RETRIES} retries:`,
          lastError.message,
        );
        throw lastError; // Let BullMQ mark the job as failed
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Enqueue helper
// ---------------------------------------------------------------------------

/**
 * Enqueues a webhook delivery job for background processing.
 */
export async function enqueueWebhookDispatch(
  data: WebhookDispatchJobData,
): Promise<void> {
  const queue = getQueue(QUEUE_NAMES.WEBHOOK_DISPATCH);
  await queue.add('deliver-webhook', data, {
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 1000 },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function updateDeliveryStatus(
  deliveryId: string,
  status: DeliveryStatus,
  retryCount: number,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE webhook_deliveries
     SET status = $1, retry_count = $2, last_attempt_at = NOW()
     WHERE id = $3`,
    [status, retryCount, deliveryId],
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
