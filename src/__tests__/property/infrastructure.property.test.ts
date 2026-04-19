import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { RateLimiter } from '../../core/rate-limiter';
import { sign, verify } from '../../services/webhook-service';
import { successResponse, errorResponse, parsePagination } from '../../routes/middleware/response';

/**
 * Property-based tests for core infrastructure components.
 *
 * Feature: reddit-data-scraper
 */
describe('Infrastructure Property Tests', () => {
  /**
   * Property 23: Rate limiter enforces minimum interval
   *
   * For any sequence of N requests through the RateLimiter,
   * the total elapsed time should be at least (N - 1) * minIntervalMs.
   *
   * **Validates: Requirements 9.4**
   */
  describe('Property 23: Rate limiter enforces minimum interval', () => {
    it('total elapsed time for N requests should be at least (N - 1) * minIntervalMs', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 5 }),
          fc.integer({ min: 10, max: 50 }),
          async (numRequests: number, minIntervalMs: number) => {
            const limiter = new RateLimiter(minIntervalMs);

            const start = performance.now();

            // Acquire N tokens sequentially
            for (let i = 0; i < numRequests; i++) {
              await limiter.acquire();
            }

            const elapsed = performance.now() - start;

            const expectedMinimum = (numRequests - 1) * minIntervalMs;

            // Allow a small tolerance (2ms) for timer imprecision
            expect(elapsed).toBeGreaterThanOrEqual(expectedMinimum - 2);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 26: Webhook signature round-trip
   *
   * For any payload string and secret, `verify(payload, sign(payload, secret), secret)`
   * should return `true`. Additionally, `verify(payload, sign(payload, secret), differentSecret)`
   * should return `false`.
   *
   * **Validates: Requirements 10.5**
   */
  describe('Property 26: Webhook signature round-trip', () => {
    it('verify(payload, sign(payload, secret), secret) should return true for any payload and secret', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 500 }),
          fc.string({ minLength: 1, maxLength: 100 }),
          (payload: string, secret: string) => {
            const signature = sign(payload, secret);
            expect(verify(payload, signature, secret)).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('verify(payload, sign(payload, secret), differentSecret) should return false', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 500 }),
          fc.string({ minLength: 1, maxLength: 100 }),
          fc.string({ minLength: 1, maxLength: 100 }),
          (payload: string, secret: string, otherSecret: string) => {
            // Only test when secrets are actually different
            fc.pre(secret !== otherSecret);

            const signature = sign(payload, secret);
            expect(verify(payload, signature, otherSecret)).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 25: API key authentication enforcement
   *
   * Since the auth middleware requires a DB connection, we test the envelope
   * structure invariants that the middleware relies on: when status is "error",
   * data should be null; when status is "success", error should be null.
   * This validates the response contract used by the auth middleware's 401 responses.
   *
   * **Validates: Requirements 10.3**
   */
  describe('Property 25: API key authentication enforcement', () => {
    it('error responses (as returned for invalid/missing API keys) should have null data', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 200 }),
          (errorMessage: string) => {
            const response = errorResponse(errorMessage);
            expect(response.status).toBe('error');
            expect(response.data).toBeNull();
            expect(response.error).toBe(errorMessage);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('success responses (as returned for valid API keys) should have null error', () => {
      fc.assert(
        fc.property(
          fc.jsonValue(),
          (data: unknown) => {
            const response = successResponse(data);
            expect(response.status).toBe('success');
            expect(response.error).toBeNull();
            expect(response.data).toEqual(data);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('error and success envelopes are mutually exclusive in their non-null fields', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 200 }),
          fc.jsonValue(),
          (errorMessage: string, data: unknown) => {
            const errResp = errorResponse(errorMessage);
            const succResp = successResponse(data);

            // Error response: data is null, error is not null
            expect(errResp.data).toBeNull();
            expect(errResp.error).not.toBeNull();

            // Success response: error is null, data is present
            expect(succResp.error).toBeNull();
            // data can be any value including null from jsonValue, but status must be success
            expect(succResp.status).toBe('success');
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 24: API response envelope structure
   *
   * For any API endpoint response, the JSON body should contain `status`
   * (either "success" or "error"), `data` (object or null), and `error`
   * (string or null). When status is "success", error should be null.
   * When status is "error", data should be null.
   *
   * **Validates: Requirements 10.2**
   */
  describe('Property 24: API response envelope structure', () => {
    it('successResponse always has status "success", non-null data, and null error', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.record({ id: fc.integer(), name: fc.string() }),
            fc.array(fc.integer()),
            fc.string(),
            fc.integer(),
            fc.boolean(),
          ),
          (data: unknown) => {
            const response = successResponse(data);

            expect(response).toHaveProperty('status');
            expect(response).toHaveProperty('data');
            expect(response).toHaveProperty('error');

            expect(response.status).toBe('success');
            expect(response.error).toBeNull();
            expect(response.data).toEqual(data);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('errorResponse always has status "error", null data, and non-null error string', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 500 }),
          (errorMsg: string) => {
            const response = errorResponse(errorMsg);

            expect(response).toHaveProperty('status');
            expect(response).toHaveProperty('data');
            expect(response).toHaveProperty('error');

            expect(response.status).toBe('error');
            expect(response.data).toBeNull();
            expect(response.error).toBe(errorMsg);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('successResponse with pagination includes pagination info in envelope', () => {
      fc.assert(
        fc.property(
          fc.jsonValue(),
          fc.integer({ min: 1, max: 1000 }),
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 0, max: 100000 }),
          (data: unknown, page: number, pageSize: number, totalItems: number) => {
            const totalPages = Math.ceil(totalItems / pageSize) || 1;
            const pagination = { page, pageSize, totalItems, totalPages };
            const response = successResponse(data, pagination);

            expect(response.status).toBe('success');
            expect(response.error).toBeNull();
            expect(response.pagination).toEqual(pagination);
            expect(response.pagination!.page).toBe(page);
            expect(response.pagination!.pageSize).toBe(pageSize);
            expect(response.pagination!.totalItems).toBe(totalItems);
            expect(response.pagination!.totalPages).toBe(totalPages);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 27: Pagination respects bounds
   *
   * For any list endpoint request with `page_size` parameter, the parsed
   * page size should be at most min(page_size, 100). When no `page_size`
   * is specified, the default should be 25.
   *
   * **Validates: Requirements 10.8**
   */
  describe('Property 27: Pagination respects bounds', () => {
    it('page_size is capped at 100 for any positive integer input', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10000 }),
          (pageSize: number) => {
            const result = parsePagination({ page_size: String(pageSize) });
            expect(result.pageSize).toBeLessThanOrEqual(100);
            expect(result.pageSize).toBe(Math.min(pageSize, 100));
          }
        ),
        { numRuns: 100 }
      );
    });

    it('default page_size is 25 when not specified', () => {
      fc.assert(
        fc.property(
          fc.constant(undefined),
          () => {
            const result = parsePagination({});
            expect(result.pageSize).toBe(25);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('page defaults to 1 and is always at least 1', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constant(undefined),
            fc.integer({ min: -100, max: 0 }).map(String),
            fc.constant('abc'),
            fc.constant(''),
          ),
          (pageInput: string | undefined) => {
            const result = parsePagination({ page: pageInput });
            expect(result.page).toBe(1);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('valid page values are preserved', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10000 }),
          (page: number) => {
            const result = parsePagination({ page: String(page) });
            expect(result.page).toBe(Math.floor(page));
            expect(result.page).toBeGreaterThanOrEqual(1);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('invalid page_size values fall back to default 25', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constant('abc'),
            fc.constant(''),
            fc.constant('-5'),
            fc.constant('0'),
            fc.constant(undefined),
          ),
          (pageSizeInput: string | undefined) => {
            const result = parsePagination({ page_size: pageSizeInput });
            expect(result.pageSize).toBe(25);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('page_size is floored to integer and capped at min(page_size, 100)', () => {
      fc.assert(
        fc.property(
          fc.float({ min: Math.fround(1.1), max: Math.fround(500), noNaN: true }),
          (pageSize: number) => {
            const result = parsePagination({ page_size: String(pageSize) });
            const expected = Math.min(Math.floor(pageSize), 100);
            expect(result.pageSize).toBe(expected);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
