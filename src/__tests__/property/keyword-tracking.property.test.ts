import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  computeDailyFrequencies,
  matchesKeyword,
} from '../../services/keyword-tracker-service';
import {
  ThemeClassifierService,
  THEME_DICTIONARIES,
  type RedditContent,
} from '../../services/theme-classifier-service';
import type { ConversationTheme } from '../../models/database';

/**
 * Property-based tests for keyword tracking and theme summary.
 *
 * Feature: reddit-data-scraper
 */

const themeService = new ThemeClassifierService();

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Arbitrary for a random Date within a reasonable range (2020-2025) */
const dateArb: fc.Arbitrary<Date> = fc
  .integer({
    min: new Date('2020-01-01').getTime(),
    max: new Date('2025-12-31').getTime(),
  })
  .map((ts) => new Date(ts));

/** Arbitrary for a keyword match object with a matchedAt timestamp */
const keywordMatchArb: fc.Arbitrary<{ matchedAt: Date }> = dateArb.map(
  (d) => ({ matchedAt: d }),
);

/** Arbitrary for a non-empty lowercase keyword (letters only, 2-10 chars) */
const keywordArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), {
    minLength: 2,
    maxLength: 10,
  })
  .map((chars) => chars.join(''));

/** Random filler word that does NOT appear in any theme dictionary */
const fillerWordArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), {
    minLength: 8,
    maxLength: 14,
  })
  .map((chars) => chars.join(''))
  .filter((word) => {
    const lower = word.toLowerCase();
    return !THEME_DICTIONARIES.some(
      (d) =>
        d.keywords.includes(lower) ||
        d.phrases.some((p) => p.includes(lower)),
    );
  });

// ---------------------------------------------------------------------------
// Property 7: Daily keyword frequency equals match count
// ---------------------------------------------------------------------------

