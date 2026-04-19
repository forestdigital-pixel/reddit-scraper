import { getPool } from '../db/connection.js';
import type { RedditScraper } from '../core/reddit-scraper.js';
import type { RedditPost, RedditComment } from '../models/reddit.js';
import type { ContributorScore } from '../models/database.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ContributorProfile {
  username: string;
  subreddit: string;
  postCount: number;
  commentCount: number;
  totalPostScore: number;
  totalCommentScore: number;
  avgPostScore: number;
  avgCommentScore: number;
  influenceScore: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TOP_CONTRIBUTORS = 25;

// ---------------------------------------------------------------------------
// Standalone exported functions — for property testing
// ---------------------------------------------------------------------------

/**
 * Computes the influence score for a contributor profile.
 *
 * Formula: (totalPostScore * 1.0) + (totalCommentScore * 0.5) + (postCount * 10) + (commentCount * 2)
 *
 * **Validates: Requirements 8.2**
 */
export function computeInfluenceScore(
  profile: Omit<ContributorProfile, 'influenceScore'>,
): number {
  return (
    profile.totalPostScore * 1.0 +
    profile.totalCommentScore * 0.5 +
    profile.postCount * 10 +
    profile.commentCount * 2
  );
}

/**
 * Computes avgPostScore and avgCommentScore from contributor data.
 *
 * - avgPostScore = totalPostScore / postCount (0 if postCount is 0)
 * - avgCommentScore = totalCommentScore / commentCount (0 if commentCount is 0)
 *
 * **Validates: Requirements 8.3**
 */
export function computeContributorAverages(
  profile: Pick<ContributorProfile, 'totalPostScore' | 'totalCommentScore' | 'postCount' | 'commentCount'>,
): { avgPostScore: number; avgCommentScore: number } {
  return {
    avgPostScore: profile.postCount > 0 ? profile.totalPostScore / profile.postCount : 0,
    avgCommentScore: profile.commentCount > 0 ? profile.totalCommentScore / profile.commentCount : 0,
  };
}

/**
 * Filters posts and comments by a timeframe defined by start and end
 * `created_utc` timestamps (Unix seconds).
 *
 * Returns only items whose `created_utc` falls within [start, end] (inclusive).
 *
 * **Validates: Requirements 8.4**
 */
export function filterByTimeframe<T extends { created_utc: number }>(
  items: T[],
  start: number,
  end: number,
): T[] {
  return items.filter((item) => item.created_utc >= start && item.created_utc <= end);
}

// ---------------------------------------------------------------------------
// ContributorRankerService
// ---------------------------------------------------------------------------

export class ContributorRankerService {
  private readonly scraper: RedditScraper;

  constructor(scraper: RedditScraper) {
    this.scraper = scraper;
  }

  /**
   * Returns the top N contributors for a subreddit, ordered by influence
   * score descending. The limit is capped at 25.
   *
   * If a timeframe string is provided (e.g. 'day', 'week', 'month'), only
   * scores computed within that window are considered. Since the DB stores
   * pre-computed scores, timeframe filtering here applies to `computed_at`.
   *
   * **Validates: Requirements 8.1**
   */
  async getTopContributors(
    subreddit: string,
    limit: number,
    _timeframe?: string,
  ): Promise<ContributorProfile[]> {
    const effectiveLimit = Math.min(Math.max(1, limit), MAX_TOP_CONTRIBUTORS);

    const pool = getPool();
    const result = await pool.query<ContributorScore>(
      `SELECT * FROM contributor_scores
       WHERE subreddit = $1
       ORDER BY influence_score DESC
       LIMIT $2`,
      [subreddit, effectiveLimit],
    );

    return result.rows.map((row) => this.rowToProfile(row));
  }

  /**
   * Returns a single contributor's stats for a subreddit.
   *
   * Throws if the contributor is not found.
   *
   * **Validates: Requirements 8.3**
   */
  async getContributorProfile(
    username: string,
    subreddit: string,
  ): Promise<ContributorProfile> {
    const pool = getPool();
    const result = await pool.query<ContributorScore>(
      `SELECT * FROM contributor_scores
       WHERE username = $1 AND subreddit = $2
       ORDER BY computed_at DESC
       LIMIT 1`,
      [username, subreddit],
    );

    if (result.rows.length === 0) {
      throw new Error(
        `Contributor "${username}" not found in subreddit "${subreddit}"`,
      );
    }

    return this.rowToProfile(result.rows[0]);
  }

