import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { sign, verify, isValidWebhookUrl } from '../../services/webhook-service';

// Mock the database connection module for dispatch tests
const mockQuery = vi.fn();
vi.mock('../../db/connection', () => ({
  getPool: () => ({ query: mockQuery }),
}));

/**
 * Unit tests for WebhookService pure helper functions.
 *
 * Tests HMAC-SHA256 signing with known test vectors, URL validation,
 * and retry exhaustion behavior.
 *
 * Requirements: 10.4, 10.5, 10.6
 */
describe('WebhookService', () => {
  // -----------------------------------------------------------------------
  // HMAC-SHA256 signing — known test vectors (Requirement 10.5)
  // -----------------------------------------------------------------------
  describe('sign()', () => {
    it('should produce a valid HMAC-SHA256 hex digest', () => {
      const payload = 'hello world';
      const secret = 'my-secret-key';

      // Compute expected value independently
      const expected = createHmac('sha256', secret)
        .update(payload)
        .digest('hex');

      expect(sign(payload, secret)).toBe(expected);
    });

    it('should produce correct HMAC-SHA256 for empty payload', () => {
      const payload = '';
      const secret = 'secret';

      const expected = createHmac('sha256', secret)
        .update(payload)
        .digest('hex');

      expect(sign(payload, secret)).toBe(expected);
    });

    it('should produce different signatures for different secrets', () => {
      const payload = '{"event":"keyword_match"}';
      const sig1 = sign(payload, 'secret-a');
      const sig2 = sign(payload, 'secret-b');

      expect(sig1).not.toBe(sig2);
    });

    it('should produce different signatures for different payloads', () => {
      const secret = 'shared-secret';
      const sig1 = sign('payload-one', secret);
      const sig2 = sign('payload-two', secret);

      expect(sig1).not.toBe(sig2);
    });

    it('should return a 64-character hex string (SHA-256 output)', () => {
      const result = sign('test', 'key');
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // -----------------------------------------------------------------------
  // HMAC-SHA256 verification (Requirement 10.5)
  // -----------------------------------------------------------------------
  describe('verify()', () => {
    it('should return true for a valid signature', () => {
      const payload = '{"data":"test"}';
      const secret = 'webhook-secret';
      const signature = sign(payload, secret);

      expect(verify(payload, signature, secret)).toBe(true);
    });

    it('should return false for a wrong secret', () => {
      const payload = '{"data":"test"}';
      const signature = sign(payload, 'correct-secret');

      expect(verify(payload, signature, 'wrong-secret')).toBe(false);
    });

    it('should return false for a tampered payload', () => {
      const secret = 'my-secret';
      const signature = sign('original-payload', secret);

      expect(verify('tampered-payload', signature, secret)).toBe(false);
    });

    it('should return false for a completely invalid signature', () => {
      expect(verify('payload', 'not-a-valid-hex-sig', 'secret')).toBe(false);
    });

    it('should return false when signature length differs from expected', () => {
      // A truncated signature should fail the length check
      const payload = 'test';
      const secret = 'key';
      const validSig = sign(payload, secret);
      const truncated = validSig.slice(0, 32);

      expect(verify(payload, truncated, secret)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // URL validation (Requirement 10.4)
  // -----------------------------------------------------------------------
  describe('isValidWebhookUrl()', () => {
    it('should accept https:// URLs', () => {
      expect(isValidWebhookUrl('https://example.com/webhook')).toBe(true);
    });

    it('should accept http:// URLs', () => {
      expect(isValidWebhookUrl('http://localhost:3000/hook')).toBe(true);
    });

    it('should reject ftp:// URLs', () => {
      expect(isValidWebhookUrl('ftp://example.com/file')).toBe(false);
    });

    it('should reject empty strings', () => {
      expect(isValidWebhookUrl('')).toBe(false);
    });

    it('should reject URLs without a scheme', () => {
      expect(isValidWebhookUrl('example.com/webhook')).toBe(false);
    });

    it('should reject javascript: protocol', () => {
      expect(isValidWebhookUrl('javascript:alert(1)')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Retry exhaustion behavior (Requirement 10.6)
  // -----------------------------------------------------------------------
  describe('dispatch() retry exhaustion', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      mockQuery.mockReset();
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it('should attempt delivery up to 4 times (1 initial + 3 retries) then fail', async () => {
      const { WebhookService } = await import('../../services/webhook-service');

      // Track fetch call count
      let fetchCallCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        fetchCallCount++;
        return Promise.reject(new Error('Network error'));
      });

      // Mock DB: first call returns active webhooks, rest succeed
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            id: 'wh-1',
            user_id: 'user-1',
            url: 'https://example.com/hook',
            secret: 'test-secret',
            events: 'keyword_match',
            is_active: true,
            created_at: new Date(),
          }],
        })
        .mockResolvedValue({ rowCount: 1 });

      const service = new WebhookService();

      // Override sleep to avoid real delays
      (service as any).sleep = vi.fn().mockResolvedValue(undefined);

      await service.dispatch('keyword_match', { test: true });

      // 1 initial attempt + 3 retries = 4 total fetch calls
      expect(fetchCallCount).toBe(4);
    });
  });
});
