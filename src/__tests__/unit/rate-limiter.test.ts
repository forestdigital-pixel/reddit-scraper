import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../../core/rate-limiter';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should use default minIntervalMs of 2000', async () => {
    const limiter = new RateLimiter();
    const start = Date.now();

    // First acquire should resolve immediately
    const p1 = limiter.acquire();
    await vi.advanceTimersByTimeAsync(0);
    await p1;

    // Second acquire should wait ~2000ms
    const p2 = limiter.acquire();
    await vi.advanceTimersByTimeAsync(2000);
    await p2;

    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(2000);
  });

  it('should resolve first acquire immediately when no prior requests', async () => {
    const limiter = new RateLimiter(1000);
    const start = Date.now();

    const p = limiter.acquire();
    await vi.advanceTimersByTimeAsync(0);
    await p;

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it('should enforce minimum interval between consecutive acquires', async () => {
    const limiter = new RateLimiter(500);
    const timestamps: number[] = [];

    const p1 = limiter.acquire().then(() => timestamps.push(Date.now()));
    const p2 = limiter.acquire().then(() => timestamps.push(Date.now()));
    const p3 = limiter.acquire().then(() => timestamps.push(Date.now()));

    // Process all timers
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);

    await Promise.all([p1, p2, p3]);

    expect(timestamps).toHaveLength(3);
    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(500);
    expect(timestamps[2] - timestamps[1]).toBeGreaterThanOrEqual(500);
  });

  it('should report correct queue length', async () => {
    const limiter = new RateLimiter(1000);

    expect(limiter.getQueueLength()).toBe(0);

    const p1 = limiter.acquire();
    expect(limiter.getQueueLength()).toBe(1);

    const p2 = limiter.acquire();
    expect(limiter.getQueueLength()).toBe(2);

    // Resolve first
    await vi.advanceTimersByTimeAsync(0);
    await p1;
    expect(limiter.getQueueLength()).toBe(1);

    // Resolve second
    await vi.advanceTimersByTimeAsync(1000);
    await p2;
    expect(limiter.getQueueLength()).toBe(0);
  });

  it('should process requests in FIFO order', async () => {
    const limiter = new RateLimiter(100);
    const order: number[] = [];

    const p1 = limiter.acquire().then(() => order.push(1));
    const p2 = limiter.acquire().then(() => order.push(2));
    const p3 = limiter.acquire().then(() => order.push(3));

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    await Promise.all([p1, p2, p3]);

    expect(order).toEqual([1, 2, 3]);
  });

  it('should accept custom minIntervalMs', async () => {
    const limiter = new RateLimiter(100);
    const timestamps: number[] = [];

    const p1 = limiter.acquire().then(() => timestamps.push(Date.now()));
    const p2 = limiter.acquire().then(() => timestamps.push(Date.now()));

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);

    await Promise.all([p1, p2]);

    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(100);
  });
});
