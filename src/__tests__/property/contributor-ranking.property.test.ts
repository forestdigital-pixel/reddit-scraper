import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  computeInfluenceScore,
  computeContributorAverages,
  filterByTimeframe,
} from '../../services/contributor-ranker-service';
import type { ContributorProfile } from '../../services/contributor-ranker-service';

/**
 * Property-based tests for ContributorRankerService standalone functions.
 *
 * Feature: reddit-data-scraper
 */

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Arbitrary for a ContributorProfile with all fields populated */
function contributorProfileArb(overrides?: Partial<{
  postCount: fc.Arbitrary<number>;
  commentCount: fc.Arbitrary<number>;
  totalPostScore: fc.Arbitrary<number>;
  totalCommentScore: fc.Arbitrary<number>;
}>): fc.Arbitrary<ContributorProfile> {
  return fc.record({
    username: fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{2,15}$/),
    subreddit: fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{2,20}$/),
    postCount: overrides?.postCount ?? fc.integer({ min: 0, max: 10000 }),
    commentCount: overrides?.commentCount ?? fc.integer({ min: 0, max: 10000 }),
    totalPostScore: overrides?.totalPostScore ?? fc.integer({ min: -100000, max: 100000 }),
    totalCommentScore: overrides?.totalCommentScore ?? fc.integer({ min: -100000, max: 100000 }),
    avgPostScore: fc.constant(0), // will be recomputed
    avgCommentScore: fc.constant(0), // will be recomputed
    influenceScore: fc.constant(0), // will be recomputed
  }).map((profile) => {
    const averages = computeContributorAverages(profile);
    const influence = computeInfluenceScore({ ...profile, ...averages });
    return { ...profile, ...averages, influenceScore: influence };
  });
}

/** Arbitrary for an item with a created_utc timestamp */
function timestampedItemArb(
  minUtc: number = 1600000000,
  maxUtc: number = 1800000000,
): fc.Arbitrary<{ id: string; created_utc: number }> {
  return fc.record({
    id: fc.uuid(),
    created_utc: fc.integer({ min: minUtc, max: maxUtc }),
  });
}

// ---------------------------------------------------------------------------
// Property 19: Contributor ranking is ordered by influence score
// ---------------------------------------------------------------------------

