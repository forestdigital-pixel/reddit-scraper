import { getPool } from '../db/connection.js';
import type { RedditScraper } from '../core/reddit-scraper.js';
import type { RedditPost, SubredditAbout } from '../models/reddit.js';
import type { SubredditSnapshot } from '../models/database.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PostType = 'text' | 'link' | 'image' | 'video';

export interface GrowthMetrics {
  currentSubscribers: number;
  previousSubscribers: number | null;
  subscriberChange: number | null;
  avgPostsPerDay: number;
  snapshotDate: Date;
}

export interface EngagementMetrics {
  avgScorePerPost: number;
  avgCommentsPerPost: number;
  periodDays: number; // 30
}

export interface SubredditStats {
  name: string;
  subscribers: number;
  activeUsers: number;
  postTypeDistribution: Record<PostType, number>; // percentages
  flairDistribution: Record<string, number>;
  topKeywords: Array<{ keyword: string; count: number }>; // top 20
  topPosts: RedditPost[]; // top 10 by score
  growthMetrics: GrowthMetrics;
  engagementMetrics: EngagementMetrics;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov'];
const VIDEO_DOMAINS = [
  'youtube.com',
  'youtu.be',
  'vimeo.com',
  'v.redd.it',
  'gfycat.com',
];

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'was', 'are', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing',
  'will', 'would', 'could', 'should', 'shall', 'may', 'might', 'must',
  'can', 'need', 'dare', 'ought', 'used',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above',
  'below', 'between', 'out', 'off', 'over', 'under', 'again',
  'further', 'then', 'once',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
  'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'only', 'own', 'same',
  'than', 'too', 'very', 'just', 'because', 'about', 'also',
  'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom',
  'when', 'where', 'why', 'how',
  'its', 'his', 'her', 'their', 'our', 'your', 'my',
  'it', 'he', 'she', 'they', 'we', 'you', 'me', 'him', 'them', 'us',
  'here', 'there', 'now', 'get', 'got', 'like', 'know', 'think',
  'come', 'make', 'find', 'give', 'tell', 'say', 'said',
  'one', 'two', 'first', 'new', 'way', 'use', 'her', 'see',
  'time', 'much', 'even', 'good', 'well', 'back', 'still',
  'going', 'really', 'don', 'amp', 'http', 'https', 'www', 'com',
]);

const PERIOD_DAYS = 30;

// ---------------------------------------------------------------------------
// Standalone / static functions — exported for property testing
// ---------------------------------------------------------------------------

/**
 * Classifies a Reddit post into a PostType based on its properties.
 *
 * - `text` when `is_self` is true
 * - `image` when the URL ends with an image extension
 * - `video` when the URL ends with a video extension or domain is a known video host
 * - `link` otherwise
 *
 * **Validates: Requirements 5.2**
 */
export function classifyPostType(post: RedditPost): PostType {
  if (post.is_self) {
    return 'text';
  }

  const urlLower = post.url.toLowerCase();

  // Extract the path portion (strip query string and fragment)
  let path: string;
  try {
    const parsed = new URL(urlLower);
    path = parsed.pathname;
  } catch {
    // If URL parsing fails, use the raw URL
    path = urlLower.split('?')[0]?.split('#')[0] ?? urlLower;
  }

  // Check image extensions
  for (const ext of IMAGE_EXTENSIONS) {
    if (path.endsWith(ext)) {
      return 'image';
    }
  }

  // Check video extensions
  for (const ext of VIDEO_EXTENSIONS) {
    if (path.endsWith(ext)) {
      return 'video';
    }
  }

  // Check video domains
  const domainLower = post.domain.toLowerCase();
  for (const videoDomain of VIDEO_DOMAINS) {
    if (domainLower === videoDomain || domainLower.endsWith('.' + videoDomain)) {
      return 'video';
    }
  }

  return 'link';
}

/**
 * Tokenizes post titles and selftext, counts word occurrences, and returns
 * the top `limit` keywords sorted by count descending.
 *
 * Filters out common stop words and words shorter than 3 characters.
 *
 * **Validates: Requirements 5.4**
 */
