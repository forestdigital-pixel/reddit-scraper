import { RateLimiter } from './rate-limiter.js';

/**
 * Minimal type for the HttpsProxyAgent from the `https-proxy-agent` package.
 * Defined locally to avoid ESM/CJS import issues with TypeScript strict mode.
 * The actual class is loaded via dynamic import() at runtime.
 */
interface HttpsProxyAgentInstance {
  proxy: URL;
}

/**
 * Configuration for the ProxyManager.
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.5, 9.6, 9.7
 */
export interface ProxyConfig {
  proxyUrl?: string;       // http://username-rotate:password@host:port
  userAgent: string;
  rateLimitMs: number;     // default: 2000 (1 req per 2s)
  maxRetries: number;      // default: 3
}

/**
 * Dynamically imports the ESM-only https-proxy-agent package.
 */
async function createProxyAgent(proxyUrl: string): Promise<HttpsProxyAgentInstance> {
  const { HttpsProxyAgent } = await import('https-proxy-agent');
  return new HttpsProxyAgent(proxyUrl);
}

/**
 * Routes all outbound HTTP requests through a rotating proxy with retry logic,
 * rate limiting, and custom User-Agent headers.
 *
 * - Uses `https-proxy-agent` for proxied requests
 * - Falls back to direct connection if no proxy is configured (logs warning)
 * - Retries on 429, 403, and 5xx with exponential backoff: delay = 2s * 4^(attempt-1)
 * - Enforces rate limiting via the RateLimiter
 * - Sets a custom User-Agent header on every request
 * - Logs all failed requests with timestamps
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.5, 9.6, 9.7
 */
export class ProxyManager {
  private agent: HttpsProxyAgentInstance | undefined;
  private agentReady: Promise<void> | undefined;
  private readonly rateLimiter: RateLimiter;
  private readonly config: ProxyConfig;

  constructor(config: ProxyConfig) {
    this.config = config;
    this.rateLimiter = new RateLimiter(config.rateLimitMs);

    if (config.proxyUrl) {
      // Initialize the proxy agent asynchronously
      this.agentReady = createProxyAgent(config.proxyUrl).then((agent) => {
        this.agent = agent;
      });
    } else {
      this.agent = undefined;
      this.agentReady = undefined;
      console.warn(
        `[${new Date().toISOString()}] ProxyManager: No proxy configured. ` +
        `Falling back to direct connections. Requests may be rate-limited by Reddit.`
      );
    }
  }

  /**
   * Fetches a URL through the proxy (or directly if no proxy is configured),
   * with rate limiting and retry logic on retryable status codes.
   */
  async fetch(url: string, options?: RequestInit): Promise<Response> {
    // Ensure the proxy agent is ready before making requests
    if (this.agentReady) {
      await this.agentReady;
    }

    const maxRetries = this.config.maxRetries;
    const baseDelay = 2000; // 2 seconds

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Wait for retry backoff on subsequent attempts
      if (attempt > 0) {
        const delay = baseDelay * Math.pow(4, attempt - 1); // 2s, 8s, 32s
        await this.sleep(delay);
      }

      // Acquire rate limiter token before making the request
      await this.rateLimiter.acquire();

      try {
        const fetchOptions = this.buildFetchOptions(options);
        const response = await fetch(url, fetchOptions);

        if (this.isRetryableStatus(response.status)) {
          console.error(
            `[${new Date().toISOString()}] ProxyManager: Request failed - ` +
            `URL: ${url}, Status: ${response.status}, Attempt: ${attempt + 1}/${maxRetries + 1}`
          );

          if (attempt < maxRetries) {
            continue;
          }

          // All retries exhausted, return the last failed response
          return response;
        }

        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.error(
          `[${new Date().toISOString()}] ProxyManager: Request error - ` +
          `URL: ${url}, Error: ${lastError.message}, Attempt: ${attempt + 1}/${maxRetries + 1}`
        );

        if (attempt >= maxRetries) {
          throw lastError;
        }
      }
    }

    // This should be unreachable, but TypeScript needs it
    throw lastError ?? new Error('ProxyManager: fetch failed with no error captured');
  }

  /**
   * Returns the HttpsProxyAgent instance, or undefined if no proxy is configured.
   */
  getAgent(): HttpsProxyAgentInstance | undefined {
    return this.agent;
  }

  /**
   * Returns whether a proxy URL was configured.
   */
  isProxyConfigured(): boolean {
    return this.config.proxyUrl !== undefined && this.config.proxyUrl !== '';
  }

  /**
   * Builds fetch options with the custom User-Agent header and proxy agent (if configured).
   */
  private buildFetchOptions(options?: RequestInit): RequestInit {
    const headers = new Headers(options?.headers);
    headers.set('User-Agent', this.config.userAgent);

    const fetchOptions: RequestInit = {
      ...options,
      headers,
    };

    // Attach the proxy agent for Node.js native fetch.
    // Node.js native fetch (undici) doesn't support http.Agent directly,
    // but the https-proxy-agent works with the non-standard `agent` property.
    if (this.agent) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fetchOptions as any).agent = this.agent;
    }

    return fetchOptions;
  }

  /**
   * Determines if a response status code is retryable (429, 403, or 5xx).
   */
  private isRetryableStatus(status: number): boolean {
    return status === 429 || status === 403 || status >= 500;
  }

  /**
   * Sleeps for the specified number of milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
