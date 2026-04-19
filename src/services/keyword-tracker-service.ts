import { randomUUID } from 'node:crypto';
import { getPool } from '../db/connection.js';
import type { RedditScraper } from '../core/reddit-scraper.js';
import type { RedditPost, RedditComment } from '../models/reddit.js';
import type {
  TrackedKeyword,
  KeywordFrequency,
  KeywordMatch,
} from '../models/database.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Union type representing a Reddit post or comment returned from keyword
 * match queries. Includes the content_type discriminator so callers know
 * which shape they are dealing with.
 */
export type RedditContent =
  | { content_type: 'post'; data: RedditPost }
  | { content_type: 'comment'; data: RedditComment };

// ---------------------------------------------------------------------------
// Pure helper functions — exported for property testing
// ---------------------------------------------------------------------------

/**
 * Returns true when `text` contains `keyword` (case-insensitive).
 *
 * Exported for property testing (Property 8).
 */
export function matchesKeyword(text: string, keyword: string): boolean {
  if (keyword.length === 0) return false;
  return text.toLowerCase().includes(keyword.toLowerCase());
}

/**
 * Given an array of matches with `matchedAt` timestamps, returns a Map
 * from ISO date strings (YYYY-MM-DD) to the number of matches on that day.
 *
 * Exported for property testing (Property 7).
 */
export function computeDailyFrequencies(
  matches: { matchedAt: Date }[],
): Map<string, number> {
  const freq = new Map<string, number>();
  for (const m of matches) {
    const day = m.matchedAt.toISOString().slice(0, 10); // YYYY-MM-DD
    freq.set(day, (freq.get(day) ?? 0) + 1);
  }
  return freq;
}

// ---------------------------------------------------------------------------
// KeywordTrackerService
// ---------------------------------------------------------------------------

/** Maximum number of active keywords a single user may track. */
const MAX_KEYWORDS_PER_USER = 50;

/**
 * Manages keyword tracking, frequency recording, and trend analysis.
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**
 */
export class KeywordTrackerService {
  private readonly scraper: RedditScraper;

  constructor(scraper: RedditScraper) {
    this.scraper = scraper;
  }

  // -----------------------------------------------------------------------
  // addKeyword
  // -----------------------------------------------------------------------

