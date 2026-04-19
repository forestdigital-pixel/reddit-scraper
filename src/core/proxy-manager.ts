import http from 'node:http';
import https from 'node:https';
import { RateLimiter } from './rate-limiter.js';

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
 * Minimal Response-like object returned by ProxyManager.fetch().
 */
export interface ProxyResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/**
 * Routes all outbound HTTP requests through a rotating proxy with retry logic,
 * rate limiting, and custom User-Agent headers.
 *
 * Uses node:http/node:https with https-proxy-agent for proper proxy support
 * (Node.js native fetch/undici does not support the agent option).
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.5, 9.6, 9.7
 */
export class ProxyManager {
  private agent: http.Agent | https.Agent | undefined;
  private agentReady: Promise<void> | undefined;
  private readonly rateLimiter: RateLimiter;
  private readonly config: ProxyConfig;

  constructor(config: ProxyConfig) {
    this.config = config;
    this.rateLimiter = new RateLimiter(config.rateLimitMs);

    if (config.proxyUrl) {
      this.agentReady = this.initProxyAgent(config.proxyUrl);
    } else {
      this.agent = undefined;
      this.agentReady = undefined;
      console.warn(
        `[${new Date().toISOString()}] ProxyManager: No proxy configured. ` +
        `Falling back to direct connections. Requests may be rate-limited by Reddit.`
      );
    }
  }

  private async initProxyAgent(proxyUrl: string): Promise<void> {
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    this.agent = new HttpsProxyAgent(proxyUrl) as unknown as https.Agent;
  }

  /**
   * Fetches a URL through the proxy (or directly), with rate limiting and retry logic.
   */
  async fetch(url: string, _options?: RequestInit): Promise<ProxyResponse> {
    if (this.agentReady) {
      await this.agentReady;
    }

    const maxRetries = this.config.maxRetries;
    const baseDelay = 2000;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = baseDelay * Math.pow(4, attempt - 1);
        await this.sleep(delay);
      }

      await this.rateLimiter.acquire();

      try {
        const response = await this.makeRequest(url);

        if (this.isRetryableStatus(response.status)) {
          console.error(
            `[${new Date().toISOString()}] ProxyManager: Request failed - ` +
            `URL: ${url}, Status: ${response.status}, Attempt: ${attempt + 1}/${maxRetries + 1}`
          );
          if (attempt < maxRetries) continue;
          return response;
        }

        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.error(
          `[${new Date().toISOString()}] ProxyManager: Request error - ` +
          `URL: ${url}, Error: ${lastError.message}, Attempt: ${attempt + 1}/${maxRetries + 1}`
        );
        if (attempt >= maxRetries) throw lastError;
      }
    }

    throw lastError ?? new Error('ProxyManager: fetch failed');
  }

  /**
   * Makes an HTTP/HTTPS request using node:http/node:https with the proxy agent.
   */
  private makeRequest(url: string): Promise<ProxyResponse> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;

      const options: https.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          'User-Agent': this.config.userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'identity',
          'Connection': 'keep-alive',
          'Cache-Control': 'no-cache',
        },
        timeout: 30000,
      };

      if (this.agent) {
        options.agent = this.agent;
      }

      const req = lib.request(options, (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          const status = res.statusCode ?? 0;

          const responseHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (value) responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
          }

          resolve({
            ok: status >= 200 && status < 300,
            status,
            statusText: res.statusMessage ?? '',
            headers: responseHeaders,
            json: async () => JSON.parse(body),
            text: async () => body,
          });
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timeout after 30s: ${url}`));
      });

      req.end();
    });
  }

  getAgent(): http.Agent | https.Agent | undefined {
    return this.agent;
  }

  isProxyConfigured(): boolean {
    return this.config.proxyUrl !== undefined && this.config.proxyUrl !== '';
  }

  private isRetryableStatus(status: number): boolean {
    return status === 429 || status === 403 || status >= 500;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
