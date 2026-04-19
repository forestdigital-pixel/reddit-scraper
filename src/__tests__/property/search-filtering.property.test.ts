import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { RedditScraper } from '../../core/reddit-scraper';
import type { ProxyManager } from '../../core/proxy-manager';
import type { RateLimiter } from '../../core/rate-limiter';
import type { SearchParams, RedditPost } from '../../models/reddit';
import { filterPosts } from '../../services/search-service';

/**
 * Property-based tests for RedditScraper search URL construction
 * and client-side exclusion filtering.
 *
 * Feature: reddit-data-scraper
 */

// Minimal mock ProxyManager — we only test URL construction, no HTTP requests
const mockProxyManager = {} as ProxyManager;
const mockRateLimiter = {} as RateLimiter;

const scraper = new RedditScraper({
  userAgent: 'test-agent',
  proxyManager: mockProxyManager,
  rateLimiter: mockRateLimiter,
});

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const sortArb = fc.constantFrom(
  'relevance' as const,
  'new' as const,
  'hot' as const,
  'top' as const,
  'comments' as const,
);

const timeframeArb = fc.constantFrom(
  'hour' as const,
  'day' as const,
  'week' as const,
  'month' as const,
  'year' as const,
  'all' as const,
);

/** Non-empty alphanumeric string suitable for a Reddit query */
const queryArb = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789 '.split('')), {
    minLength: 1,
    maxLength: 60,
  })
  .map((chars) => chars.join(''))
  .filter((s) => s.trim().length > 0);

/** Subreddit name: alphanumeric + underscores, 3-21 chars (Reddit rules) */
const subredditArb = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_'.split('')), {
    minLength: 3,
    maxLength: 21,
  })
  .map((chars) => chars.join(''));

/** After token: Reddit fullname format t3_<base36id> */
const afterTokenArb = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
    minLength: 4,
    maxLength: 10,
  })
  .map((chars) => `t3_${chars.join('')}`);

/** Limit between 1 and 100 */
const limitArb = fc.integer({ min: 1, max: 100 });