export function extractTopKeywords(
  posts: RedditPost[],
  limit: number = 20,
): Array<{ keyword: string; count: number }> {
  const counts = new Map<string, number>();

  for (const post of posts) {
    const text = `${post.title} ${post.selftext}`;
    const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

    for (const word of words) {
      if (word.length < 3) continue;
      if (STOP_WORDS.has(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }

  const sorted = Array.from(counts.entries())
    .map(([keyword, count]) => ({ keyword, count }))
    .sort((a, b) => b.count - a.count || a.keyword.localeCompare(b.keyword));

  return sorted.slice(0, limit);
}

/**
 * Computes average score per post and average comments per post.
 *
 * **Validates: Requirements 5.7**
 */
export function computeEngagementMetrics(posts: RedditPost[]): EngagementMetrics {
  if (posts.length === 0) {
    return {
      avgScorePerPost: 0,
      avgCommentsPerPost: 0,
      periodDays: PERIOD_DAYS,
    };
  }

  const totalScore = posts.reduce((sum, p) => sum + p.score, 0);
  const totalComments = posts.reduce((sum, p) => sum + p.num_comments, 0);

  return {
    avgScorePerPost: totalScore / posts.length,
    avgCommentsPerPost: totalComments / posts.length,
    periodDays: PERIOD_DAYS,
  };
}

/**
 * Computes flair distribution as percentages from the `link_flair_text` field.
 * Only posts with a non-null flair are counted.
 *
 * **Validates: Requirements 5.3**
 */
export function computeFlairDistribution(
  posts: RedditPost[],
): Record<string, number> {
  const postsWithFlair = posts.filter(
    (p) => p.link_flair_text != null && p.link_flair_text.trim() !== '',
  );

  if (postsWithFlair.length === 0) {
    return {};
  }

  const counts = new Map<string, number>();
  for (const post of postsWithFlair) {
    const flair = post.link_flair_text!;
    counts.set(flair, (counts.get(flair) ?? 0) + 1);
  }

  const distribution: Record<string, number> = {};
  for (const [flair, count] of counts) {
    distribution[flair] = (count / postsWithFlair.length) * 100;
  }

  return distribution;
}

/**
 * Returns the top `limit` posts sorted by score descending.
 *
 * **Validates: Requirements 5.5**
 */
export function getTopPosts(posts: RedditPost[], limit: number = 10): RedditPost[] {
  return [...posts].sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Computes growth metrics by comparing current and previous snapshots,
 * and computing avgPostsPerDay from posts over the past 30 days.
 *
 * **Validates: Requirements 5.6**
 */
export function computeGrowthMetrics(
  currentSnapshot: { subscribers: number; snapshotDate: Date },
  previousSnapshot: { subscribers: number } | null,
  posts: RedditPost[],
): GrowthMetrics {
  const now = currentSnapshot.snapshotDate;
  const thirtyDaysAgo = new Date(now.getTime() - PERIOD_DAYS * 24 * 60 * 60 * 1000);
  const thirtyDaysAgoUtc = thirtyDaysAgo.getTime() / 1000;

  const recentPosts = posts.filter((p) => p.created_utc >= thirtyDaysAgoUtc);
  const avgPostsPerDay = recentPosts.length / PERIOD_DAYS;

  return {
    currentSubscribers: currentSnapshot.subscribers,
    previousSubscribers: previousSnapshot?.subscribers ?? null,
    subscriberChange:
      previousSnapshot != null
        ? currentSnapshot.subscribers - previousSnapshot.subscribers
        : null,
    avgPostsPerDay,
    snapshotDate: now,
  };
}

/**
 * Computes post type distribution as percentages.
 *
 * **Validates: Requirements 5.2**
 */
export function computePostTypeDistribution(
  posts: RedditPost[],
): Record<PostType, number> {
  const distribution: Record<PostType, number> = {
    text: 0,
    link: 0,
    image: 0,
    video: 0,
  };

  if (posts.length === 0) {
    return distribution;
  }

  const counts: Record<PostType, number> = { text: 0, link: 0, image: 0, video: 0 };
  for (const post of posts) {
    const type = classifyPostType(post);
    counts[type]++;
  }

  for (const type of Object.keys(counts) as PostType[]) {
    distribution[type] = (counts[type] / posts.length) * 100;
  }

  return distribution;
}

// ---------------------------------------------------------------------------
// SubredditAnalyzerService
// ---------------------------------------------------------------------------

export class SubredditAnalyzerService {
  private readonly scraper: RedditScraper;

  constructor(scraper: RedditScraper) {
    this.scraper = scraper;
  }

  /**
   * Orchestrates fetching subreddit about data, recent posts, and computes
   * all metrics to produce a complete SubredditStats object.
   *
   * **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7**
   */
  async getStats(subreddit: string, _timeframe?: string): Promise<SubredditStats> {
    // Fetch subreddit metadata and recent posts in parallel
    const [about, listing] = await Promise.all([
      this.scraper.fetchSubredditAbout(subreddit),
      this.scraper.fetchSubredditPosts(subreddit, 'new', { limit: 100 }),
    ]);

    const posts = listing.children;

    // Record a snapshot for growth tracking
    await this.recordSnapshot(subreddit, about);

    // Fetch previous snapshot for growth comparison
    const previousSnapshot = await this.getPreviousSnapshot(subreddit);

    const now = new Date();

    // Compute all metrics
    const postTypeDistribution = computePostTypeDistribution(posts);
    const flairDistribution = computeFlairDistribution(posts);
    const topKeywords = extractTopKeywords(posts, 20);
    const topPosts = getTopPosts(posts, 10);
    const engagementMetrics = computeEngagementMetrics(posts);
    const growthMetrics = computeGrowthMetrics(
      { subscribers: about.subscribers, snapshotDate: now },
      previousSnapshot,
      posts,
    );

    return {
      name: about.name,
      subscribers: about.subscribers,
      activeUsers: about.accounts_active,
      postTypeDistribution,
      flairDistribution,
      topKeywords,
      topPosts,
      growthMetrics,
      engagementMetrics,
    };
  }

  /**
   * Records a snapshot of the current subscriber and active user counts
   * for a subreddit in the `subreddit_snapshots` table.
   *
   * **Validates: Requirements 5.6**
   */
  async recordSnapshot(subreddit: string, about?: SubredditAbout): Promise<void> {
    const subredditAbout =
      about ?? (await this.scraper.fetchSubredditAbout(subreddit));

    const pool = getPool();
    await pool.query(
      `INSERT INTO subreddit_snapshots (subreddit, subscribers, active_users, snapshot_at)
       VALUES ($1, $2, $3, NOW())`,
      [subreddit, subredditAbout.subscribers, subredditAbout.accounts_active],
    );
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Fetches the most recent previous snapshot for a subreddit (excluding
   * snapshots from the current minute to avoid comparing against the one
   * we just inserted).
   */
  private async getPreviousSnapshot(
    subreddit: string,
  ): Promise<{ subscribers: number } | null> {
    const pool = getPool();
    const result = await pool.query<SubredditSnapshot>(
      `SELECT subscribers FROM subreddit_snapshots
       WHERE subreddit = $1
       ORDER BY snapshot_at DESC
       LIMIT 1 OFFSET 1`,
      [subreddit],
    );

    if (result.rows.length === 0) {
      return null;
    }

    return { subscribers: result.rows[0].subscribers };
  }
}
