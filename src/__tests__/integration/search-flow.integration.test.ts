/**
 * Integration test: Full search flow.
 *
 * Tests the pipeline: API request → SearchService → RedditScraper → mock Reddit → filtering → API response.
 *
 * Uses a mock ProxyManager that returns canned Reddit JSON responses,
 * wired through RedditScraper → SearchService, verifying the full pipeline
 * including client-side filtering.
 *
 * **Validates: Requirements 1.1**
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedditScraper } from '../../core/reddit-scraper';
import { SearchService, filterPosts } from '../../services/search-service';
import type { RawRedditListingResponse } from '../../models/reddit';

// ---------------------------------------------------------------------------
// Mock the database so SearchService.cachePosts doesn't need a real PG pool
// ---------------------------------------------------------------------------
const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
vi.mock('../../db/connection', () => ({
  getPool: () => ({ query: mockQuery }),
}));

// ---------------------------------------------------------------------------
// Helpers: canned Reddit JSON
// ---------------------------------------------------------------------------

function buildRedditListing(posts: Array<Record<string, unknown>>): RawRedditListingResponse {
  return {
    kind: 'Listing',
    data: {
      children: posts.map((p) => ({ kind: 't3', data: p })),
      after: posts.length > 0 ? 't3_after_token' : null,
      before: null,
    },
  };
}

function makePost(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'post1',
    subreddit: 'typescript',
    author: 'dev_user',
    title: 'How to use TypeScript generics',
    selftext: 'I am learning about generics in TypeScript.',
    url: 'https://reddit.com/r/typescript/comments/post1/how_to_use_typescript_generics/',
    domain: 'self.typescript',
    permalink: '/r/typescript/comments/post1/how_to_use_typescript_generics/',
    score: 42,
    num_comments: 10,
    is_self: true,
    link_flair_text: 'Question',
    created_utc: Date.now() / 1000 - 3600,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Integration: Full search flow', () => {
  let scraper: RedditScraper;
  let searchService: SearchService;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    // Create a mock ProxyManager-like fetch that returns canned Reddit JSON
    mockFetch = vi.fn();

    // Build a real RedditScraper but with a mock ProxyManager
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

    searchService = new SearchService(scraper);
  });

  it('should return parsed posts from a canned Reddit response', async () => {
    const cannedPosts = [
      makePost({ id: 'p1', title: 'TypeScript tips', score: 100 }),
      makePost({ id: 'p2', title: 'JavaScript vs TypeScript', score: 50 }),
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => buildRedditListing(cannedPosts),
    });

    const result = await searchService.search({ query: 'typescript' });

    expect(result.posts).toHaveLength(2);
    expect(result.posts[0].id).toBe('p1');
    expect(result.posts[1].id).toBe('p2');
    expect(result.pagination.totalItems).toBe(2);
    expect(result.pagination.after).toBe('t3_after_token');
  });

  it('should apply client-side keyword exclusion filtering', async () => {
    const cannedPosts = [
      makePost({ id: 'p1', title: 'TypeScript generics guide', selftext: '' }),
      makePost({ id: 'p2', title: 'JavaScript spam post', selftext: 'buy cheap stuff' }),
      makePost({ id: 'p3', title: 'Advanced TypeScript patterns', selftext: '' }),
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => buildRedditListing(cannedPosts),
    });

    const result = await searchService.search({
      query: 'typescript',
      excludeKeywords: ['spam'],
    });

    // Post p2 should be excluded because its title contains "spam"
    expect(result.posts).toHaveLength(2);
    expect(result.posts.map((p) => p.id)).toEqual(['p1', 'p3']);
  });

  it('should apply client-side user exclusion filtering', async () => {
    const cannedPosts = [
      makePost({ id: 'p1', author: 'good_user' }),
      makePost({ id: 'p2', author: 'spammer_bot' }),
      makePost({ id: 'p3', author: 'another_user' }),
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => buildRedditListing(cannedPosts),
    });

    const result = await searchService.search({
      query: 'test',
      excludeUsers: ['spammer_bot'],
    });

    expect(result.posts).toHaveLength(2);
    expect(result.posts.map((p) => p.id)).toEqual(['p1', 'p3']);
  });

  it('should apply both keyword and user exclusion together', async () => {
    const cannedPosts = [
      makePost({ id: 'p1', author: 'good_user', title: 'Clean post' }),
      makePost({ id: 'p2', author: 'spammer', title: 'Clean post' }),
      makePost({ id: 'p3', author: 'good_user', title: 'Post with banned keyword' }),
      makePost({ id: 'p4', author: 'another_user', title: 'Another clean post' }),
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => buildRedditListing(cannedPosts),
    });

    const result = await searchService.search({
      query: 'test',
      excludeKeywords: ['banned'],
      excludeUsers: ['spammer'],
    });

    // p2 excluded by user, p3 excluded by keyword
    expect(result.posts).toHaveLength(2);
    expect(result.posts.map((p) => p.id)).toEqual(['p1', 'p4']);
  });

  it('should return empty results with a message when no posts match', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => buildRedditListing([]),
    });

    const result = await searchService.search({ query: 'nonexistent' });

    expect(result.posts).toHaveLength(0);
    expect(result.pagination.totalItems).toBe(0);
    expect(result.message).toBeDefined();
  });

  it('should paginate filtered results correctly', async () => {
    // Create 5 posts, all passing filters
    const cannedPosts = Array.from({ length: 5 }, (_, i) =>
      makePost({ id: `p${i}`, title: `Post ${i}`, score: 50 - i }),
    );

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => buildRedditListing(cannedPosts),
    });

    const result = await searchService.search({
      query: 'test',
      page: 2,
      pageSize: 2,
    });

    // Page 2 with pageSize 2 should return posts at index 2-3
    expect(result.posts).toHaveLength(2);
    expect(result.posts[0].id).toBe('p2');
    expect(result.posts[1].id).toBe('p3');
    expect(result.pagination.page).toBe(2);
    expect(result.pagination.pageSize).toBe(2);
    expect(result.pagination.totalItems).toBe(5);
    expect(result.pagination.totalPages).toBe(3);
  });

  it('should cache posts in the database after filtering', async () => {
    const cannedPosts = [
      makePost({ id: 'p1', title: 'Good post' }),
      makePost({ id: 'p2', title: 'Spam post' }),
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => buildRedditListing(cannedPosts),
    });

    await searchService.search({
      query: 'test',
      excludeKeywords: ['spam'],
    });

    // Only the filtered post (p1) should be cached
    const insertCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO reddit_posts'),
    );
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0][1][0]).toBe('p1');
  });

  it('should pass search params through to the scraper URL correctly', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => buildRedditListing([]),
    });

    await searchService.search({
      query: 'react hooks',
      subreddit: 'reactjs',
      sort: 'top',
      timeframe: 'week',
    });

    // Verify the URL passed to the mock fetch
    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    expect(fetchUrl).toContain('/r/reactjs/search.json');
    expect(fetchUrl).toContain('q=react%20hooks');
    expect(fetchUrl).toContain('sort=top');
    expect(fetchUrl).toContain('t=week');
    expect(fetchUrl).toContain('restrict_sr=true');
  });
});