/** Full SearchParams arbitrary */
const searchParamsArb: fc.Arbitrary<SearchParams> = fc.record(
  {
    query: queryArb,
    subreddit: fc.option(subredditArb, { nil: undefined }),
    sort: fc.option(sortArb, { nil: undefined }),
    timeframe: fc.option(timeframeArb, { nil: undefined }),
    restrictSr: fc.option(fc.boolean(), { nil: undefined }),
    pagination: fc.option(
      fc.record(
        {
          after: fc.option(afterTokenArb, { nil: undefined }),
          limit: fc.option(limitArb, { nil: undefined }),
        },
        { requiredKeys: [] },
      ),
      { nil: undefined },
    ),
  },
  { requiredKeys: ['query'] },
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Search Filtering Property Tests', () => {
  /**
   * Property 1: Search URL construction preserves all parameters
   *
   * For any valid combination of search parameters (query, subreddit, sort,
   * timeframe, after token), the URL constructed by RedditScraper should
   * contain each specified parameter as the correct query parameter or path
   * segment.
   *
   * **Validates: Requirements 1.2, 1.3, 1.6, 1.8**
   */
  describe('Property 1: Search URL construction preserves all parameters', () => {
    it('constructed URL contains every specified search parameter', () => {
      fc.assert(
        fc.property(searchParamsArb, (params: SearchParams) => {
          const url = scraper.buildSearchUrl(params);
          const parsed = new URL(url);

          // 1. Query parameter is always present
          expect(parsed.searchParams.get('q')).toBe(params.query);

          // 2. Subreddit filter → path segment /r/{subreddit}/search.json
          if (params.subreddit) {
            expect(parsed.pathname).toContain(
              `/r/${encodeURIComponent(params.subreddit)}/search.json`,
            );
          } else {
            expect(parsed.pathname).toBe('/search.json');
          }

          // 3. Sort parameter
          if (params.sort) {
            expect(parsed.searchParams.get('sort')).toBe(params.sort);
          }

          // 4. Timeframe parameter (mapped to `t`)
          if (params.timeframe) {
            expect(parsed.searchParams.get('t')).toBe(params.timeframe);
          }

          // 5. restrict_sr parameter
          if (params.restrictSr !== undefined) {
            expect(parsed.searchParams.get('restrict_sr')).toBe(
              params.restrictSr ? 'true' : 'false',
            );
          }

          // 6. After token for pagination
          if (params.pagination?.after) {
            expect(parsed.searchParams.get('after')).toBe(params.pagination.after);
          }

          // 7. Limit is present and capped at 100
          const expectedLimit = params.pagination?.limit
            ? Math.min(params.pagination.limit, 100)
            : 100;
          expect(parsed.searchParams.get('limit')).toBe(String(expectedLimit));

          // 8. raw_json=1 is always present
          expect(parsed.searchParams.get('raw_json')).toBe('1');
        }),
        { numRuns: 100 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Property 2: Client-side exclusion filtering
  // -------------------------------------------------------------------------

  /**
   * Property 2: Client-side exclusion filtering removes all matching content
   *
   * For any set of Reddit posts and any set of excluded keywords and excluded
   * users, the filtered result should contain no posts whose title or body
   * contains any excluded keyword, and no posts authored by any excluded user.
   *
   * **Validates: Requirements 1.4, 1.5**
   */
  describe('Property 2: Client-side exclusion filtering removes all matching content', () => {
    // -- Arbitraries for RedditPost generation --

    /** Alphanumeric string with spaces, suitable for text fields */
    const textArb = fc
      .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 '.split('')), {
        minLength: 0,
        maxLength: 80,
      })
      .map((chars) => chars.join(''));

    /** Non-empty alphanumeric string for author names */
    const authorArb = fc
      .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')), {
        minLength: 1,
        maxLength: 20,
      })
      .map((chars) => chars.join(''));

    /** Non-empty keyword (at least 1 char, no leading/trailing spaces) */
    const keywordArb = fc
      .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), {
        minLength: 1,
        maxLength: 15,
      })
      .map((chars) => chars.join(''));

    /** Generate a minimal RedditPost with random text fields */
    const redditPostArb: fc.Arbitrary<RedditPost> = fc.record({
      id: fc.uuid().map((u) => u.slice(0, 8)),
      subreddit: fc.constant('testsubreddit'),
      author: authorArb,
      title: textArb,
      selftext: textArb,
      url: fc.constant('https://reddit.com/r/test/1'),
      domain: fc.constant('self.testsubreddit'),
      permalink: fc.constant('/r/test/comments/1/test/'),
      score: fc.integer({ min: 0, max: 10000 }),
      num_comments: fc.integer({ min: 0, max: 5000 }),
      is_self: fc.boolean(),
      link_flair_text: fc.constant(null),
      created_utc: fc.integer({ min: 1600000000, max: 1700000000 }),
    });

    const postsArb = fc.array(redditPostArb, { minLength: 0, maxLength: 30 });
    const excludeKeywordsArb = fc.array(keywordArb, { minLength: 0, maxLength: 5 });
    const excludeUsersArb = fc.array(authorArb, { minLength: 0, maxLength: 5 });

    it('no remaining post contains any excluded keyword in title or selftext (case-insensitive)', () => {
      fc.assert(
        fc.property(postsArb, excludeKeywordsArb, (posts, excludeKeywords) => {
          const result = filterPosts(posts, excludeKeywords, []);

          for (const post of result) {
            const titleLower = post.title.toLowerCase();
            const selftextLower = post.selftext.toLowerCase();
            for (const keyword of excludeKeywords) {
              if (keyword.length === 0) continue;
              const kw = keyword.toLowerCase();
              expect(titleLower).not.toContain(kw);
              expect(selftextLower).not.toContain(kw);
            }
          }
        }),
        { numRuns: 100 },
      );
    });

    it('no remaining post is authored by any excluded user (case-insensitive)', () => {
      fc.assert(
        fc.property(postsArb, excludeUsersArb, (posts, excludeUsers) => {
          const result = filterPosts(posts, [], excludeUsers);

          const lowerExcludedUsers = excludeUsers.map((u) => u.toLowerCase());
          for (const post of result) {
            expect(lowerExcludedUsers).not.toContain(post.author.toLowerCase());
          }
        }),
        { numRuns: 100 },
      );
    });

    it('all posts that should NOT be filtered are still present', () => {
      fc.assert(
        fc.property(postsArb, excludeKeywordsArb, excludeUsersArb, (posts, excludeKeywords, excludeUsers) => {
          const result = filterPosts(posts, excludeKeywords, excludeUsers);

          const lowerKeywords = excludeKeywords.map((k) => k.toLowerCase()).filter((k) => k.length > 0);
          const lowerUsers = excludeUsers.map((u) => u.toLowerCase());

          // Determine which posts should survive filtering
          const expectedSurvivors = posts.filter((post) => {
            const authorLower = post.author.toLowerCase();
            if (lowerUsers.includes(authorLower)) return false;

            const titleLower = post.title.toLowerCase();
            const selftextLower = post.selftext.toLowerCase();
            for (const kw of lowerKeywords) {
              if (titleLower.includes(kw) || selftextLower.includes(kw)) return false;
            }
            return true;
          });

          // The result should contain exactly the expected survivors, in order
          expect(result).toHaveLength(expectedSurvivors.length);
          for (let i = 0; i < result.length; i++) {
            expect(result[i].id).toBe(expectedSurvivors[i].id);
          }
        }),
        { numRuns: 100 },
      );
    });
  });
});
