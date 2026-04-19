/**
 * Integration test: Keyword polling cycle.
 *
 * Tests the pipeline: keyword poll → RedditScraper → match detection → notification + webhook dispatch.
 *
 * Mocks the database and ProxyManager to verify that the KeywordTrackerService
 * correctly detects new matches and that the notification/webhook services
 * are triggered for each match.
 *
 * **Validates: Requirements 3.1, 7.1**
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RedditScraper } from '../../core/reddit-scraper';
import { KeywordTrackerService } from '../../services/keyword-tracker-service';
import { NotificationService } from '../../services/notification-service';
import { WebhookService } from '../../services/webhook-service';
import type { TrackedKeyword } from '../../models/database';
import type { RawRedditListingResponse } from '../../models/reddit';

// ---------------------------------------------------------------------------
// Mock the database
// ---------------------------------------------------------------------------
const mockQuery = vi.fn();
vi.mock('../../db/connection', () => ({
  getPool: () => ({ query: mockQuery }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRedditListing(posts: Array<Record<string, unknown>>): RawRedditListingResponse {
  return {
    kind: 'Listing',
    data: {
      children: posts.map((p) => ({ kind: 't3', data: p })),
      after: null,
      before: null,
    },
  };
}

function makePost(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'post1',
    subreddit: 'webdev',
    author: 'dev_user',
    title: 'Using React with TypeScript',
    selftext: 'Here is how to set up React with TypeScript.',
    url: 'https://reddit.com/r/webdev/comments/post1/',
    domain: 'self.webdev',
    permalink: '/r/webdev/comments/post1/',
    score: 25,
    num_comments: 5,
    is_self: true,
    link_flair_text: null,
    created_utc: Date.now() / 1000 - 600,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Integration: Keyword polling cycle', () => {
  let scraper: RedditScraper;
  let keywordService: KeywordTrackerService;
  let mockFetch: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  const trackedKeyword: TrackedKeyword = {
    id: 'kw-123',
    user_id: 'user-456',
    keyword: 'react',
    is_active: true,
    notifications_enabled: true,
    last_match_at: null,
    created_at: new Date(),
  };

  beforeEach(() => {
    mockQuery.mockReset();
    originalFetch = globalThis.fetch;

    // Create a mock ProxyManager
    mockFetch = vi.fn();
    const mockProxyManager = {
      fetch: mockFetch,
      getAgent: () => undefined,
      isProxyConfigured: () => false,
    };
    const mockRateLimiter = {
      acquire: vi.fn().mockResolvedValue(undefined),
      getQueueLength: () => 0,
    };

    scraper = new RedditScraper({
      userAgent: 'test-agent',
      proxyManager: mockProxyManager as any,
      rateLimiter: mockRateLimiter as any,
    });

    keywordService = new KeywordTrackerService(scraper);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('should detect new keyword matches from Reddit search results', async () => {
    const cannedPosts = [
      makePost({ id: 'p1', title: 'React hooks tutorial', selftext: 'Learn react hooks' }),
      makePost({ id: 'p2', title: 'Vue vs Angular', selftext: 'Comparing frameworks' }),
      makePost({ id: 'p3', title: 'Advanced React patterns', selftext: '' }),
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => buildRedditListing(cannedPosts),
    });

    // Mock DB: no existing matches for any post
    mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('SELECT id FROM keyword_matches')) {
        return Promise.resolve({ rows: [] }); // No existing match
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO reddit_posts')) {
        return Promise.resolve({ rowCount: 1 });
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO keyword_matches')) {
        return Promise.resolve({ rowCount: 1 });
      }
      if (typeof sql === 'string' && sql.includes('SELECT id, count FROM keyword_frequencies')) {
        return Promise.resolve({ rows: [] }); // No existing frequency
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO keyword_frequencies')) {
        return Promise.resolve({ rowCount: 1 });
      }
      if (typeof sql === 'string' && sql.includes('UPDATE tracked_keywords')) {
        return Promise.resolve({ rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const newMatches = await keywordService.pollKeyword(trackedKeyword);

    // p1 and p3 contain "react", p2 does not
    expect(newMatches).toHaveLength(2);
    expect(newMatches[0].data.id).toBe('p1');
    expect(newMatches[1].data.id).toBe('p3');
  });

  it('should skip already-tracked matches', async () => {
    const cannedPosts = [
      makePost({ id: 'p1', title: 'React hooks', selftext: '' }),
      makePost({ id: 'p2', title: 'React patterns', selftext: '' }),
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => buildRedditListing(cannedPosts),
    });

    // p1 already exists in keyword_matches, p2 does not
    mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('SELECT id FROM keyword_matches')) {
        const contentId = (params as unknown[])?.[1];
        if (contentId === 'p1') {
          return Promise.resolve({ rows: [{ id: 'existing-match' }] });
        }
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const newMatches = await keywordService.pollKeyword(trackedKeyword);

    // Only p2 should be a new match
    expect(newMatches).toHaveLength(1);
    expect(newMatches[0].data.id).toBe('p2');
  });

  it('should trigger notification and webhook dispatch for new matches', async () => {
    // This test verifies the full cycle: poll → match → notify + webhook
    const cannedPosts = [
      makePost({ id: 'p1', title: 'React tutorial', selftext: 'Learn react', permalink: '/r/webdev/comments/p1/' }),
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => buildRedditListing(cannedPosts),
    });

    // Mock DB for keyword polling
    mockQuery.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('SELECT id FROM keyword_matches')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    // Poll for matches
    const newMatches = await keywordService.pollKeyword(trackedKeyword);
    expect(newMatches).toHaveLength(1);

    // Now simulate what the keyword polling job does: send notification + dispatch webhook
    // Reset mock for notification/webhook DB calls
    mockQuery.mockReset();
    mockQuery.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('SELECT') && sql.includes('notification_preferences')) {
        return Promise.resolve({ rows: [] }); // Default prefs (in_app)
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO notifications')) {
        return Promise.resolve({ rowCount: 1 });
      }
      if (typeof sql === 'string' && sql.includes('UPDATE notifications')) {
        return Promise.resolve({ rowCount: 1 });
      }
      if (typeof sql === 'string' && sql.includes('SELECT') && sql.includes('webhook_registrations')) {
        return Promise.resolve({ rows: [] }); // No webhooks registered
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const notificationService = new NotificationService();
    const webhookService = new WebhookService();

    // Send notification for the match
    const match = newMatches[0];
    await notificationService.sendNotification(trackedKeyword.user_id, {
      keywordId: trackedKeyword.id,
      contentId: match.data.id,
      contentType: match.content_type,
      permalink: match.data.permalink,
    });

    // Verify notification was created
    const notifInserts = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO notifications'),
    );
    expect(notifInserts.length).toBeGreaterThanOrEqual(1);

    // Verify permalink is included in the notification
    const notifParams = notifInserts[0][1] as unknown[];
    expect(notifParams).toContain('/r/webdev/comments/p1/');

    // Dispatch webhook event
    await webhookService.dispatch('keyword_match', {
      keyword: trackedKeyword.keyword,
      keywordId: trackedKeyword.id,
      contentId: match.data.id,
    });

    // Verify webhook dispatch queried for active registrations
    const webhookQueries = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('webhook_registrations'),
    );
    expect(webhookQueries.length).toBeGreaterThanOrEqual(1);
  });

  it('should return empty matches when no posts contain the keyword', async () => {
    const cannedPosts = [
      makePost({ id: 'p1', title: 'Vue tutorial', selftext: 'Learn Vue.js' }),
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => buildRedditListing(cannedPosts),
    });

    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const newMatches = await keywordService.pollKeyword(trackedKeyword);

    // "react" keyword not found in any post
    expect(newMatches).toHaveLength(0);
  });
});
