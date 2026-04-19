/**
 * Token-bucket rate limiter ensuring requests stay below Reddit's detection thresholds.
 * Default is 1 request per 2 seconds.
 *
 * Validates: Requirements 9.4
 */
export class RateLimiter {
  private readonly minIntervalMs: number;
  private lastRequestTime: number = 0;
  private queue: Array<() => void> = [];
  private processing: boolean = false;

  constructor(minIntervalMs: number = 2000) {
    this.minIntervalMs = minIntervalMs;
  }

  /**
   * Acquires a token from the rate limiter.
   * Resolves after the minimum interval has elapsed since the last request.
   * Requests are queued and processed in FIFO order.
   */
  acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.processQueue();
    });
  }

  /**
   * Returns the number of pending requests in the queue.
   */
  getQueueLength(): number {
    return this.queue.length;
  }

  private processQueue(): void {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    const waitTime = Math.max(0, this.minIntervalMs - elapsed);

    setTimeout(() => {
      this.lastRequestTime = Date.now();
      const resolve = this.queue.shift();
      this.processing = false;

      if (resolve) {
        resolve();
      }

      // Continue processing remaining items in the queue
      if (this.queue.length > 0) {
        this.processQueue();
      }
    }, waitTime);
  }
}
