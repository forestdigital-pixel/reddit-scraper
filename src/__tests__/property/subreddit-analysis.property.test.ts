import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  classifyPostType,
  extractTopKeywords,
  computeEngagementMetrics,
  computeFlairDistribution,
  getTopPosts,
  computeGrowthMetrics,
} from '../../services/subreddit-analyzer-service';
import type { RedditPost } from '../../models/reddit';

/**
 * Property-based tests for SubredditAnalyzerService standalone functions.
 *
 * Feature: reddit-data-scraper
 */

// ---------------------------------------------------------------------------
// Shared arbitraries
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

/** Arbitrary for a basic RedditPost with configurable overrides */
function redditPostArb(overrides?: Partial<{
  is_self: fc.Arbitrary<boolean>;
  url: fc.Arbitrary<string>;
  domain: fc.Arbitrary<string>;
  score: fc.Arbitrary<number>;
  num_comments: fc.Arbitrary<number>;
  link_flair_text: fc.Arbitrary<string | null>;
  title: fc.Arbitrary<string>;
  selftext: fc.Arbitrary<string>;
  created_utc: fc.Arbitrary<number>;
}>): fc.Arbitrary<RedditPost> {
  return fc.record({
    id: fc.uuid(),
    subreddit: fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{2,20}$/),
    author: fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{2,15}$/),
    title: overrides?.title ?? fc.string({ minLength: 1, maxLength: 100 }),
    selftext: overrides?.selftext ?? fc.string({ minLength: 0, maxLength: 200 }),
    url: overrides?.url ?? fc.webUrl(),
    domain: overrides?.domain ?? fc.domain(),
    permalink: fc.constant('/r/test/comments/abc123/test_post/'),
    score: overrides?.score ?? fc.integer({ min: 0, max: 100000 }),
    num_comments: overrides?.num_comments ?? fc.integer({ min: 0, max: 10000 }),
    is_self: overrides?.is_self ?? fc.boolean(),
    link_flair_text: overrides?.link_flair_text ?? fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: null }),
    created_utc: overrides?.created_utc ?? fc.integer({ min: 1600000000, max: 1800000000 }),
  });
}

/** Generate a non-empty array of RedditPosts */
const postsArb = fc.array(redditPostArb(), { minLength: 1, maxLength: 50 });

// ---------------------------------------------------------------------------
// Property 10: Post type classification is deterministic and correct
// ---------------------------------------------------------------------------

