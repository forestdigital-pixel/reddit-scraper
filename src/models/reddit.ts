/**
 * TypeScript interfaces for Reddit JSON endpoint responses and domain models.
 *
 * Reddit JSON responses follow the structure:
 * { kind: "Listing", data: { children: [{ kind: "t3"|"t1", data: {...} }], after: "...", before: "..." } }
 *
 * - t3 = Link (post)
 * - t1 = Comment
 * - t5 = Subreddit
 */

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface PaginationParams {
  after?: string;
  limit?: number; // max 100
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchParams {
  query: string;
  subreddit?: string;
  sort?: 'relevance' | 'new' | 'hot' | 'top' | 'comments';
  timeframe?: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';
  restrictSr?: boolean;
  pagination?: PaginationParams;
}

// ---------------------------------------------------------------------------
// Reddit Listing (generic wrapper)
// ---------------------------------------------------------------------------

export interface RedditListing<T> {
  after: string | null;
  before: string | null;
  children: T[];
}

// ---------------------------------------------------------------------------
// Reddit Post (t3)
// ---------------------------------------------------------------------------

export interface RedditPost {
  id: string;
  subreddit: string;
  author: string;
  title: string;
  selftext: string;
  url: string;
  domain: string;
  permalink: string;
  score: number;
  num_comments: number;
  is_self: boolean;
  link_flair_text: string | null;
  created_utc: number;
}

// ---------------------------------------------------------------------------
// Reddit Comment (t1)
// ---------------------------------------------------------------------------

export interface RedditComment {
  id: string;
  post_id: string;
  subreddit: string;
  author: string;
  body: string;
  score: number;
  permalink: string;
  created_utc: number;
}

// ---------------------------------------------------------------------------
// Subreddit About (t5)
// ---------------------------------------------------------------------------

export interface SubredditAbout {
  name: string;
  title: string;
  description: string;
  subscribers: number;
  accounts_active: number;
  created_utc: number;
  public_description: string;
  over18: boolean;
}

// ---------------------------------------------------------------------------
// Raw Reddit JSON shapes (used internally for parsing)
// ---------------------------------------------------------------------------

/** Raw Reddit listing envelope */
export interface RawRedditListingResponse {
  kind: 'Listing';
  data: {
    children: RawRedditChild[];
    after: string | null;
    before: string | null;
  };
}

export interface RawRedditChild {
  kind: string; // "t3" for posts, "t1" for comments, "t5" for subreddits
  data: Record<string, unknown>;
}

/** Raw subreddit about response */
export interface RawSubredditAboutResponse {
  kind: 't5';
  data: Record<string, unknown>;
}
