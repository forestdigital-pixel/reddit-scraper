/**
 * Integration test: Subreddit snapshot recording and growth metric computation.
 *
 * Tests the pipeline: fetch subreddit about → record snapshot → compute growth metrics.
 *
 * Mocks the database and ProxyManager to verify that snapshots are recorded
 * correctly and growth metrics are computed from snapshot comparisons.
 *
 * **Validates: Requirements 5.6**
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedditScraper } from '../../core/reddit-scraper';
import {
  SubredditAnalyzerService,
  computeGrowthMetrics,
  computeEngagementMetrics,
} from '../../services/subreddit-analyzer-service';
import type { RedditPost } from '../../models/reddit';
import type {
  RawRedditListingResponse,
  RawSubredditAboutResponse,
} from '../../models/reddit';

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

function buildSubredditAbout(overrides: Partial<Record<string, unknown>> = {}): RawSubredditAboutResponse {
  return {
    kind: 't5',
    data: {
      display_name: 'typescript',
      title: 'TypeScript',
      description: 'A subreddit for TypeScript discussion',
      subscribers: 250000,
      accounts_active: 1200,
      created_utc: 1400000000,
      public_description: 'TypeScript community',
      over18: false,
      ...overrides,
    },
  };
}

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
    subreddit: 'typescript',
    author: 'dev_user',
    title: 'TypeScript tips',
    selftext: 'Some tips about TypeScript.',
    url: 'https://reddit.com/r/typescript/comments/post1/',
    domain: 'self.typescript',
    permalink: '/r/typescript/comments/post1/',
    score: 30,
    num_comments: 8,
    is_self: true,
    link_flair_text: null,
    created_utc: Date.now() / 1000 - 86400, // 1 day ago
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Integration: Subreddit snapshot and growth metrics', () => {
  let scraper: RedditScraper;
  let subredditService: SubredditAnalyzerService;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockQuery.mockReset();

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

    subredditService = new SubredditAnalyzerService(scraper);
  });

  it('should record a snapshot with current subscriber and active user counts', async () => {
    const aboutData = buildSubredditAbout({
      subscribers: 250000,
      accounts_active: 1200,
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => aboutData,
    });

    // Mock DB: snapshot insert
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

    await subredditService.recordSnapshot('typescript');

    // Verify snapshot was inserted
    const insertCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO subreddit_snapshots'),
    );
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0][1]).toContain('typescript');
    expect(insertCalls[0][1]).toContain(250000);
    expect(insertCalls[0][1]).toContain(1200);
  });

  it('should compute growth metrics by comparing current and previous snapshots', () => {
    const currentSnapshot = { subscribers: 250000, snapshotDate: new Date() };
    const previousSnapshot = { subscribers: 245000 };

    // Create posts spread over the last 30 days
    const now = Date.now() / 1000;
    const posts: RedditPost[] = Array.from({ length: 60 }, (_, i) => ({
      id: `p${i}`,
      subreddit: 'typescript',
      author: 'user',
      title: `Post ${i}`,
      selftext: '',
      url: '',
      domain: '',
      permalink: '',
      score: 10,
      num_comments: 2,
      is_self: true,
      link_flair_text: null,
      created_utc: now - (i * 12 * 3600), // every 12 hours
    }));

    const growth = computeGrowthMetrics(currentSnapshot, previousSnapshot, posts);

    expect(growth.currentSubscribers).toBe(250000);
    expect(growth.previousSubscribers).toBe(245000);
    expect(growth.subscriberChange).toBe(5000);
    expect(growth.avgPostsPerDay).toBe(60 / 30); // 2 posts per day
  });

  it('should handle first snapshot with no previous data', () => {
    const currentSnapshot = { subscribers: 100000, snapshotDate: new Date() };

    const growth = computeGrowthMetrics(currentSnapshot, null, []);

    expect(growth.currentSubscribers).toBe(100000);
    expect(growth.previousSubscribers).toBeNull();
    expect(growth.subscriberChange).toBeNull();
    expect(growth.avgPostsPerDay).toBe(0);
  });

  it('should compute engagement metrics from post data', () => {
    const posts: RedditPost[] = [
      { id: 'p1', subreddit: 'ts', author: 'a', title: '', selftext: '', url: '', domain: '', permalink: '', score: 100, num_comments: 20, is_self: true, link_flair_text: null, created_utc: 0 },
      { id: 'p2', subreddit: 'ts', author: 'b', title: '', selftext: '', url: '', domain: '', permalink: '', score: 50, num_comments: 10, is_self: true, link_flair_text: null, created_utc: 0 },
      { id: 'p3', subreddit: 'ts', author: 'c', title: '', selftext: '', url: '', domain: '', permalink: '', score: 150, num_comments: 30, is_self: true, link_flair_text: null, created_utc: 0 },
    ];

    const engagement = computeEngagementMetrics(posts);

    expect(engagement.avgScorePerPost).toBe(100); // (100+50+150)/3
    expect(engagement.avgCommentsPerPost).toBe(20); // (20+10+30)/3
    expect(engagement.periodDays).toBe(30);
  });

  it('should handle empty post list for engagement metrics', () => {
    const engagement = computeEngagementMetrics([]);

    expect(engagement.avgScorePerPost).toBe(0);
    expect(engagement.avgCommentsPerPost).toBe(0);
  });

  it('should compute full stats through the service pipeline', async () => {
    const aboutData = buildSubredditAbout({
      display_name: 'typescript',
      subscribers: 250000,
      accounts_active: 1200,
    });

    const now = Date.now() / 1000;
    const cannedPosts = [
      makePost({ id: 'p1', score: 100, num_comments: 20, created_utc: now - 3600, is_self: true }),
      makePost({ id: 'p2', score: 50, num_comments: 10, created_utc: now - 7200, is_self: false, url: 'https://example.com/article', domain: 'example.com' }),
      makePost({ id: 'p3', score: 200, num_comments: 40, created_utc: now - 10800, is_self: true, link_flair_text: 'Discussion' }),
    ];

    // First call: fetchSubredditAbout
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => aboutData,
    });
    // Second call: fetchSubredditPosts
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => buildRedditListing(cannedPosts),
    });

    // Mock DB: snapshot insert + previous snapshot query
    mockQuery.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO subreddit_snapshots')) {
        return Promise.resolve({ rowCount: 1 });
      }
      if (typeof sql === 'string' && sql.includes('SELECT subscribers FROM subreddit_snapshots')) {
        // Return a previous snapshot
        return Promise.resolve({
          rows: [{ subscribers: 248000 }],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const stats = await subredditService.getStats('typescript');

    // Verify basic stats
    expect(stats.name).toBe('typescript');
    expect(stats.subscribers).toBe(250000);
    expect(stats.activeUsers).toBe(1200);

    // Verify growth metrics
    expect(stats.growthMetrics.currentSubscribers).toBe(250000);
    expect(stats.growthMetrics.previousSubscribers).toBe(248000);
    expect(stats.growthMetrics.subscriberChange).toBe(2000);

    // Verify engagement metrics
    expect(stats.engagementMetrics.avgScorePerPost).toBeCloseTo((100 + 50 + 200) / 3);
    expect(stats.engagementMetrics.avgCommentsPerPost).toBeCloseTo((20 + 10 + 40) / 3);

    // Verify top posts are sorted by score descending
    expect(stats.topPosts[0].score).toBe(200);
    expect(stats.topPosts[1].score).toBe(100);
    expect(stats.topPosts[2].score).toBe(50);

    // Verify post type distribution includes text and link
    expect(stats.postTypeDistribution.text).toBeGreaterThan(0);
    expect(stats.postTypeDistribution.link).toBeGreaterThan(0);
  });

  it('should only count posts within the 30-day window for avgPostsPerDay', () => {
    const now = new Date();
    const nowUtc = now.getTime() / 1000;

    const posts: RedditPost[] = [
      // 3 posts within 30 days
      { id: 'p1', subreddit: 'ts', author: 'a', title: '', selftext: '', url: '', domain: '', permalink: '', score: 10, num_comments: 2, is_self: true, link_flair_text: null, created_utc: nowUtc - 86400 },
      { id: 'p2', subreddit: 'ts', author: 'b', title: '', selftext: '', url: '', domain: '', permalink: '', score: 10, num_comments: 2, is_self: true, link_flair_text: null, created_utc: nowUtc - 86400 * 15 },
      { id: 'p3', subreddit: 'ts', author: 'c', title: '', selftext: '', url: '', domain: '', permalink: '', score: 10, num_comments: 2, is_self: true, link_flair_text: null, created_utc: nowUtc - 86400 * 29 },
      // 1 post outside 30 days
      { id: 'p4', subreddit: 'ts', author: 'd', title: '', selftext: '', url: '', domain: '', permalink: '', score: 10, num_comments: 2, is_self: true, link_flair_text: null, created_utc: nowUtc - 86400 * 45 },
    ];

    const growth = computeGrowthMetrics(
      { subscribers: 100000, snapshotDate: now },
      { subscribers: 99000 },
      posts,
    );

    // Only 3 posts within 30 days → 3/30 = 0.1
    expect(growth.avgPostsPerDay).toBe(3 / 30);
  });
});