describe('Keyword Tracking Property Tests', () => {
  /**
   * Property 7: Daily keyword frequency equals match count
   *
   * For any set of keyword matches with timestamps, the recorded daily
   * frequency for each day should equal the number of matches whose
   * timestamp falls on that day.
   *
   * **Validates: Requirements 3.2**
   */
  describe('Property 7: Daily keyword frequency equals match count', () => {
    it('daily frequency equals the count of matches on that day', () => {
      fc.assert(
        fc.property(
          fc.array(keywordMatchArb, { minLength: 1, maxLength: 100 }),
          (matches) => {
            const freqMap = computeDailyFrequencies(matches);

            // Manually count matches per day
            const expectedCounts = new Map<string, number>();
            for (const m of matches) {
              const day = m.matchedAt.toISOString().slice(0, 10);
              expectedCounts.set(day, (expectedCounts.get(day) ?? 0) + 1);
            }

            // Verify every day in the expected map is present with the correct count
            for (const [day, expectedCount] of expectedCounts) {
              expect(freqMap.get(day)).toBe(expectedCount);
            }

            // Verify no extra days exist in the frequency map
            expect(freqMap.size).toBe(expectedCounts.size);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('total frequency across all days equals total number of matches', () => {
      fc.assert(
        fc.property(
          fc.array(keywordMatchArb, { minLength: 1, maxLength: 100 }),
          (matches) => {
            const freqMap = computeDailyFrequencies(matches);

            let totalFreq = 0;
            for (const count of freqMap.values()) {
              totalFreq += count;
            }

            expect(totalFreq).toBe(matches.length);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('returns an empty map for an empty array of matches', () => {
      const freqMap = computeDailyFrequencies([]);
      expect(freqMap.size).toBe(0);
    });

    it('matches on the same day are grouped correctly', () => {
      fc.assert(
        fc.property(
          // Generate multiple matches on the same UTC day
          fc.tuple(
            fc.integer({ min: 2020, max: 2025 }),
            fc.integer({ min: 1, max: 12 }),
            fc.integer({ min: 1, max: 28 }),
            fc.integer({ min: 2, max: 20 }),
          ),
          ([year, month, day, count]) => {
            // Use Date.UTC to ensure all timestamps fall on the same UTC day
            const baseMs = Date.UTC(year, month - 1, day, 0, 0, 0);
            const matches = Array.from({ length: count }, (_, i) => ({
              matchedAt: new Date(baseMs + (i % 24) * 3600_000),
            }));

            const freqMap = computeDailyFrequencies(matches);

            // All matches should be on the same UTC day
            expect(freqMap.size).toBe(1);

            const dayKey = matches[0].matchedAt.toISOString().slice(0, 10);
            expect(freqMap.get(dayKey)).toBe(count);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Property 8: Keyword match results all contain the keyword
  // -------------------------------------------------------------------------

  /**
   * Property 8: Keyword match results all contain the keyword
   *
   * For any tracked keyword and a set of Reddit posts/comments, the
   * returned matches should all contain the keyword in their title or
   * body text.
   *
   * **Validates: Requirements 3.4**
   */
  describe('Property 8: Keyword match results all contain the keyword', () => {
    it('matchesKeyword returns true when text contains the keyword (case-insensitive)', () => {
      fc.assert(
        fc.property(
          keywordArb,
          fc.array(fillerWordArb, { minLength: 1, maxLength: 10 }),
          fc.integer({ min: 0, max: 10 }),
          (keyword, fillerWords, insertPos) => {
            // Insert the keyword into the filler text at a random position
            const pos = Math.min(insertPos, fillerWords.length);
            const words = [...fillerWords];
            words.splice(pos, 0, keyword);
            const text = words.join(' ');

            expect(matchesKeyword(text, keyword)).toBe(true);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('matchesKeyword returns false when text does not contain the keyword', () => {
      fc.assert(
        fc.property(
          keywordArb,
          fc.array(fillerWordArb, { minLength: 1, maxLength: 10 }),
          (keyword, fillerWords) => {
            // Ensure none of the filler words contain the keyword
            const safeWords = fillerWords.filter(
              (w) => !w.toLowerCase().includes(keyword.toLowerCase()),
            );
            if (safeWords.length === 0) return; // skip degenerate case

            const text = safeWords.join(' ');
            expect(matchesKeyword(text, keyword)).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('matchesKeyword is case-insensitive', () => {
      fc.assert(
        fc.property(
          keywordArb,
          fc.array(fillerWordArb, { minLength: 1, maxLength: 5 }),
          (keyword, fillerWords) => {
            // Insert keyword in UPPER case
            const upperKeyword = keyword.toUpperCase();
            const text = [...fillerWords, upperKeyword].join(' ');

            expect(matchesKeyword(text, keyword)).toBe(true);
            expect(matchesKeyword(text, keyword.toLowerCase())).toBe(true);
            expect(matchesKeyword(text, keyword.toUpperCase())).toBe(true);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('matchesKeyword returns false for empty keyword', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 100 }), (text) => {
          expect(matchesKeyword(text, '')).toBe(false);
        }),
        { numRuns: 100 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Property 9: Theme summary ranks items by frequency descending
  // -------------------------------------------------------------------------

  /**
   * Property 9: Theme summary ranks items by frequency descending
   *
   * For any set of posts classified under a theme (pain_points or
   * solution_requests), the summary should list items ordered by
   * frequency of occurrence in descending order.
   *
   * **Validates: Requirements 4.2, 4.3, 4.4**
   */
  describe('Property 9: Theme summary ranks items by frequency descending', () => {
    /** Themes relevant to audience research (pain_points and solution_requests) */
    const audienceThemeArb: fc.Arbitrary<ConversationTheme> = fc.constantFrom(
      'pain_points' as const,
      'solution_requests' as const,
    );

    /**
     * Generate RedditContent items that contain keywords from a specific theme
     * so they will be classified under that theme.
     */
    const themedContentArb = (theme: ConversationTheme): fc.Arbitrary<RedditContent[]> => {
      const dict = THEME_DICTIONARIES.find((d) => d.theme === theme)!;
      // Use high-weight keywords to ensure classification exceeds threshold
      const weightedKeywords = dict.keywords.filter(
        (kw) => (dict.weights[kw] ?? 0) >= 1.0,
      );
      const pool = weightedKeywords.length >= 5 ? weightedKeywords : dict.keywords;

      return fc
        .array(
          fc.tuple(
            fc.uuid(),
            // Pick 3-6 keywords from the theme to embed in text
            fc.shuffledSubarray(pool, {
              minLength: 3,
              maxLength: Math.min(6, pool.length),
            }),
            fc.array(fillerWordArb, { minLength: 1, maxLength: 3 }),
            fc.constantFrom('post' as const, 'comment' as const),
          ),
          { minLength: 2, maxLength: 15 },
        )
        .map((items) =>
          items.map(([id, keywords, filler, contentType]) => ({
            id,
            text: [...filler, ...keywords].sort(() => Math.random() - 0.5).join(' '),
            contentType,
          })),
        );
    };

    it('topPhrases are sorted by count in descending order', () => {
      fc.assert(
        fc.property(
          audienceThemeArb.chain((theme) =>
            themedContentArb(theme).map((items) => ({ theme, items })),
          ),
          ({ theme, items }) => {
            const summary = themeService.summarizeThemes(items, theme);

            // Verify topPhrases are sorted by count descending
            for (let i = 1; i < summary.topPhrases.length; i++) {
              expect(summary.topPhrases[i - 1].count).toBeGreaterThanOrEqual(
                summary.topPhrases[i].count,
              );
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it('each phrase count is positive', () => {
      fc.assert(
        fc.property(
          audienceThemeArb.chain((theme) =>
            themedContentArb(theme).map((items) => ({ theme, items })),
          ),
          ({ theme, items }) => {
            const summary = themeService.summarizeThemes(items, theme);

            for (const phrase of summary.topPhrases) {
              expect(phrase.count).toBeGreaterThan(0);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it('totalItems reflects the number of items matching the theme', () => {
      fc.assert(
        fc.property(
          audienceThemeArb.chain((theme) =>
            themedContentArb(theme).map((items) => ({ theme, items })),
          ),
          ({ theme, items }) => {
            // Classify items first
            themeService.classifyBatch(items);

            const summary = themeService.summarizeThemes(items, theme);
            const matchingItems = themeService.filterByTheme(items, theme);

            expect(summary.totalItems).toBe(matchingItems.length);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('returns empty topPhrases for a theme with no matching items', () => {
      // Generate items with only filler text (no theme keywords)
      const noThemeItemsArb: fc.Arbitrary<RedditContent[]> = fc
        .array(
          fc.tuple(
            fc.uuid(),
            fc.array(fillerWordArb, { minLength: 3, maxLength: 8 }),
            fc.constantFrom('post' as const, 'comment' as const),
          ),
          { minLength: 1, maxLength: 10 },
        )
        .map((items) =>
          items.map(([id, words, contentType]) => ({
            id,
            text: words.join(' '),
            contentType,
          })),
        );

      fc.assert(
        fc.property(
          audienceThemeArb,
          noThemeItemsArb,
          (theme, items) => {
            const summary = themeService.summarizeThemes(items, theme);

            expect(summary.totalItems).toBe(0);
            expect(summary.topPhrases).toHaveLength(0);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
