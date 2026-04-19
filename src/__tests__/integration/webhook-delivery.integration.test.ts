/**
 * Integration test: Webhook delivery cycle.
 *
 * Tests the pipeline: event → HMAC signing → POST → retry on failure.
 *
 * Verifies the sign → verify round-trip and the dispatch flow with a
 * mocked fetch.
 *
 * **Validates: Requirements 10.4**
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WebhookService,
  sign,
  verify,
} from '../../services/webhook-service';

// ---------------------------------------------------------------------------
// Mock the database
// ---------------------------------------------------------------------------
const mockQuery = vi.fn();
vi.mock('../../db/connection', () => ({
  getPool: () => ({ query: mockQuery }),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Integration: Webhook delivery cycle', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    mockQuery.mockReset();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Sign → Verify round-trip
  // -----------------------------------------------------------------------
  describe('sign → verify round-trip', () => {
    it('should verify a payload signed with the same secret', () => {
      const payload = JSON.stringify({ event: 'keyword_match', data: { id: 'p1' } });
      const secret = 'webhook-secret-abc123';

      const signature = sign(payload, secret);
      expect(verify(payload, signature, secret)).toBe(true);
    });

    it('should reject verification with a different secret', () => {
      const payload = JSON.stringify({ event: 'keyword_match' });
      const secret = 'correct-secret';
      const wrongSecret = 'wrong-secret';

      const signature = sign(payload, secret);
      expect(verify(payload, signature, wrongSecret)).toBe(false);
    });

    it('should reject verification with a tampered payload', () => {
      const secret = 'my-secret';
      const originalPayload = JSON.stringify({ event: 'keyword_match' });
      const tamperedPayload = JSON.stringify({ event: 'theme_detected' });

      const signature = sign(originalPayload, secret);
      expect(verify(tamperedPayload, signature, secret)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Full dispatch flow
  // -----------------------------------------------------------------------
  describe('dispatch flow', () => {
    it('should sign the payload and POST to registered webhook URLs', async () => {
      const webhookSecret = 'test-webhook-secret';
      const webhookUrl = 'https://example.com/webhook';
      const payload = { keyword: 'react', contentId: 'p1' };

      // Mock DB: return one active webhook registration
      mockQuery.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('SELECT') && sql.includes('webhook_registrations')) {
          return Promise.resolve({
            rows: [{
              id: 'wh-1',
              user_id: 'user-1',
              url: webhookUrl,
              secret: webhookSecret,
              events: 'keyword_match',
              is_active: true,
              created_at: new Date(),
            }],
          });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      });

      // Mock fetch to capture the request
      let capturedUrl = '';
      let capturedHeaders: Record<string, string> = {};
      let capturedBody = '';

      globalThis.fetch = vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
        capturedUrl = url;
        capturedHeaders = Object.fromEntries(
          (options.headers as Headers)?.entries?.() ?? new Headers(options.headers as HeadersInit).entries(),
        );
        capturedBody = options.body as string;
        return { ok: true, status: 200, statusText: 'OK' };
      });

      const service = new WebhookService();
      (service as any).sleep = vi.fn().mockResolvedValue(undefined);

      await service.dispatch('keyword_match', payload);

      // Verify the POST was made to the correct URL
      expect(capturedUrl).toBe(webhookUrl);

      // Verify the payload was sent as JSON
      expect(capturedBody).toBe(JSON.stringify(payload));

      // Verify the signature header is present and valid
      const signatureHeader = capturedHeaders['x-webhook-signature'];
      expect(signatureHeader).toBeDefined();
      expect(verify(capturedBody, signatureHeader, webhookSecret)).toBe(true);

      // Verify the event header
      expect(capturedHeaders['x-webhook-event']).toBe('keyword_match');
    });

    it('should retry failed deliveries up to 3 times', async () => {
      const webhookSecret = 'retry-secret';

      // Mock DB: return one active webhook
      mockQuery.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('SELECT') && sql.includes('webhook_registrations')) {
          return Promise.resolve({
            rows: [{
              id: 'wh-retry',
              user_id: 'user-1',
              url: 'https://example.com/failing-hook',
              secret: webhookSecret,
              events: 'keyword_match',
              is_active: true,
              created_at: new Date(),
            }],
          });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      });

      // Mock fetch to always fail
      let fetchCallCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        fetchCallCount++;
        return { ok: false, status: 500, statusText: 'Internal Server Error' };
      });

      const service = new WebhookService();
      (service as any).sleep = vi.fn().mockResolvedValue(undefined);

      await service.dispatch('keyword_match', { test: true });

      // 1 initial + 3 retries = 4 total attempts
      expect(fetchCallCount).toBe(4);
    });

    it('should stop retrying after a successful delivery', async () => {
      // Mock DB: return one active webhook
      mockQuery.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('SELECT') && sql.includes('webhook_registrations')) {
          return Promise.resolve({
            rows: [{
              id: 'wh-partial',
              user_id: 'user-1',
              url: 'https://example.com/flaky-hook',
              secret: 'flaky-secret',
              events: 'keyword_match',
              is_active: true,
              created_at: new Date(),
            }],
          });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      });

      // Mock fetch: fail first, succeed second
      let fetchCallCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        fetchCallCount++;
        if (fetchCallCount === 1) {
          return { ok: false, status: 503, statusText: 'Service Unavailable' };
        }
        return { ok: true, status: 200, statusText: 'OK' };
      });

      const service = new WebhookService();
      (service as any).sleep = vi.fn().mockResolvedValue(undefined);

      await service.dispatch('keyword_match', { test: true });

      // Should stop after 2 attempts (1 fail + 1 success)
      expect(fetchCallCount).toBe(2);
    });

    it('should only dispatch to webhooks subscribed to the event type', async () => {
      // Mock DB: return webhooks with different event subscriptions
      mockQuery.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('SELECT') && sql.includes('webhook_registrations')) {
          return Promise.resolve({
            rows: [
              {
                id: 'wh-keyword',
                user_id: 'user-1',
                url: 'https://example.com/keyword-hook',
                secret: 'secret-1',
                events: 'keyword_match',
                is_active: true,
                created_at: new Date(),
              },
              {
                id: 'wh-theme',
                user_id: 'user-1',
                url: 'https://example.com/theme-hook',
                secret: 'secret-2',
                events: 'theme_detected',
                is_active: true,
                created_at: new Date(),
              },
            ],
          });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      });

      const fetchedUrls: string[] = [];
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        fetchedUrls.push(url);
        return { ok: true, status: 200, statusText: 'OK' };
      });

      const service = new WebhookService();
      (service as any).sleep = vi.fn().mockResolvedValue(undefined);

      await service.dispatch('keyword_match', { test: true });

      // Only the keyword_match webhook should receive the delivery
      expect(fetchedUrls).toEqual(['https://example.com/keyword-hook']);
    });

    it('should record delivery status in the database', async () => {
      // Mock DB
      mockQuery.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('SELECT') && sql.includes('webhook_registrations')) {
          return Promise.resolve({
            rows: [{
              id: 'wh-record',
              user_id: 'user-1',
              url: 'https://example.com/hook',
              secret: 'record-secret',
              events: 'keyword_match',
              is_active: true,
              created_at: new Date(),
            }],
          });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
      });

      const service = new WebhookService();
      (service as any).sleep = vi.fn().mockResolvedValue(undefined);

      await service.dispatch('keyword_match', { data: 'test' });

      // Verify delivery record was inserted
      const insertCalls = mockQuery.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO webhook_deliveries'),
      );
      expect(insertCalls.length).toBeGreaterThanOrEqual(1);

      // Verify final status update was made
      const updateCalls = mockQuery.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('UPDATE webhook_deliveries'),
      );
      expect(updateCalls.length).toBeGreaterThanOrEqual(1);

      // The final update should set status to 'delivered'
      const lastUpdate = updateCalls[updateCalls.length - 1];
      expect(lastUpdate[1]).toContain('delivered');
    });
  });
});