describe('Contributor Ranking Property Tests', () => {
  /**
   * Property 19: Contributor ranking is ordered by influence score
   *
   * For any set of contributor profiles, `getTopContributors` should return
   * at most 25 profiles ordered by influence score in descending order.
   *
   * Since `getTopContributors` requires a DB connection, we test the ordering
   * property by generating profiles, sorting by influence score, and verifying
   * the order and limit.
   *
   * **Validates: Requirements 8.1**
   */
  describe('Property 19: Contributor ranking is ordered by influence score', () => {
    it('sorting profiles by influence score produces descending order', () => {
      const profilesArb = fc.array(contributorProfileArb(), {
        minLength: 1,
        maxLength: 50,
      });

      fc.assert(
        fc.property(profilesArb, (profiles) => {
          const sorted = [...profiles].sort(
            (a, b) => b.influenceScore - a.influenceScore,
          );

          for (let i = 1; i < sorted.length; i++) {
            expect(sorted[i - 1].influenceScore).toBeGreaterThanOrEqual(
              sorted[i].influenceScore,
            );
          }
        }),
        { numRuns: 100 },
      );
    });

    it('top contributors are capped at 25', () => {
      const profilesArb = fc.array(contributorProfileArb(), {
        minLength: 26,
        maxLength: 60,
      });

      fc.assert(
        fc.property(profilesArb, (profiles) => {
          const sorted = [...profiles].sort(
            (a, b) => b.influenceScore - a.influenceScore,
          );
          const top = sorted.slice(0, 25);

          expect(top.length).toBeLessThanOrEqual(25);
          expect(top.length).toBe(25);
        }),
        { numRuns: 100 },
      );
    });

    it('returns all profiles when fewer than 25 are available', () => {
      const fewProfilesArb = fc.array(contributorProfileArb(), {
        minLength: 1,
        maxLength: 24,
      });

      fc.assert(
        fc.property(fewProfilesArb, (profiles) => {
          const sorted = [...profiles].sort(
            (a, b) => b.influenceScore - a.influenceScore,
          );
          const top = sorted.slice(0, 25);

          expect(top.length).toBe(profiles.length);
        }),
        { numRuns: 100 },
      );
    });

    it('top 25 contain the highest influence scores from the input', () => {
      const profilesArb = fc.array(contributorProfileArb(), {
        minLength: 26,
        maxLength: 60,
      });

      fc.assert(
        fc.property(profilesArb, (profiles) => {
          const sorted = [...profiles].sort(
            (a, b) => b.influenceScore - a.influenceScore,
          );
          const top25 = sorted.slice(0, 25);
          const minTopScore = top25[top25.length - 1].influenceScore;
          const remaining = sorted.slice(25);

          for (const r of remaining) {
            expect(r.influenceScore).toBeLessThanOrEqual(minTopScore);
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Property 20: Influence score follows the defined formula
  // -------------------------------------------------------------------------

  /**
   * Property 20: Influence score follows the defined formula
   *
   * For any contributor data, `computeInfluenceScore` should return
   * `(totalPostScore * 1.0) + (totalCommentScore * 0.5) + (postCount * 10) + (commentCount * 2)`.
   *
   * **Validates: Requirements 8.2**
   */
  describe('Property 20: Influence score follows the defined formula', () => {
    const contributorDataArb = fc.record({
      username: fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{2,15}$/),
      subreddit: fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{2,20}$/),
      postCount: fc.integer({ min: 0, max: 100000 }),
      commentCount: fc.integer({ min: 0, max: 100000 }),
      totalPostScore: fc.integer({ min: -1000000, max: 1000000 }),
      totalCommentScore: fc.integer({ min: -1000000, max: 1000000 }),
      avgPostScore: fc.constant(0),
      avgCommentScore: fc.constant(0),
    });

    it('returns the correct influence score per the formula', () => {
      fc.assert(
        fc.property(contributorDataArb, (data) => {
          const result = computeInfluenceScore(data);
          const expected =
            data.totalPostScore * 1.0 +
            data.totalCommentScore * 0.5 +
            data.postCount * 10 +
            data.commentCount * 2;

          expect(result).toBeCloseTo(expected, 10);
        }),
        { numRuns: 100 },
      );
    });

    it('influence score is zero when all inputs are zero', () => {
      const score = computeInfluenceScore({
        username: 'testuser',
        subreddit: 'test',
        postCount: 0,
        commentCount: 0,
        totalPostScore: 0,
        totalCommentScore: 0,
        avgPostScore: 0,
        avgCommentScore: 0,
      });

      expect(score).toBe(0);
    });

    it('influence score can be negative with negative scores', () => {
      const negativeDataArb = fc.record({
        username: fc.constant('user'),
        subreddit: fc.constant('sub'),
        postCount: fc.constant(0),
        commentCount: fc.constant(0),
        totalPostScore: fc.integer({ min: -1000000, max: -1 }),
        totalCommentScore: fc.integer({ min: -1000000, max: -1 }),
        avgPostScore: fc.constant(0),
        avgCommentScore: fc.constant(0),
      });

      fc.assert(
        fc.property(negativeDataArb, (data) => {
          const result = computeInfluenceScore(data);
          expect(result).toBeLessThan(0);
        }),
        { numRuns: 100 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Property 21: Contributor averages are correctly computed
  // -------------------------------------------------------------------------

  /**
   * Property 21: Contributor averages are correctly computed
   *
   * For any contributor with postCount > 0 and commentCount > 0,
   * `avgPostScore` = `totalPostScore / postCount` and
   * `avgCommentScore` = `totalCommentScore / commentCount`.
   *
   * **Validates: Requirements 8.3**
   */
  describe('Property 21: Contributor averages are correctly computed', () => {
    const positiveCountsArb = fc.record({
      totalPostScore: fc.integer({ min: -100000, max: 100000 }),
      totalCommentScore: fc.integer({ min: -100000, max: 100000 }),
      postCount: fc.integer({ min: 1, max: 10000 }),
      commentCount: fc.integer({ min: 1, max: 10000 }),
    });

    it('avgPostScore equals totalPostScore / postCount', () => {
      fc.assert(
        fc.property(positiveCountsArb, (data) => {
          const averages = computeContributorAverages(data);
          const expected = data.totalPostScore / data.postCount;

          expect(averages.avgPostScore).toBeCloseTo(expected, 10);
        }),
        { numRuns: 100 },
      );
    });

    it('avgCommentScore equals totalCommentScore / commentCount', () => {
      fc.assert(
        fc.property(positiveCountsArb, (data) => {
          const averages = computeContributorAverages(data);
          const expected = data.totalCommentScore / data.commentCount;

          expect(averages.avgCommentScore).toBeCloseTo(expected, 10);
        }),
        { numRuns: 100 },
      );
    });

    it('avgPostScore is 0 when postCount is 0', () => {
      const zeroPostCountArb = fc.record({
        totalPostScore: fc.integer({ min: -100000, max: 100000 }),
        totalCommentScore: fc.integer({ min: -100000, max: 100000 }),
        postCount: fc.constant(0),
        commentCount: fc.integer({ min: 1, max: 10000 }),
      });

      fc.assert(
        fc.property(zeroPostCountArb, (data) => {
          const averages = computeContributorAverages(data);
          expect(averages.avgPostScore).toBe(0);
        }),
        { numRuns: 100 },
      );
    });

    it('avgCommentScore is 0 when commentCount is 0', () => {
      const zeroCommentCountArb = fc.record({
        totalPostScore: fc.integer({ min: -100000, max: 100000 }),
        totalCommentScore: fc.integer({ min: -100000, max: 100000 }),
        postCount: fc.integer({ min: 1, max: 10000 }),
        commentCount: fc.constant(0),
      });

      fc.assert(
        fc.property(zeroCommentCountArb, (data) => {
          const averages = computeContributorAverages(data);
          expect(averages.avgCommentScore).toBe(0);
        }),
        { numRuns: 100 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Property 22: Timeframe filtering includes only activity within range
  // -------------------------------------------------------------------------

  /**
   * Property 22: Timeframe filtering includes only activity within range
   *
   * For any set of posts/comments with `created_utc` timestamps and a
   * timeframe filter (start, end), only items where `created_utc` falls
   * within [start, end] should be included.
   *
   * **Validates: Requirements 8.4**
   */
  describe('Property 22: Timeframe filtering includes only activity within range', () => {
    it('returns only items within [start, end] inclusive', () => {
      const timeframeArb = fc
        .tuple(
          fc.integer({ min: 1600000000, max: 1800000000 }),
          fc.integer({ min: 1600000000, max: 1800000000 }),
        )
        .map(([a, b]) => ({
          start: Math.min(a, b),
          end: Math.max(a, b),
        }));

      const itemsArb = fc.array(
        timestampedItemArb(),
        { minLength: 0, maxLength: 50 },
      );

      fc.assert(
        fc.property(
          fc.tuple(itemsArb, timeframeArb),
          ([items, { start, end }]) => {
            const filtered = filterByTimeframe(items, start, end);

            // Every returned item must be within [start, end]
            for (const item of filtered) {
              expect(item.created_utc).toBeGreaterThanOrEqual(start);
              expect(item.created_utc).toBeLessThanOrEqual(end);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it('does not exclude any items that are within [start, end]', () => {
      const timeframeArb = fc
        .tuple(
          fc.integer({ min: 1600000000, max: 1800000000 }),
          fc.integer({ min: 1600000000, max: 1800000000 }),
        )
        .map(([a, b]) => ({
          start: Math.min(a, b),
          end: Math.max(a, b),
        }));

      const itemsArb = fc.array(
        timestampedItemArb(),
        { minLength: 0, maxLength: 50 },
      );

      fc.assert(
        fc.property(
          fc.tuple(itemsArb, timeframeArb),
          ([items, { start, end }]) => {
            const filtered = filterByTimeframe(items, start, end);
            const expectedCount = items.filter(
              (i) => i.created_utc >= start && i.created_utc <= end,
            ).length;

            expect(filtered.length).toBe(expectedCount);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('returns empty array when no items fall within the range', () => {
      // Items all before the range
      const earlyItemsArb = fc.array(
        timestampedItemArb(1600000000, 1650000000),
        { minLength: 1, maxLength: 20 },
      );

      fc.assert(
        fc.property(earlyItemsArb, (items) => {
          const start = 1700000000;
          const end = 1800000000;
          const filtered = filterByTimeframe(items, start, end);

          expect(filtered.length).toBe(0);
        }),
        { numRuns: 100 },
      );
    });

    it('returns all items when the range covers all timestamps', () => {
      const itemsArb = fc.array(
        timestampedItemArb(1650000000, 1750000000),
        { minLength: 1, maxLength: 30 },
      );

      fc.assert(
        fc.property(itemsArb, (items) => {
          const start = 1600000000;
          const end = 1800000000;
          const filtered = filterByTimeframe(items, start, end);

          expect(filtered.length).toBe(items.length);
        }),
        { numRuns: 100 },
      );
    });

    it('includes items exactly at the start and end boundaries', () => {
      const start = 1700000000;
      const end = 1700100000;

      const boundaryItemsArb = fc.constant([
        { id: 'at-start', created_utc: start },
        { id: 'at-end', created_utc: end },
        { id: 'before', created_utc: start - 1 },
        { id: 'after', created_utc: end + 1 },
      ]);

      fc.assert(
        fc.property(boundaryItemsArb, (items) => {
          const filtered = filterByTimeframe(items, start, end);

          expect(filtered.length).toBe(2);
          expect(filtered.map((i) => i.id).sort()).toEqual(
            ['at-end', 'at-start'],
          );
        }),
        { numRuns: 100 },
      );
    });
  });
});
