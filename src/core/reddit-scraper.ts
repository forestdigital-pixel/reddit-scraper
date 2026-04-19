import { ProxyManager } from './proxy-manager.js';
import type { RateLimiter } from './rate-limiter.js';
import type {
  RedditPost,
  RedditComment,
  RedditListing,
  SubredditAbout,
  SearchParams,
  PaginationParams,
  RawRedditListingResponse,
  RawRedditChild,
  RawSubredditAboutResponse,
} from '../models/reddit.js';

/**
 * Configuration for the RedditScraper.
 */
export interface RedditScraperConfig {
  userAgent: string;
  proxyManager: ProxyManager;
  rateLimiter: RateLimiter;
}

const BASE_URL = 'https://old.reddit.com';
const MAX_LIMIT = 100;

/**
 * Core HTTP client that fetches data from Reddit JSON endpoints.
 *
 * All requests are routed through the ProxyManager (which handles proxy routing,
 * retries, and User-Agent headers) and the RateLimiter (which enforces minimum
 * intervals between requests).
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.6, 1.8
 */
export class RedditScraper {
  private readonly proxyManager: ProxyManager;

  constructor(config: RedditScraperConfig) {
    this.proxyManager = config.proxyManager;
    // RateLimiter is already integrated into ProxyManager — no direct usage needed here.
  }

  /**
   * Searches Reddit using the search.json endpoint.
   *
   * If a subreddit is specified and restrictSr is true, searches within that
   * subreddit using /r/{subreddit}/search.json. Otherwise uses /search.json.
   */
  async fetchSearch(params: SearchParams): Promise<RedditListing<RedditPost>> {
    const url = this.buildSearchUrl(params);
    const response = await this.fetchJson<RawRedditListingResponse>(url);
    return this.parsePostListing(response);
  }

  /**
   * Fetches posts from a subreddit with a given sort order.
   * e.g. /r/{subreddit}/hot.json, /r/{subreddit}/top.json
   */
  async fetchSubredditPosts(
    subreddit: string,
    sort: string,
    params: PaginationParams = {},
  ): Promise<RedditListing<RedditPost>> {
    const queryParams = this.buildPaginationQuery(params);
    const url = `${BASE_URL}/r/${encodeURIComponent(subreddit)}/${encodeURIComponent(sort)}.json${queryParams}`;
    const response = await this.fetchJson<RawRedditListingResponse>(url);
    return this.parsePostListing(response);
  }

  /**
   * Fetches the "about" information for a subreddit.
   * e.g. /r/{subreddit}/about.json
   */
  async fetchSubredditAbout(subreddit: string): Promise<SubredditAbout> {
    const url = `${BASE_URL}/r/${encodeURIComponent(subreddit)}/about.json`;
    const response = await this.fetchJson<RawSubredditAboutResponse>(url);
    return this.parseSubredditAbout(response);
  }

  /**
   * Fetches comments for a specific post and flattens the comment tree.
   *
   * Reddit returns an array of two listings:
   *   [0] = the post listing (single item)
   *   [1] = the comments listing (nested tree)
   *
   * This method recursively flattens the comment tree into a flat array.
   */
  async fetchPostComments(
    subreddit: string,
    postId: string,
  ): Promise<RedditComment[]> {
    const url = `${BASE_URL}/r/${encodeURIComponent(subreddit)}/comments/${encodeURIComponent(postId)}.json`;
    const response = await this.fetchJson<RawRedditListingResponse[]>(url);

    if (!Array.isArray(response) || response.length < 2) {
      return [];
    }

    const commentsListing = response[1];
    if (!commentsListing?.data?.children) {
      return [];
    }

    return this.flattenCommentTree(commentsListing.data.children, postId);
  }

  /**
   * Fetches new posts from a subreddit.
   * Convenience method equivalent to fetchSubredditPosts(subreddit, 'new', params).
   */
  async fetchNewPosts(
    subreddit: string,
    params: PaginationParams = {},
  ): Promise<RedditListing<RedditPost>> {
    return this.fetchSubredditPosts(subreddit, 'new', params);
  }

  // ---------------------------------------------------------------------------
  // URL Construction
  // ---------------------------------------------------------------------------

  /**
   * Builds the search URL from SearchParams.
   * Exported for testing (Property 1).
   */
  buildSearchUrl(params: SearchParams): string {
    const queryParts: string[] = [];

    queryParts.push(`q=${encodeURIComponent(params.query)}`);

    if (params.sort) {
      queryParts.push(`sort=${encodeURIComponent(params.sort)}`);
    }

    if (params.timeframe) {
      queryParts.push(`t=${encodeURIComponent(params.timeframe)}`);
    }

    if (params.restrictSr !== undefined) {
      queryParts.push(`restrict_sr=${params.restrictSr ? 'true' : 'false'}`);
    }

    // Pagination
    if (params.pagination?.after) {
      queryParts.push(`after=${encodeURIComponent(params.pagination.after)}`);
    }

    const limit = params.pagination?.limit
      ? Math.min(params.pagination.limit, MAX_LIMIT)
      : MAX_LIMIT;
    queryParts.push(`limit=${limit}`);

    // Always request raw JSON
    queryParts.push('raw_json=1');

    const queryString = `?${queryParts.join('&')}`;

    // If subreddit is specified, search within that subreddit
    if (params.subreddit) {
      return `${BASE_URL}/r/${encodeURIComponent(params.subreddit)}/search.json${queryString}`;
    }

    return `${BASE_URL}/search.json${queryString}`;
  }

