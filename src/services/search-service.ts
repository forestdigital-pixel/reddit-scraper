import { getPool } from '../db/connection.js';
import type { RedditScraper } from '../core/reddit-scraper.js';
import type { RedditPost, SearchParams } from '../models/reddit.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SearchRequest {
  query: string;
  subreddit?: string;
  sort?: 'relevance' | 'new' | 'hot' | 'top' | 'comments';
  timeframe?: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';
  excludeKeywords?: string[];
  excludeUsers?: string[];
  page?: number;
  pageSize?: number;
  after?: string;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  after: string | null;
}

export interface SearchResponse {
  posts: RedditPost[];
  pagination: PaginationMeta;
  message?: string;
}

// ---------------------------------------------------------------------------
// Standalone filtering function — exported for property testing
// ---------------------------------------------------------------------------

/**
 * Filters an array of Reddit posts by removing:
 * - Posts whose title or selftext contains any of the excluded keywords (case-insensitive)
 * - Posts authored by any of the excluded users (case-insensitive)
 *
 * **Validates: Requirements 1.4, 1.5**
 */
export function filterPosts(
  posts: RedditPost[],
  excludeKeywords: string[],
  excludeUsers: string[],
): RedditPost[] {
  const lowerKeywords = excludeKeywords.map((k) => k.toLowerCase());
  const lowerUsers = excludeUsers.map((u) => u.toLowerCase());

  return posts.filter((post) => {
    // Check excluded users (case-insensitive)
    if (lowerUsers.length > 0) {
      const authorLower = post.author.toLowerCase();
      if (lowerUsers.includes(authorLower)) {
        return false;
      }
    }

    // Check excluded keywords in title + selftext (case-insensitive)
    if (lowerKeywords.length > 0) {
      const titleLower = post.title.toLowerCase();
      const selftextLower = post.selftext.toLowerCase();
      for (const keyword of lowerKeywords) {
        if (keyword.length === 0) continue;
        if (titleLower.includes(keyword) || selftextLower.includes(keyword)) {
          return false;
        }
      }
    }

    return true;
  });
}

// ---------------------------------------------------------------------------
// SearchService
// ---------------------------------------------------------------------------

export class SearchService {
  private readonly scraper: RedditScraper;

  constructor(scraper: RedditScraper) {
    this.scraper = scraper;
  }

  /**
   * Searches Reddit, applies client-side filtering, caches results, and
   * returns the filtered posts with pagination metadata.
   *
   * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8**
   */
  async search(request: SearchRequest): Promise<SearchResponse> {
    const page = Math.max(request.page ?? 1, 1);
    const pageSize = Math.min(Math.max(request.pageSize ?? 25, 1), 100);

    // Build SearchParams for the scraper
    const searchParams: SearchParams = {
      query: request.query,
      subreddit: request.subreddit,
      sort: request.sort,
      timeframe: request.timeframe,
      restrictSr: request.subreddit ? true : undefined,
      pagination: {
        after: request.after,
        limit: 100, // fetch max from Reddit, filter client-side
      },
    };

    // Fetch from Reddit
    const listing = await this.scraper.fetchSearch(searchParams);

    // Apply client-side exclusion filtering
    const filtered = filterPosts(
      listing.children,
      request.excludeKeywords ?? [],
      request.excludeUsers ?? [],
    );

    // Handle empty results (Requirement 1.7)
    if (filtered.length === 0) {
      return {
        posts: [],
        pagination: {
          page,
          pageSize,
          totalItems: 0,
          totalPages: 0,
          after: listing.after,
        },
        message: 'No matching content was found for your search query.',
      };
    }

    // Cache results in the database (best-effort — don't fail the request)
    await this.cachePosts(filtered);

    // Apply in-memory pagination over the filtered results
    const startIndex = (page - 1) * pageSize;
    const paginatedPosts = filtered.slice(startIndex, startIndex + pageSize);
    const totalPages = Math.ceil(filtered.length / pageSize);

    return {
      posts: paginatedPosts,
      pagination: {
        page,
        pageSize,
        totalItems: filtered.length,
        totalPages,
        after: listing.after,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Upserts posts into the `reddit_posts` table for caching.
   * Uses ON CONFLICT to update existing rows with fresh data.
   */
  private async cachePosts(posts: RedditPost[]): Promise<void> {
    if (posts.length === 0) return;

    const pool = getPool();

    const query = `
      INSERT INTO reddit_posts (
        id, subreddit, author, title, selftext, url, domain,
        permalink, score, num_comments, is_self, link_flair_text,
        created_utc, scraped_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
      ON CONFLICT (id) DO UPDATE SET
        score       = EXCLUDED.score,
        num_comments = EXCLUDED.num_comments,
        scraped_at  = NOW()
    `;

    for (const post of posts) {
      try {
        await pool.query(query, [
          post.id,
          post.subreddit,
          post.author,
          post.title,
          post.selftext,
          post.url,
          post.domain,
          post.permalink,
          post.score,
          post.num_comments,
          post.is_self,
          post.link_flair_text,
          new Date(post.created_utc * 1000),
        ]);
      } catch (_err) {
        // Best-effort caching — log but don't fail the search
        console.error(`Failed to cache post ${post.id}:`, _err);
      }
    }
  }
}
