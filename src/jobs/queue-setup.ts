/**
 * BullMQ queue setup and worker configuration.
 *
 * Defines all background job queues and provides helpers for creating
 * workers. Uses `ioredis` for the Redis connection, reading REDIS_URL
 * from environment variables.
 *
 * **Validates: Requirements 3.1, 5.6, 8.5, 10.4, 7.1**
 */

import { Queue, Worker, type Processor, type WorkerOptions } from 'bullmq';
import IORedis from 'ioredis';

// ---------------------------------------------------------------------------
// Redis connection
// ---------------------------------------------------------------------------

let connection: IORedis | null = null;

/**
 * Returns a shared IORedis connection instance for BullMQ queues and workers.
 * Reads `REDIS_URL` from environment (defaults to `redis://localhost:6379`).
 */
export function getRedisConnection(): IORedis {
  if (!connection) {
    const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
    connection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null, // required by BullMQ
    });
  }
  return connection;
}

/**
 * Closes the shared Redis connection. Call during graceful shutdown.
 */
export async function closeRedisConnection(): Promise<void> {
  if (connection) {
    await connection.quit();
    connection = null;
  }
}

// ---------------------------------------------------------------------------
// Queue names
// ---------------------------------------------------------------------------

export const QUEUE_NAMES = {
  KEYWORD_POLLING: 'keyword-polling',
  SUBREDDIT_SNAPSHOT: 'subreddit-snapshot',
  CONTRIBUTOR_REFRESH: 'contributor-refresh',
  WEBHOOK_DISPATCH: 'webhook-dispatch',
  NOTIFICATION_DISPATCH: 'notification-dispatch',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// ---------------------------------------------------------------------------
// Queue instances
// ---------------------------------------------------------------------------

let queues: Map<string, Queue> | null = null;

/**
 * Returns all BullMQ queue instances, creating them lazily on first call.
 */
export function getQueues(): Map<string, Queue> {
  if (!queues) {
    const conn = getRedisConnection();
    queues = new Map<string, Queue>();

    for (const name of Object.values(QUEUE_NAMES)) {
      queues.set(name, new Queue(name, { connection: conn }));
    }
  }
  return queues;
}

/**
 * Returns a specific queue by name.
 */
export function getQueue(name: QueueName): Queue {
  const q = getQueues().get(name);
  if (!q) {
    throw new Error(`Queue "${name}" not found`);
  }
  return q;
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

/**
 * Creates a BullMQ Worker for the given queue name and processor function.
 *
 * @param queueName - One of the defined queue names
 * @param processor - The job processing function
 * @param opts      - Optional BullMQ WorkerOptions overrides
 * @returns The created Worker instance
 */
export function createWorker<T = unknown>(
  queueName: QueueName,
  processor: Processor<T>,
  opts?: Partial<WorkerOptions>,
): Worker<T> {
  const conn = getRedisConnection();

  const worker = new Worker<T>(queueName, processor, {
    connection: conn,
    concurrency: 1,
    ...opts,
  });

  worker.on('failed', (job, err) => {
    console.error(
      `[${queueName}] Job ${job?.id ?? 'unknown'} failed:`,
      err.message,
    );
  });

  worker.on('completed', (job) => {
    console.log(`[${queueName}] Job ${job.id} completed`);
  });

  return worker;
}

// ---------------------------------------------------------------------------
// Graceful shutdown helper
// ---------------------------------------------------------------------------

/**
 * Closes all queues and the shared Redis connection.
 */
export async function closeAllQueues(): Promise<void> {
  if (queues) {
    const closePromises = Array.from(queues.values()).map((q) => q.close());
    await Promise.all(closePromises);
    queues = null;
  }
  await closeRedisConnection();
}