  // ---------------------------------------------------------------------------
  // HTTP Fetching
  // ---------------------------------------------------------------------------

  /**
   * Fetches a URL through the ProxyManager and parses the JSON response.
   * The RateLimiter is already integrated into the ProxyManager.
   */
  private async fetchJson<T>(url: string): Promise<T> {
    const response = await this.proxyManager.fetch(url);

    if (!response.ok) {
      throw new Error(
        `Reddit request failed: ${response.status} ${response.statusText} for URL: ${url}`,
      );
    }

    const json = (await response.json()) as T;
    return json;
  }

  // ---------------------------------------------------------------------------
  // Response Parsing
  // ---------------------------------------------------------------------------

  /**
   * Parses a raw Reddit listing response into a typed RedditListing<RedditPost>.
   */
  private parsePostListing(raw: RawRedditListingResponse): RedditListing<RedditPost> {
    const children = raw?.data?.children ?? [];
    const posts: RedditPost[] = children
      .filter((child) => child.kind === 't3')
      .map((child) => this.parsePost(child.data));

    return {
      after: raw?.data?.after ?? null,
      before: raw?.data?.before ?? null,
      children: posts,
    };
  }

  /**
   * Parses a raw Reddit post data object into a typed RedditPost.
   */
  private parsePost(data: Record<string, unknown>): RedditPost {
    return {
      id: String(data['id'] ?? ''),
      subreddit: String(data['subreddit'] ?? ''),
      author: String(data['author'] ?? '[deleted]'),
      title: String(data['title'] ?? ''),
      selftext: String(data['selftext'] ?? ''),
      url: String(data['url'] ?? ''),
      domain: String(data['domain'] ?? ''),
      permalink: String(data['permalink'] ?? ''),
      score: Number(data['score'] ?? 0),
      num_comments: Number(data['num_comments'] ?? 0),
      is_self: Boolean(data['is_self']),
      link_flair_text: data['link_flair_text'] != null ? String(data['link_flair_text']) : null,
      created_utc: Number(data['created_utc'] ?? 0),
    };
  }

  /**
   * Parses a raw subreddit about response into a typed SubredditAbout.
   */
  private parseSubredditAbout(raw: RawSubredditAboutResponse): SubredditAbout {
    const data = raw?.data ?? {};
    return {
      name: String(data['display_name'] ?? data['name'] ?? ''),
      title: String(data['title'] ?? ''),
      description: String(data['description'] ?? ''),
      subscribers: Number(data['subscribers'] ?? 0),
      accounts_active: Number(data['accounts_active'] ?? 0),
      created_utc: Number(data['created_utc'] ?? 0),
      public_description: String(data['public_description'] ?? ''),
      over18: Boolean(data['over18']),
    };
  }

  /**
   * Recursively flattens a Reddit comment tree into a flat array of RedditComment.
   *
   * Reddit comments have a `replies` field that is either an empty string or
   * another listing containing child comments.
   */
  private flattenCommentTree(
    children: RawRedditChild[],
    postId: string,
  ): RedditComment[] {
    const comments: RedditComment[] = [];

    for (const child of children) {
      // Skip "more" stubs (kind: "more") — these are pagination placeholders
      if (child.kind !== 't1') {
        continue;
      }

      const data = child.data;
      comments.push(this.parseComment(data, postId));

      // Recurse into replies if present
      const replies = data['replies'];
      if (
        replies &&
        typeof replies === 'object' &&
        (replies as Record<string, unknown>)['kind'] === 'Listing'
      ) {
        const repliesListing = replies as RawRedditListingResponse;
        if (repliesListing.data?.children) {
          comments.push(
            ...this.flattenCommentTree(repliesListing.data.children, postId),
          );
        }
      }
    }

    return comments;
  }

  /**
   * Parses a raw Reddit comment data object into a typed RedditComment.
   */
  private parseComment(
    data: Record<string, unknown>,
    postId: string,
  ): RedditComment {
    return {
      id: String(data['id'] ?? ''),
      post_id: postId,
      subreddit: String(data['subreddit'] ?? ''),
      author: String(data['author'] ?? '[deleted]'),
      body: String(data['body'] ?? ''),
      score: Number(data['score'] ?? 0),
      permalink: String(data['permalink'] ?? ''),
      created_utc: Number(data['created_utc'] ?? 0),
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Builds a query string from PaginationParams.
   */
  private buildPaginationQuery(params: PaginationParams): string {
    const parts: string[] = [];

    if (params.after) {
      parts.push(`after=${encodeURIComponent(params.after)}`);
    }

    const limit = params.limit ? Math.min(params.limit, MAX_LIMIT) : MAX_LIMIT;
    parts.push(`limit=${limit}`);

    parts.push('raw_json=1');

    return parts.length > 0 ? `?${parts.join('&')}` : '';
  }
}