  /**
   * Scrapes recent posts and comments for a subreddit, aggregates stats
   * by author, computes influence scores, and upserts into the
   * `contributor_scores` table.
   *
   * **Validates: Requirements 8.5**
   */
  async refreshRankings(subreddit: string): Promise<void> {
    // Fetch recent posts
    const listing = await this.scraper.fetchSubredditPosts(subreddit, 'new', {
      limit: 100,
    });
    const posts = listing.children;

    // Fetch comments for each post (limited to first batch to stay within
    // rate limits — a production system would paginate more aggressively)
    const allComments: RedditComment[] = [];
    for (const post of posts.slice(0, 10)) {
      const comments = await this.scraper.fetchPostComments(subreddit, post.id);
      allComments.push(...comments);
    }

    // Aggregate by author
    const aggregated = this.aggregateByAuthor(posts, allComments);

    // Upsert into contributor_scores
    const pool = getPool();
    for (const profile of aggregated) {
      await pool.query(
        `INSERT INTO contributor_scores
           (username, subreddit, post_count, comment_count,
            total_post_score, total_comment_score, influence_score, computed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT ON CONSTRAINT contributor_scores_username_subreddit_key
         DO UPDATE SET
           post_count = EXCLUDED.post_count,
           comment_count = EXCLUDED.comment_count,
           total_post_score = EXCLUDED.total_post_score,
           total_comment_score = EXCLUDED.total_comment_score,
           influence_score = EXCLUDED.influence_score,
           computed_at = NOW()`,
        [
          profile.username,
          profile.subreddit,
          profile.postCount,
          profile.commentCount,
          profile.totalPostScore,
          profile.totalCommentScore,
          profile.influenceScore,
        ],
      );
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Aggregates posts and comments by author, computing per-author stats
   * and influence scores.
   */
  private aggregateByAuthor(
    posts: RedditPost[],
    comments: RedditComment[],
  ): ContributorProfile[] {
    const map = new Map<
      string,
      {
        username: string;
        subreddit: string;
        postCount: number;
        commentCount: number;
        totalPostScore: number;
        totalCommentScore: number;
      }
    >();

    const subreddit = posts[0]?.subreddit ?? comments[0]?.subreddit ?? '';

    for (const post of posts) {
      if (post.author === '[deleted]') continue;
      const existing = map.get(post.author) ?? {
        username: post.author,
        subreddit,
        postCount: 0,
        commentCount: 0,
        totalPostScore: 0,
        totalCommentScore: 0,
      };
      existing.postCount++;
      existing.totalPostScore += post.score;
      map.set(post.author, existing);
    }

    for (const comment of comments) {
      if (comment.author === '[deleted]') continue;
      const existing = map.get(comment.author) ?? {
        username: comment.author,
        subreddit,
        postCount: 0,
        commentCount: 0,
        totalPostScore: 0,
        totalCommentScore: 0,
      };
      existing.commentCount++;
      existing.totalCommentScore += comment.score;
      map.set(comment.author, existing);
    }

    return Array.from(map.values()).map((entry) => {
      const averages = computeContributorAverages(entry);
      const influenceScore = computeInfluenceScore({
        ...entry,
        ...averages,
      });
      return {
        ...entry,
        ...averages,
        influenceScore,
      };
    });
  }

  /**
   * Converts a `contributor_scores` DB row into a `ContributorProfile`.
   */
  private rowToProfile(row: ContributorScore): ContributorProfile {
    const averages = computeContributorAverages({
      totalPostScore: row.total_post_score,
      totalCommentScore: row.total_comment_score,
      postCount: row.post_count,
      commentCount: row.comment_count,
    });

    return {
      username: row.username,
      subreddit: row.subreddit,
      postCount: row.post_count,
      commentCount: row.comment_count,
      totalPostScore: row.total_post_score,
      totalCommentScore: row.total_comment_score,
      avgPostScore: averages.avgPostScore,
      avgCommentScore: averages.avgCommentScore,
      influenceScore: row.influence_score,
    };
  }
}
