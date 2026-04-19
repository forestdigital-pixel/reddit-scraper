import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProxyManager, ProxyConfig } from '../../core/proxy-manager';

describe('ProxyManager', () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Helper to create a ProxyManager with sensible test defaults.
   * Uses a very small rate limit interval to keep tests fast.
   */
  function createManager(overrides: Partial<ProxyConfig> = {}): ProxyManager {
    return new ProxyManager({
      userAgent: 'TestAgent/1.0',
      rateLimitMs: 10,
      maxRetries: 3,
      ...overrides,
    });
  }

  /**
   * Helper to create a minimal mock Response.
   */
  function mockResponse(status: number, body: string = ''): Response {
    return new Response(body, { status });
  }

  // ---------------------------------------------------------------------------
  // Requirement 9.6: Fallback behavior when no proxy configured
  // ---------------------------------------------------------------------------
  describe('fallback when no proxy configured', () => {
    it('should return false from isProxyConfigured() when no proxyUrl is set', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const manager = createManager({ proxyUrl: undefined });

      expect(manager.isProxyConfigured()).toBe(false);
      warnSpy.mockRestore();
    });

    it('should return false from isProxyConfigured() when proxyUrl is empty string', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const manager = createManager({ proxyUrl: '' });

      expect(manager.isProxyConfigured()).toBe(false);
      warnSpy.mockRestore();
    });

    it('should log a warning when no proxy is configured', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      createManager({ proxyUrl: undefined });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('No proxy configured');
      expect(warnSpy.mock.calls[0][0]).toContain('Falling back to direct connections');

      warnSpy.mockRestore();
    });

    it('should still make requests via direct connection when no proxy is configured', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const manager = createManager({ proxyUrl: undefined });

      mockFetch.mockResolvedValueOnce(mockResponse(200, '{"ok":true}'));

      const fetchPromise = manager.fetch('https://reddit.com/r/test.json');
      await vi.advanceTimersByTimeAsync(50);
      const response = await fetchPromise;

      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      warnSpy.mockRestore();
    });

    it('should return undefined from getAgent() when no proxy is configured', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const manager = createManager({ proxyUrl: undefined });

      expect(manager.getAgent()).toBeUndefined();
      warnSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // Requirement 9.5: Custom User-Agent header
  // ---------------------------------------------------------------------------
  describe('User-Agent header', () => {
    it('should set the custom User-Agent header on every request', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const manager = createManager({ userAgent: 'MyCustomAgent/2.0' });

      mockFetch.mockResolvedValueOnce(mockResponse(200));

      const fetchPromise = manager.fetch('https://reddit.com/r/test.json');
      await vi.advanceTimersByTimeAsync(50);
      await fetchPromise;

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const calledOptions = mockFetch.mock.calls[0][1] as RequestInit;
      const headers = new Headers(calledOptions.headers);
      expect(headers.get('User-Agent')).toBe('MyCustomAgent/2.0');

      warnSpy.mockRestore();
    });

    it('should override any existing User-Agent header with the configured one', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const manager = createManager({ userAgent: 'OverrideAgent/1.0' });

      mockFetch.mockResolvedValueOnce(mockResponse(200));

      const fetchPromise = manager.fetch('https://reddit.com/r/test.json', {
        headers: { 'User-Agent': 'ShouldBeOverridden' },
      });
      await vi.advanceTimersByTimeAsync(50);
      await fetchPromise;

      const calledOptions = mockFetch.mock.calls[0][1] as RequestInit;
      const headers = new Headers(calledOptions.headers);
      expect(headers.get('User-Agent')).toBe('OverrideAgent/1.0');

      warnSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // Requirement 9.1, 9.3: Retry logic with HTTP errors (429, 403, 5xx)
  // ---------------------------------------------------------------------------
  describe('retry logic', () => {
    it('should retry on 429 and succeed on second attempt', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const manager = createManager({ maxRetries: 3 });

      mockFetch
        .mockResolvedValueOnce(mockResponse(429))
        .mockResolvedValueOnce(mockResponse(200, '{"ok":true}'));

      const fetchPromise = manager.fetch('https://reddit.com/r/test.json');

      // Advance past rate limiter + first attempt
      await vi.advanceTimersByTimeAsync(50);
      // Advance past backoff delay (2s for first retry) + rate limiter
      await vi.advanceTimersByTimeAsync(2500);

      const response = await fetchPromise;

      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('should retry on 403 and succeed on second attempt', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const manager = createManager({ maxRetries: 3 });

      mockFetch
        .mockResolvedValueOnce(mockResponse(403))
        .mockResolvedValueOnce(mockResponse(200, '{"ok":true}'));

      const fetchPromise = manager.fetch('https://reddit.com/r/test.json');

      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(2500);

      const response = await fetchPromise;

      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('should retry on 5xx errors and succeed on second attempt', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const manager = createManager({ maxRetries: 3 });

      mockFetch
        .mockResolvedValueOnce(mockResponse(500))
        .mockResolvedValueOnce(mockResponse(200, '{"ok":true}'));

      const fetchPromise = manager.fetch('https://reddit.com/r/test.json');

      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(2500);

      const response = await fetchPromise;

      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('should return the last failed response after exhausting all retries', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const manager = createManager({ maxRetries: 2 });

      mockFetch
        .mockResolvedValueOnce(mockResponse(429))
        .mockResolvedValueOnce(mockResponse(429))
        .mockResolvedValueOnce(mockResponse(429));

      const fetchPromise = manager.fetch('https://reddit.com/r/test.json');

      // Attempt 0 (initial)
      await vi.advanceTimersByTimeAsync(50);
      // Attempt 1 (retry 1, backoff 2s)
      await vi.advanceTimersByTimeAsync(2500);
      // Attempt 2 (retry 2, backoff 8s)
      await vi.advanceTimersByTimeAsync(8500);

      const response = await fetchPromise;

      expect(response.status).toBe(429);
      expect(mockFetch).toHaveBeenCalledTimes(3);

      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('should log failed requests with timestamps on retryable status codes', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const manager = createManager({ maxRetries: 1 });

      mockFetch
        .mockResolvedValueOnce(mockResponse(503))
        .mockResolvedValueOnce(mockResponse(200));

      const fetchPromise = manager.fetch('https://reddit.com/r/test.json');

      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(2500);

      await fetchPromise;

      // Should have logged the 503 error
      expect(errorSpy).toHaveBeenCalled();
      const errorCall = errorSpy.mock.calls[0][0] as string;
      expect(errorCall).toContain('ProxyManager');
      expect(errorCall).toContain('503');
      expect(errorCall).toContain('https://reddit.com/r/test.json');

      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('should not retry on non-retryable status codes (e.g. 404)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const manager = createManager({ maxRetries: 3 });

      mockFetch.mockResolvedValueOnce(mockResponse(404));

      const fetchPromise = manager.fetch('https://reddit.com/r/test.json');
      await vi.advanceTimersByTimeAsync(50);

      const response = await fetchPromise;

      expect(response.status).toBe(404);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      warnSpy.mockRestore();
    });

    it('should throw after exhausting retries on network errors', async () => {
      vi.useRealTimers();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      // Use real timers with minimal delays to avoid unhandled rejection timing issues
      const manager = new ProxyManager({
        userAgent: 'TestAgent/1.0',
        rateLimitMs: 1,
        maxRetries: 1,
      });

      mockFetch.mockImplementation(() => Promise.reject(new Error('Network error')));

      await expect(manager.fetch('https://reddit.com/r/test.json')).rejects.toThrow('Network error');
      expect(mockFetch).toHaveBeenCalledTimes(2);

      warnSpy.mockRestore();
      errorSpy.mockRestore();
      vi.useFakeTimers();
    });

    it('should recover from a network error on retry', async () => {
      vi.useRealTimers();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const manager = new ProxyManager({
        userAgent: 'TestAgent/1.0',
        rateLimitMs: 1,
        maxRetries: 2,
      });

      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('Connection reset'));
        }
        return Promise.resolve(mockResponse(200, '{"ok":true}'));
      });

      const response = await manager.fetch('https://reddit.com/r/test.json');

      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      warnSpy.mockRestore();
      errorSpy.mockRestore();
      vi.useFakeTimers();
    });
  });

  // ---------------------------------------------------------------------------
  // Requirement 9.1: isProxyConfigured with a proxy URL
  // ---------------------------------------------------------------------------
  describe('proxy configuration', () => {
    it('should return true from isProxyConfigured() when proxyUrl is set', () => {
      // We don't actually connect to a proxy in tests, but we can verify the flag.
      // The dynamic import of https-proxy-agent will run but we don't need it to succeed
      // for this check.
      const manager = createManager({ proxyUrl: 'http://user:pass@proxy.example.com:8080' });
      expect(manager.isProxyConfigured()).toBe(true);
    });
  });
});