  /**
   * Adds a keyword to the tracking list for a user.
   *
   * Enforces the per-user limit of {@link MAX_KEYWORDS_PER_USER} active
   * keywords (Requirement 3.5).
   */
  async addKeyword(userId: string, keyword: string): Promise<TrackedKeyword> {
    const pool = getPool();

    // Enforce per-user keyword limit
    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM tracked_keywords
       WHERE user_id = $1 AND is_active = TRUE`,
      [userId],
    );
    const activeCount = parseInt(countResult.rows[0].count, 10);
    if (activeCount >= MAX_KEYWORDS_PER_USER) {
      throw new Error(
        `User has reached the maximum of ${MAX_KEYWORDS_PER_USER} active keywords.`,
      );
    }

    const id = randomUUID();
    const now = new Date();

    await pool.query(
      `INSERT INTO tracked_keywords (id, user_id, keyword, is_active, notifications_enabled, last_match_at, created_at)
       VALUES ($1, $2, $3, TRUE, FALSE, NULL, $4)`,
      [id, userId, keyword, now],
    );

    return {
      id,
      user_id: userId,
      keyword,
      is_active: true,
      notifications_enabled: false,
      last_match_at: null,
      created_at: now,
    };
  }

  // -----------------------------------------------------------------------
  // removeKeyword
  // -----------------------------------------------------------------------

  /**
   * Soft-deletes a keyword by setting `is_active = false`.
   */
  async removeKeyword(userId: string, keywordId: string): Promise<void> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE tracked_keywords SET is_active = FALSE
       WHERE id = $1 AND user_id = $2`,
      [keywordId, userId],
    );
    if (result.rowCount === 0) {
      throw new Error('Keyword not found or does not belong to this user.');
    }
  }

  // -----------------------------------------------------------------------
  // getKeywords
  // -----------------------------------------------------------------------

  /**
   * Returns all active keywords for a user.
   */
  async getKeywords(userId: string): Promise<TrackedKeyword[]> {
    const pool = getPool();
    const result = await pool.query<TrackedKeyword>(
      `SELECT id, user_id, keyword, is_active, notifications_enabled, last_match_at, created_at
       FROM tracked_keywords
       WHERE user_id = $1 AND is_active = TRUE
       ORDER BY created_at ASC`,
      [userId],
    );
    return result.rows;
  }

  // -----------------------------------------------------------------------
  // pollKeyword
  // -----------------------------------------------------------------------

  /**
   * Polls Reddit for new matches of a tracked keyword.
   *
   * 1. Calls `RedditScraper.fetchSearch()` for the keyword.
   * 2. Compares results against existing matches in `keyword_matches`.
   * 3. Stores new matches and updates `keyword_frequencies`.
   * 4. Returns the newly matched content.
   */
  async pollKeyword(keyword: TrackedKeyword): Promise<RedditContent[]> {
    const pool = getPool();

    // Fetch search results from Reddit
    const listing = await this.scraper.fetchSearch({
      query: keyword.keyword,
      sort: 'new',
      pagination: { limit: 100 },
    });

    const newContent: RedditContent[] = [];
    const now = new Date();
    const today = now.toISOString().slice(0, 10); // YYYY-MM-DD

    for (const post of listing.children) {
      // Only include posts that actually contain the keyword
      const textToSearch = `${post.title} ${post.selftext}`;
      if (!matchesKeyword(textToSearch, keyword.keyword)) {
        continue;
      }

      // Check if this match already exists
      const existing = await pool.query(
        `SELECT id FROM keyword_matches
         WHERE keyword_id = $1 AND content_id = $2 AND content_type = 'post'`,
        [keyword.id, post.id],
      );

      if (existing.rows.length > 0) {
        continue; // Already tracked
      }

      // Cache the post in reddit_posts (upsert)
      await this.cachePost(post);

      // Insert the new match
      const matchId = randomUUID();
      await pool.query(
        `INSERT INTO keyword_matches (id, keyword_id, content_id, content_type, matched_at)
         VALUES ($1, $2, $3, 'post', $4)`,
        [matchId, keyword.id, post.id, now],
      );

      newContent.push({ content_type: 'post', data: post });
    }

    // Update keyword_frequencies for today
    if (newContent.length > 0) {
      await this.incrementDailyFrequency(keyword.id, today, newContent.length);

      // Update last_match_at on the keyword
      await pool.query(
        `UPDATE tracked_keywords SET last_match_at = $1 WHERE id = $2`,
        [now, keyword.id],
      );
    }

    return newContent;
  }

  // -----------------------------------------------------------------------
  // getFrequencyTimeSeries
  // -----------------------------------------------------------------------

  /**
   * Returns daily keyword frequency data for a date range.
   *
   * **Validates: Requirement 3.3**
   */
  async getFrequencyTimeSeries(
    keywordId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<KeywordFrequency[]> {
    const pool = getPool();
    const result = await pool.query<KeywordFrequency>(
      `SELECT id, keyword_id, date, count
       FROM keyword_frequencies
       WHERE keyword_id = $1 AND date >= $2 AND date <= $3
       ORDER BY date ASC`,
      [keywordId, startDate, endDate],
    );
    return result.rows;
  }

  // -----------------------------------------------------------------------
  // getRecentMatches
  // -----------------------------------------------------------------------

  /**
   * Returns the most recent keyword matches joined with their Reddit content.
   *
   * **Validates: Requirement 3.4**
   */
  async getRecentMatches(
    keywordId: string,
    limit: number,
  ): Promise<RedditContent[]> {
    const pool = getPool();
    const effectiveLimit = Math.min(Math.max(limit, 1), 100);

    // Fetch matches ordered by most recent first
    const matchResult = await pool.query<KeywordMatch>(
      `SELECT id, keyword_id, content_id, content_type, matched_at
       FROM keyword_matches
       WHERE keyword_id = $1
       ORDER BY matched_at DESC
       LIMIT $2`,
      [keywordId, effectiveLimit],
    );

    const results: RedditContent[] = [];

    for (const match of matchResult.rows) {
      if (match.content_type === 'post') {
        const postResult = await pool.query<RedditPost>(
          `SELECT id, subreddit, author, title, selftext, url, domain,
                  permalink, score, num_comments, is_self, link_flair_text,
                  created_utc
           FROM reddit_posts
           WHERE id = $1`,
          [match.content_id],
        );
        if (postResult.rows.length > 0) {
          results.push({ content_type: 'post', data: postResult.rows[0] });
        }
      } else if (match.content_type === 'comment') {
        const commentResult = await pool.query<RedditComment>(
          `SELECT id, post_id, subreddit, author, body, score, permalink,
                  created_utc
           FROM reddit_comments
           WHERE id = $1`,
          [match.content_id],
        );
        if (commentResult.rows.length > 0) {
          results.push({ content_type: 'comment', data: commentResult.rows[0] });
        }
      }
    }

    return results;
  }

  // -----------------------------------------------------------------------
  // flagInactiveKeywords
  // -----------------------------------------------------------------------

  /**
   * Marks keywords with zero matches in the past 30 days as inactive.
   *
   * **Validates: Requirement 3.6**
   */
  async flagInactiveKeywords(): Promise<void> {
    const pool = getPool();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Find active keywords that have no matches in the past 30 days
    await pool.query(
      `UPDATE tracked_keywords
       SET is_active = FALSE
       WHERE is_active = TRUE
         AND id NOT IN (
           SELECT DISTINCT keyword_id
           FROM keyword_matches
           WHERE matched_at >= $1
         )`,
      [thirtyDaysAgo],
    );
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Increments (or creates) the daily frequency count for a keyword.
   *
   * Uses a SELECT-then-INSERT/UPDATE pattern because the
   * `keyword_frequencies` table has no unique constraint on
   * `(keyword_id, date)`.
   */
  private async incrementDailyFrequency(
    keywordId: string,
    dateStr: string,
    increment: number,
  ): Promise<void> {
    const pool = getPool();

    const existing = await pool.query<{ id: string; count: number }>(
      `SELECT id, count FROM keyword_frequencies
       WHERE keyword_id = $1 AND date = $2
       LIMIT 1`,
      [keywordId, dateStr],
    );

    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE keyword_frequencies SET count = count + $1 WHERE id = $2`,
        [increment, existing.rows[0].id],
      );
    } else {
      await pool.query(
        `INSERT INTO keyword_frequencies (id, keyword_id, date, count)
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), keywordId, dateStr, increment],
      );
    }
  }

  /**
   * Upserts a Reddit post into the `reddit_posts` table for caching.
   */
  private async cachePost(post: RedditPost): Promise<void> {
    const pool = getPool();
    try {
      await pool.query(
        `INSERT INTO reddit_posts (
           id, subreddit, author, title, selftext, url, domain,
           permalink, score, num_comments, is_self, link_flair_text,
           created_utc, scraped_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
         ON CONFLICT (id) DO UPDATE SET
           score        = EXCLUDED.score,
           num_comments = EXCLUDED.num_comments,
           scraped_at   = NOW()`,
        [
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
        ],
      );
    } catch (err) {
      console.error(`Failed to cache post ${post.id}:`, err);
    }
  }
}
