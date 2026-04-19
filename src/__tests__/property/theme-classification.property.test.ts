import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  classify,
  ThemeClassifierService,
  THEME_DICTIONARIES,
  type RedditContent,
} from '../../services/theme-classifier-service';
import type { ConversationTheme } from '../../models/database';

/**
 * Property-based tests for ThemeClassifierService.
 *
 * Feature: reddit-data-scraper
 */

const service = new ThemeClassifierService();

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** All classifiable (non-uncategorized) themes */
const classifiableThemes: ConversationTheme[] = THEME_DICTIONARIES.map((d) => d.theme);

/** Arbitrary that picks one classifiable theme */
const themeArb: fc.Arbitrary<ConversationTheme> = fc.constantFrom(...classifiableThemes);

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

/** Generate a short filler sentence from random words that contain no theme keywords */
const fillerSentenceArb: fc.Arbitrary<string> = fc
  .array(fillerWordArb, { minLength: 3, maxLength: 8 })
  .map((words) => words.join(' '));

// ---------------------------------------------------------------------------
// Property 3: Theme classification assigns correct themes for keyword-bearing text
// ---------------------------------------------------------------------------

describe('Theme Classification Property Tests', () => {
  /**
   * Property 3: Theme classification assigns correct themes for keyword-bearing text
   *
   * For any text containing keywords from one or more theme dictionaries,
   * the ThemeClassifierService should assign all themes whose keywords are
   * present, and should not assign themes whose keywords are absent.
   *
   * **Validates: Requirements 2.1, 2.4**
   */
  describe('Property 3: Theme classification assigns correct themes for keyword-bearing text', () => {
    /**
     * Arbitrary that picks 1-3 themes, selects 3-5 keywords from each,
     * and embeds them in random filler text.
     */
    /**
     * To reliably exceed the 0.3 confidence threshold, we need enough
     * high-weight keywords relative to the total token count. The classifier
     * uses sigmoid normalization: confidence = rawScore / (rawScore + k)
     * where k = max(tokenCount * 0.3, 3). We use 5-8 keywords per theme
     * with only 2-4 filler words to keep the ratio favorable.
     */
    const keywordBearingTextArb = fc
      .tuple(
        // Pick 1-2 distinct themes (fewer themes = more keywords per theme)
        fc
          .shuffledSubarray(classifiableThemes, { minLength: 1, maxLength: 2 })
          .filter((arr) => arr.length >= 1),
        // Keep filler short so keywords dominate the token ratio
        fc.array(fillerWordArb, { minLength: 2, maxLength: 4 }),
      )
      .chain(([themes, fillerWords]) => {
        // For each selected theme, pick 5-8 keywords (prefer high-weight ones)
        const keywordArbs = themes.map((theme) => {
          const dict = THEME_DICTIONARIES.find((d) => d.theme === theme)!;
          // Use keywords that have weights defined (these are the impactful ones)
          const weightedKeywords = dict.keywords.filter((kw) => (dict.weights[kw] ?? 0) >= 1.0);
          const pool = weightedKeywords.length >= 5 ? weightedKeywords : dict.keywords;
          return fc
            .shuffledSubarray(pool, {
              minLength: 5,
              maxLength: Math.min(8, pool.length),
            })
            .map((keywords) => ({ theme, keywords }));
        });

        return fc.tuple(...keywordArbs).map((themeKeywords) => {
          // Build text: filler + keywords interleaved
          const allKeywords = themeKeywords.flatMap((tk) => tk.keywords);
          const words = [...fillerWords, ...allKeywords];
          // Shuffle to avoid positional bias
          const shuffled = words.sort(() => Math.random() - 0.5);
          return {
            text: shuffled.join(' '),
            expectedThemes: themeKeywords.map((tk) => tk.theme),
          };
        });
      });

    it('assigns all themes whose keywords are present in the text', () => {
      fc.assert(
        fc.property(keywordBearingTextArb, ({ text, expectedThemes }) => {
          const results = classify(text);
          const assignedThemes = results.map((r) => r.theme);

          for (const expected of expectedThemes) {
            expect(assignedThemes).toContain(expected);
          }
        }),
        { numRuns: 100 },
      );
    });

    it('does not assign themes whose keywords are absent from the text', () => {
      // Generate text with keywords from exactly one theme, verify other themes
      // are not assigned (unless their keywords happen to overlap).
      // Use 5-8 high-weight keywords with only 2-3 filler words to ensure
      // the confidence threshold (0.3) is exceeded.
      const singleThemeTextArb = fc
        .tuple(themeArb, fc.array(fillerWordArb, { minLength: 2, maxLength: 3 }))
        .chain(([theme, fillerWords]) => {
          const dict = THEME_DICTIONARIES.find((d) => d.theme === theme)!;
          const weightedKeywords = dict.keywords.filter((kw) => (dict.weights[kw] ?? 0) >= 1.0);
          const pool = weightedKeywords.length >= 5 ? weightedKeywords : dict.keywords;
          return fc
            .shuffledSubarray(pool, {
              minLength: 5,
              maxLength: Math.min(8, pool.length),
            })
            .map((keywords) => {
              const words = [...fillerWords, ...keywords];
              const shuffled = words.sort(() => Math.random() - 0.5);
              return { text: shuffled.join(' '), selectedTheme: theme, usedKeywords: keywords };
            });
        });

      fc.assert(
        fc.property(singleThemeTextArb, ({ text, selectedTheme, usedKeywords }) => {
          const results = classify(text);
          const assignedThemes = results.map((r) => r.theme);

          // The selected theme should be assigned
          expect(assignedThemes).toContain(selectedTheme);

          // For each OTHER theme that was assigned, verify the text actually
          // contains at least one keyword or phrase from that theme's dictionary
          const textLower = text.toLowerCase();
          for (const result of results) {
            if (result.theme === selectedTheme || result.theme === 'uncategorized') continue;
            const otherDict = THEME_DICTIONARIES.find((d) => d.theme === result.theme)!;
            const hasKeyword = otherDict.keywords.some((kw) => textLower.includes(kw));
            const hasPhrase = otherDict.phrases.some((p) => textLower.includes(p));
            expect(hasKeyword || hasPhrase).toBe(true);
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Property 4: Theme confidence scores are bounded
  // -------------------------------------------------------------------------

  /**
   * Property 4: Theme confidence scores are bounded
   *
   * For any input text, all confidence scores returned by the
   * ThemeClassifierService should be in the range [0.0, 1.0].
   *
   * **Validates: Requirements 2.2**
   */
  describe('Property 4: Theme confidence scores are bounded', () => {
    /** Arbitrary text: mix of random words, theme keywords, and phrases */
    const arbitraryTextArb: fc.Arbitrary<string> = fc.oneof(
      // Pure random text
      fc.string({ minLength: 1, maxLength: 200 }),
      // Text with theme keywords mixed in
      fc
        .tuple(
          fc.array(fillerWordArb, { minLength: 2, maxLength: 8 }),
          fc.array(
            fc.constantFrom(
              ...THEME_DICTIONARIES.flatMap((d) => d.keywords),
            ),
            { minLength: 0, maxLength: 10 },
          ),
        )
        .map(([filler, keywords]) => [...filler, ...keywords].join(' ')),
      // Heavily keyword-loaded text (stress test upper bound)
      fc
        .array(
          fc.constantFrom(
            ...THEME_DICTIONARIES.flatMap((d) => d.keywords),
          ),
          { minLength: 5, maxLength: 30 },
        )
        .map((keywords) => keywords.join(' ')),
    );

    it('all confidence scores are in [0.0, 1.0] for any input text', () => {
      fc.assert(
        fc.property(arbitraryTextArb, (text) => {
          const results = classify(text);

          for (const result of results) {
            expect(result.confidence).toBeGreaterThanOrEqual(0.0);
            expect(result.confidence).toBeLessThanOrEqual(1.0);
          }
        }),
        { numRuns: 100 },
      );
    });

    it('confidence scores are bounded even with engagement metadata boost', () => {
      const metadataArb = fc.record({
        score: fc.integer({ min: 0, max: 100000 }),
        num_comments: fc.integer({ min: 0, max: 50000 }),
      });

      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 200 }),
          metadataArb,
          (text, metadata) => {
            const results = classify(text, metadata);

            for (const result of results) {
              expect(result.confidence).toBeGreaterThanOrEqual(0.0);
              expect(result.confidence).toBeLessThanOrEqual(1.0);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Property 5: Theme filtering returns only matching content
  // -------------------------------------------------------------------------

  /**
   * Property 5: Theme filtering returns only matching content
   *
   * For any set of classified content items and a selected theme, filtering
   * by that theme should return only items that have been classified with
   * that theme, and should return all such items.
   *
   * **Validates: Requirements 2.3, 6.4**
   */
  describe('Property 5: Theme filtering returns only matching content', () => {
    /** Generate a RedditContent item with random text */
    const redditContentArb: fc.Arbitrary<RedditContent> = fc
      .tuple(
        fc.uuid(),
        fc.oneof(
          // Random filler (likely uncategorized)
          fillerSentenceArb,
          // Text with some theme keywords
          fc
            .tuple(
              fc.array(fillerWordArb, { minLength: 2, maxLength: 5 }),
              fc.array(
                fc.constantFrom(
                  ...THEME_DICTIONARIES.flatMap((d) => d.keywords),
                ),
                { minLength: 0, maxLength: 6 },
              ),
            )
            .map(([filler, kws]) => [...filler, ...kws].join(' ')),
        ),
        fc.constantFrom('post' as const, 'comment' as const),
      )
      .map(([id, text, contentType]) => ({
        id,
        text,
        contentType,
      }));

    const itemsArb = fc.array(redditContentArb, { minLength: 1, maxLength: 20 });

    /** All themes including uncategorized */
    const allThemeArb: fc.Arbitrary<ConversationTheme> = fc.constantFrom(
      'pain_points' as const,
      'solution_requests' as const,
      'money_talk' as const,
      'hot_discussions' as const,
      'seeking_alternatives' as const,
      'uncategorized' as const,
    );

    it('filterByTheme returns only items classified with the selected theme', () => {
      fc.assert(
        fc.property(itemsArb, allThemeArb, (items, theme) => {
          // Classify all items first
          service.classifyBatch(items);

          const filtered = service.filterByTheme(items, theme);

          // Every returned item must have the selected theme in its classifications
          for (const item of filtered) {
            const themes = (item.classifications ?? []).map((c) => c.theme);
            expect(themes).toContain(theme);
          }
        }),
        { numRuns: 100 },
      );
    });

    it('filterByTheme returns ALL items that have the selected theme', () => {
      fc.assert(
        fc.property(itemsArb, allThemeArb, (items, theme) => {
          // Classify all items first
          service.classifyBatch(items);

          const filtered = service.filterByTheme(items, theme);
          const filteredIds = new Set(filtered.map((item) => item.id));

          // Every item that has the theme should be in the filtered result
          for (const item of items) {
            const themes = (item.classifications ?? []).map((c) => c.theme);
            if (themes.includes(theme)) {
              expect(filteredIds).toContain(item.id);
            }
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Property 6: Low-confidence text is labeled uncategorized
  // -------------------------------------------------------------------------

  /**
   * Property 6: Low-confidence text is labeled uncategorized
   *
   * For any input text where no theme's confidence score exceeds 0.3,
   * the ThemeClassifierService should label the content as "uncategorized".
   *
   * **Validates: Requirements 2.5**
   */
  describe('Property 6: Low-confidence text is labeled uncategorized', () => {
    /**
     * Generate text with NO theme keywords — random alphanumeric words
     * that are guaranteed not to appear in any theme dictionary.
     */
    const noKeywordTextArb: fc.Arbitrary<string> = fc
      .array(
        fc
          .tuple(
            fc.constantFrom(...'bcdfghjklmnpqrstvwxyz'.split('')),
            fc.array(fc.constantFrom(...'0123456789'.split('')), {
              minLength: 2,
              maxLength: 4,
            }).map((arr) => arr.join('')),
            fc.constantFrom(...'bcdfghjklmnpqrstvwxyz'.split('')),
          )
          .map(([a, b, c]) => `${a}${b}${c}`),
        { minLength: 3, maxLength: 15 },
      )
      .map((words) => words.join(' '))
      .filter((text) => {
        // Double-check: no theme keyword or phrase appears in this text
        const lower = text.toLowerCase();
        return !THEME_DICTIONARIES.some(
          (d) =>
            d.keywords.some((kw) => lower.includes(kw)) ||
            d.phrases.some((p) => lower.includes(p)),
        );
      });

    it('text with no theme keywords is labeled uncategorized', () => {
      fc.assert(
        fc.property(noKeywordTextArb, (text) => {
          const results = classify(text);

          expect(results).toHaveLength(1);
          expect(results[0].theme).toBe('uncategorized');
          expect(results[0].confidence).toBe(0.0);
        }),
        { numRuns: 100 },
      );
    });

    it('any text where all theme scores are below 0.3 is labeled uncategorized', () => {
      // Use the classify function directly and verify the invariant:
      // if the result contains 'uncategorized', no other theme exceeded 0.3
      // if the result does NOT contain 'uncategorized', at least one theme exceeded 0.3
      const anyTextArb = fc.oneof(
        noKeywordTextArb,
        fillerSentenceArb,
        fc.string({ minLength: 1, maxLength: 100 }),
      );

      fc.assert(
        fc.property(anyTextArb, (text) => {
          const results = classify(text);
          const themes = results.map((r) => r.theme);

          if (themes.includes('uncategorized')) {
            // When uncategorized is present, it should be the only result
            expect(results).toHaveLength(1);
            expect(results[0].confidence).toBe(0.0);
          } else {
            // When not uncategorized, every result should have confidence > 0.3
            for (const result of results) {
              expect(result.confidence).toBeGreaterThan(0.3);
            }
          }
        }),
        { numRuns: 100 },
      );
    });
  });
});