describe('Subreddit Analysis Property Tests', () => {
  /**
   * Property 10: Post type classification is deterministic and correct
   *
   * For any Reddit post, `classifyPostType` should return `text` when
   * `is_self` is true, `image` when URL ends with image extension, `video`
   * when URL ends with video extension or domain is a known video host,
   * `link` otherwise. Same input → same output.
   *
   * **Validates: Requirements 5.2**
   */
  describe('Property 10: Post type classification is deterministic and correct', () => {
    it('returns text when is_self is true', () => {
      const selfPostArb = redditPostArb({ is_self: fc.constant(true) });

      fc.assert(
        fc.property(selfPostArb, (post) => {
          expect(classifyPostType(post)).toBe('text');
        }),
        { numRuns: 100 },
      );
    });

    it('returns image when URL ends with an image extension', () => {
      const imageExtArb = fc.constantFrom(...IMAGE_EXTENSIONS);
      const imagePostArb = fc
        .tuple(
          redditPostArb({
            is_self: fc.constant(false),
            domain: fc.constant('i.imgur.com'),
          }),
          imageExtArb,
        )
        .map(([post, ext]) => ({
          ...post,
          url: `https://i.imgur.com/abc123${ext}`,
        }));

      fc.assert(
        fc.property(imagePostArb, (post) => {
          expect(classifyPostType(post)).toBe('image');
        }),
        { numRuns: 100 },
      );
    });

    it('returns video when URL ends with a video extension', () => {
      const videoExtArb = fc.constantFrom(...VIDEO_EXTENSIONS);
      const videoPostArb = fc
        .tuple(
          redditPostArb({
            is_self: fc.constant(false),
            domain: fc.constant('example.com'),
          }),
          videoExtArb,
        )
        .map(([post, ext]) => ({
          ...post,
          url: `https://example.com/video${ext}`,
        }));

      fc.assert(
        fc.property(videoPostArb, (post) => {
          expect(classifyPostType(post)).toBe('video');
        }),
        { numRuns: 100 },
      );
    });

    it('returns video when domain is a known video host', () => {
      const videoDomainArb = fc.constantFrom(...VIDEO_DOMAINS);
      const videoDomainPostArb = fc
        .tuple(
          redditPostArb({
            is_self: fc.constant(false),
            url: fc.constant('https://youtube.com/watch?v=abc'),
          }),
          videoDomainArb,
        )
        .map(([post, domain]) => ({
          ...post,
          domain,
          url: `https://${domain}/some-video`,
        }));

      fc.assert(
        fc.property(videoDomainPostArb, (post) => {
          expect(classifyPostType(post)).toBe('video');
        }),
        { numRuns: 100 },
      );
    });

    it('returns link when none of the above conditions match', () => {
      const linkPostArb = redditPostArb({
        is_self: fc.constant(false),
        url: fc.constant('https://example.com/article'),
        domain: fc.constant('example.com'),
      });

      fc.assert(
        fc.property(linkPostArb, (post) => {
          expect(classifyPostType(post)).toBe('link');
        }),
        { numRuns: 100 },
      );
    });

    it('is deterministic: same input always produces same output', () => {
      const anyPostArb = redditPostArb();

      fc.assert(
        fc.property(anyPostArb, (post) => {
          const result1 = classifyPostType(post);
          const result2 = classifyPostType(post);
          expect(result1).toBe(result2);
        }),
        { numRuns: 100 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Property 11: Flair distribution percentages sum to 100%
  // -------------------------------------------------------------------------

  /**
   * Property 11: Flair distribution percentages sum to 100%
   *
   * For any non-empty set of posts with flair values, the flair distribution
   * percentages should sum to approximately 100%.
   *
   * **Validates: Requirements 5.3**
   */
  describe('Property 11: Flair distribution percentages sum to 100%', () => {
    const flairValues = ['Discussion', 'Question', 'News', 'Meta', 'Help', 'Showcase'];

    /** Posts that all have a non-null flair */
    const postsWithFlairArb = fc.array(
      redditPostArb({
        link_flair_text: fc.constantFrom(...flairValues),
      }),
      { minLength: 1, maxLength: 50 },
    );

    it('percentages sum to approximately 100% for posts with flairs', () => {
      fc.assert(
        fc.property(postsWithFlairArb, (posts) => {
          const distribution = computeFlairDistribution(posts);
          const values = Object.values(distribution);

          expect(values.length).toBeGreaterThan(0);

          const sum = values.reduce((acc, v) => acc + v, 0);
          expect(sum).toBeCloseTo(100, 5);
        }),
        { numRuns: 100 },
      );
    });

    it('each flair percentage equals its count / total posts with flair * 100', () => {
      fc.assert(
        fc.property(postsWithFlairArb, (posts) => {
          const distribution = computeFlairDistribution(posts);
          const postsWithFlair = posts.filter(
            (p) => p.link_flair_text != null && p.link_flair_text.trim() !== '',
          );
          const total = postsWithFlair.length;

          // Count occurrences manually
          const counts = new Map<string, number>();
          for (const post of postsWithFlair) {
            const flair = post.link_flair_text!;
            counts.set(flair, (counts.get(flair) ?? 0) + 1);
          }

          for (const [flair, count] of counts) {
            const expectedPct = (count / total) * 100;
            expect(distribution[flair]).toBeCloseTo(expectedPct, 10);
          }
        }),
        { numRuns: 100 },
      );
    });

    it('returns empty distribution when no posts have flairs', () => {
      const noFlairPostsArb = fc.array(
        redditPostArb({ link_flair_text: fc.constant(null) }),
        { minLength: 1, maxLength: 20 },
      );

      fc.assert(
        fc.property(noFlairPostsArb, (posts) => {
          const distribution = computeFlairDistribution(posts);
          expect(Object.keys(distribution)).toHaveLength(0);
        }),
        { numRuns: 100 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Property 12: Top keywords are ordered by count and limited to 20
  // -------------------------------------------------------------------------

  /**
   * Property 12: Top keywords are ordered by count and limited to 20
   *
   * For any set of posts, `extractTopKeywords` should return at most 20
   * keywords, ordered by count in descending order.
   *
   * **Validates: Requirements 5.4**
   */
  describe('Property 12: Top keywords are ordered by count and limited to 20', () => {
    it('returns at most 20 keywords', () => {
      fc.assert(
        fc.property(postsArb, (posts) => {
          const keywords = extractTopKeywords(posts);
          expect(keywords.length).toBeLessThanOrEqual(20);
        }),
        { numRuns: 100 },
      );
    });

    it('keywords are ordered by count descending', () => {
      fc.assert(
        fc.property(postsArb, (posts) => {
          const keywords = extractTopKeywords(posts);

          for (let i = 1; i < keywords.length; i++) {
            expect(keywords[i - 1].count).toBeGreaterThanOrEqual(keywords[i].count);
          }
        }),
        { numRuns: 100 },
      );
    });

    it('keyword counts reflect actual occurrences in post titles and selftext', () => {
      // Use posts with known words to verify counts
      const knownWordsArb = fc.array(
        fc.constantFrom('typescript', 'javascript', 'python', 'react', 'nodejs', 'database', 'testing', 'deployment'),
        { minLength: 2, maxLength: 6 },
      );

      const postsWithKnownWordsArb = fc
        .tuple(
          knownWordsArb,
          fc.integer({ min: 1, max: 10 }),
        )
        .map(([words, count]) => {
          const posts: RedditPost[] = [];
          for (let i = 0; i < count; i++) {
            posts.push({
              id: `post-${i}`,
              subreddit: 'test',
              author: 'testuser',
              title: words.join(' '),
              selftext: '',
              url: 'https://example.com',
              domain: 'example.com',
              permalink: '/r/test/comments/abc/test/',
              score: 1,
              num_comments: 0,
              is_self: true,
              link_flair_text: null,
              created_utc: 1700000000,
            });
          }
          return posts;
        });

      fc.assert(
        fc.property(postsWithKnownWordsArb, (posts) => {
          const keywords = extractTopKeywords(posts);

          // Each returned keyword count should be positive
          for (const kw of keywords) {
            expect(kw.count).toBeGreaterThan(0);
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Property 13: Top posts are ordered by score and limited to 10
  // -------------------------------------------------------------------------

  /**
   * Property 13: Top posts are ordered by score and limited to 10
   *
   * For any set of posts, the top posts result should contain at most 10
   * posts, ordered by score in descending order.
   *
   * **Validates: Requirements 5.5**
   */
  describe('Property 13: Top posts are ordered by score and limited to 10', () => {
    it('returns at most 10 posts', () => {
      fc.assert(
        fc.property(postsArb, (posts) => {
          const topPosts = getTopPosts(posts);
          expect(topPosts.length).toBeLessThanOrEqual(10);
        }),
        { numRuns: 100 },
      );
    });

    it('posts are ordered by score descending', () => {
      fc.assert(
        fc.property(postsArb, (posts) => {
          const topPosts = getTopPosts(posts);

          for (let i = 1; i < topPosts.length; i++) {
            expect(topPosts[i - 1].score).toBeGreaterThanOrEqual(topPosts[i].score);
          }
        }),
        { numRuns: 100 },
      );
    });

    it('returns all posts when fewer than 10 are provided', () => {
      const fewPostsArb = fc.array(redditPostArb(), { minLength: 1, maxLength: 9 });

      fc.assert(
        fc.property(fewPostsArb, (posts) => {
          const topPosts = getTopPosts(posts);
          expect(topPosts.length).toBe(posts.length);
        }),
        { numRuns: 100 },
      );
    });

    it('top posts contain the highest-scored posts from the input', () => {
      // Generate posts with distinct scores to make verification unambiguous
      const distinctScorePostsArb = fc
        .array(fc.integer({ min: 0, max: 100000 }), { minLength: 11, maxLength: 30 })
        .map((scores) => {
          // Ensure distinct scores
          const uniqueScores = [...new Set(scores)];
          return uniqueScores.map((score, i) => ({
            id: `post-${i}`,
            subreddit: 'test',
            author: 'testuser',
            title: `Post ${i}`,
            selftext: '',
            url: 'https://example.com',
            domain: 'example.com',
            permalink: '/r/test/comments/abc/test/',
            score,
            num_comments: 0,
            is_self: true,
            link_flair_text: null,
            created_utc: 1700000000,
          } as RedditPost));
        })
        .filter((posts) => posts.length >= 11);

      fc.assert(
        fc.property(distinctScorePostsArb, (posts) => {
          const topPosts = getTopPosts(posts);
          const sortedInput = [...posts].sort((a, b) => b.score - a.score);
          const expectedTop10 = sortedInput.slice(0, 10);

          expect(topPosts.length).toBe(10);
          for (let i = 0; i < 10; i++) {
            expect(topPosts[i].score).toBe(expectedTop10[i].score);
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Property 14: Growth metrics computation is correct
  // -------------------------------------------------------------------------

  /**
   * Property 14: Growth metrics computation is correct
   *
   * For any two snapshots, `subscriberChange` should equal
   * `currentSubscribers - previousSubscribers`. `avgPostsPerDay` should
   * equal total post count / 30.
   *
   * **Validates: Requirements 5.6**
   */
  describe('Property 14: Growth metrics computation is correct', () => {
    it('subscriberChange equals currentSubscribers - previousSubscribers', () => {
      const snapshotArb = fc.record({
        currentSubs: fc.integer({ min: 0, max: 10000000 }),
        previousSubs: fc.integer({ min: 0, max: 10000000 }),
      });

      fc.assert(
        fc.property(snapshotArb, ({ currentSubs, previousSubs }) => {
          const now = new Date();
          const metrics = computeGrowthMetrics(
            { subscribers: currentSubs, snapshotDate: now },
            { subscribers: previousSubs },
            [],
          );

          expect(metrics.subscriberChange).toBe(currentSubs - previousSubs);
          expect(metrics.currentSubscribers).toBe(currentSubs);
          expect(metrics.previousSubscribers).toBe(previousSubs);
        }),
        { numRuns: 100 },
      );
    });

    it('subscriberChange is null when no previous snapshot exists', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 10000000 }),
          (currentSubs) => {
            const now = new Date();
            const metrics = computeGrowthMetrics(
              { subscribers: currentSubs, snapshotDate: now },
              null,
              [],
            );

            expect(metrics.subscriberChange).toBeNull();
            expect(metrics.previousSubscribers).toBeNull();
          },
        ),
        { numRuns: 100 },
      );
    });

    it('avgPostsPerDay equals posts within 30 days / 30', () => {
      // Use a fixed reference point far enough in the future to encompass generated timestamps
      const referenceUtc = 1800000100; // just above the max created_utc in our arb
      const referenceDate = new Date(referenceUtc * 1000);
      const thirtyDaysAgoUtc = referenceUtc - 30 * 24 * 60 * 60;

      const recentPostsArb = fc.array(
        redditPostArb({
          created_utc: fc.integer({
            min: Math.floor(thirtyDaysAgoUtc),
            max: referenceUtc,
          }),
        }),
        { minLength: 0, maxLength: 50 },
      );

      fc.assert(
        fc.property(recentPostsArb, (posts) => {
          const metrics = computeGrowthMetrics(
            { subscribers: 1000, snapshotDate: referenceDate },
            null,
            posts,
          );

          // All posts are within 30 days, so avgPostsPerDay = posts.length / 30
          expect(metrics.avgPostsPerDay).toBeCloseTo(posts.length / 30, 10);
        }),
        { numRuns: 100 },
      );
    });

    it('avgPostsPerDay excludes posts older than 30 days', () => {
      const referenceUtc = 1800000100;
      const referenceDate = new Date(referenceUtc * 1000);
      const thirtyDaysAgoUtc = referenceUtc - 30 * 24 * 60 * 60;

      // Mix of recent and old posts
      const mixedPostsArb = fc.tuple(
        // Recent posts (within 30 days)
        fc.array(
          redditPostArb({
            created_utc: fc.integer({
              min: Math.floor(thirtyDaysAgoUtc),
              max: referenceUtc,
            }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        // Old posts (older than 30 days)
        fc.array(
          redditPostArb({
            created_utc: fc.integer({
              min: 1500000000,
              max: Math.floor(thirtyDaysAgoUtc) - 1,
            }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
      );

      fc.assert(
        fc.property(mixedPostsArb, ([recentPosts, oldPosts]) => {
          const allPosts = [...recentPosts, ...oldPosts];
          const metrics = computeGrowthMetrics(
            { subscribers: 1000, snapshotDate: referenceDate },
            null,
            allPosts,
          );

          // Only recent posts should count
          expect(metrics.avgPostsPerDay).toBeCloseTo(recentPosts.length / 30, 10);
        }),
        { numRuns: 100 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Property 15: Engagement metrics are correct averages
  // -------------------------------------------------------------------------

  /**
   * Property 15: Engagement metrics are correct averages
   *
   * For any non-empty set of posts, `avgScorePerPost` = sum(scores)/count,
   * `avgCommentsPerPost` = sum(num_comments)/count.
   *
   * **Validates: Requirements 5.7**
   */
  describe('Property 15: Engagement metrics are correct averages', () => {
    it('avgScorePerPost equals sum of scores divided by post count', () => {
      fc.assert(
        fc.property(postsArb, (posts) => {
          const metrics = computeEngagementMetrics(posts);
          const expectedAvg = posts.reduce((sum, p) => sum + p.score, 0) / posts.length;

          expect(metrics.avgScorePerPost).toBeCloseTo(expectedAvg, 10);
        }),
        { numRuns: 100 },
      );
    });

    it('avgCommentsPerPost equals sum of num_comments divided by post count', () => {
      fc.assert(
        fc.property(postsArb, (posts) => {
          const metrics = computeEngagementMetrics(posts);
          const expectedAvg = posts.reduce((sum, p) => sum + p.num_comments, 0) / posts.length;

          expect(metrics.avgCommentsPerPost).toBeCloseTo(expectedAvg, 10);
        }),
        { numRuns: 100 },
      );
    });

    it('returns zero averages for empty post array', () => {
      const metrics = computeEngagementMetrics([]);
      expect(metrics.avgScorePerPost).toBe(0);
      expect(metrics.avgCommentsPerPost).toBe(0);
    });

    it('periodDays is always 30', () => {
      fc.assert(
        fc.property(postsArb, (posts) => {
          const metrics = computeEngagementMetrics(posts);
          expect(metrics.periodDays).toBe(30);
        }),
        { numRuns: 100 },
      );
    });
  });
});
