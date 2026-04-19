import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  analyze,
  SentimentAnalyzerService,
  type SentimentResult,
} from '../../services/sentiment-analyzer-service';
import type { SentimentLabel } from '../../models/database';

/**
 * Property-based tests for SentimentAnalyzerService.
 *
 * Feature: reddit-data-scraper
 */

const service = new SentimentAnalyzerService();

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Generate a random word from lowercase letters */
const randomWordArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), {
    minLength: 2,
    maxLength: 10,
  })
  .map((chars) => chars.join(''));

/** Arbitrary for random text strings of varying length */
const randomTextArb: fc.Arbitrary<string> = fc.oneof(
  // Simple words
  fc.array(randomWordArb, { minLength: 1, maxLength: 20 }).map((words) => words.join(' ')),
  // Mixed alphanumeric
  fc.string({ minLength: 1, maxLength: 200 }),
  // Sentences with common English words
  fc.array(
    fc.constantFrom(
      'the', 'a', 'is', 'was', 'it', 'to', 'and', 'of', 'in', 'that',
      'have', 'for', 'not', 'on', 'with', 'this', 'but', 'from', 'or', 'an',
      'they', 'be', 'at', 'one', 'all', 'would', 'there', 'their', 'what',
      'so', 'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me',
    ),
    { minLength: 3, maxLength: 15 },
  ).map((words) => words.join(' ')),
);

/** Arbitrary for text with edge cases: emoji, special chars, very long text */
const edgeCaseTextArb: fc.Arbitrary<string> = fc.oneof(
  // Emoji-heavy text
  fc.array(
    fc.constantFrom('😀', '😢', '❤️', '🔥', '👍', '👎', '💯', '🎉', '😡', '🤔'),
    { minLength: 1, maxLength: 20 },
  ).map((emojis) => emojis.join(' ')),
  // Special characters
  fc.array(
    fc.constantFrom('!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '-', '+', '=', '?'),
    { minLength: 1, maxLength: 30 },
  ).map((chars) => chars.join('')),
  // Very long text (repeated words)
  fc.array(
    fc.constantFrom('good', 'bad', 'ok', 'fine', 'great', 'terrible', 'nice', 'awful', 'happy', 'sad'),
    { minLength: 50, maxLength: 100 },
  ).map((words) => words.join(' ')),
  // Unicode text
  fc.string({ minLength: 3, maxLength: 30 }),
  // Numbers only
  fc.array(fc.integer({ min: 0, max: 99999 }).map(String), { minLength: 1, maxLength: 10 })
    .map((nums) => nums.join(' ')),
);

/** Arbitrary for a valid SentimentLabel */
const sentimentLabelArb: fc.Arbitrary<SentimentLabel> = fc.constantFrom(
  'positive' as const,
  'negative' as const,
  'neutral' as const,
);

// ---------------------------------------------------------------------------
// Property 16: Sentiment label is consistent with score
// ---------------------------------------------------------------------------

describe('Sentiment Analysis Property Tests', () => {
  /**
   * Property 16: Sentiment label is consistent with score
   *
   * For any analyzed text, the sentiment label should be `positive` when
   * the normalized score > 0.05, `negative` when the score < -0.05, and
   * `neutral` otherwise.
   *
   * **Validates: Requirements 6.1**
   */
  describe('Property 16: Sentiment label is consistent with score', () => {
    it('label matches score thresholds for random text', () => {
      fc.assert(
        fc.property(randomTextArb, (text) => {
          const result = analyze(text);

          if (result.score > 0.05) {
            expect(result.label).toBe('positive');
          } else if (result.score < -0.05) {
            expect(result.label).toBe('negative');
          } else {
            expect(result.label).toBe('neutral');
          }
        }),
        { numRuns: 100 },
      );
    });

    it('label matches score thresholds for edge case text', () => {
      fc.assert(
        fc.property(edgeCaseTextArb, (text) => {
          const result = analyze(text);

          if (result.score > 0.05) {
            expect(result.label).toBe('positive');
          } else if (result.score < -0.05) {
            expect(result.label).toBe('negative');
          } else {
            expect(result.label).toBe('neutral');
          }
        }),
        { numRuns: 100 },
      );
    });

    it('label matches score thresholds for sentiment-bearing text', () => {
      /** Text that is likely to produce non-neutral sentiment */
      const sentimentTextArb: fc.Arbitrary<string> = fc.oneof(
        // Positive words mixed with filler
        fc.array(
          fc.constantFrom(
            'love', 'great', 'amazing', 'wonderful', 'excellent', 'fantastic',
            'happy', 'good', 'best', 'beautiful', 'the', 'is', 'very', 'so',
          ),
          { minLength: 3, maxLength: 12 },
        ).map((words) => words.join(' ')),
        // Negative words mixed with filler
        fc.array(
          fc.constantFrom(
            'hate', 'terrible', 'awful', 'horrible', 'worst', 'bad',
            'ugly', 'disgusting', 'angry', 'sad', 'the', 'is', 'very', 'so',
          ),
          { minLength: 3, maxLength: 12 },
        ).map((words) => words.join(' ')),
        // Neutral words
        fc.array(
          fc.constantFrom(
            'the', 'table', 'chair', 'door', 'window', 'floor', 'wall',
            'is', 'was', 'a', 'an', 'of', 'in', 'on',
          ),
          { minLength: 3, maxLength: 12 },
        ).map((words) => words.join(' ')),
      );

      fc.assert(
        fc.property(sentimentTextArb, (text) => {
          const result = analyze(text);

          if (result.score > 0.05) {
            expect(result.label).toBe('positive');
          } else if (result.score < -0.05) {
            expect(result.label).toBe('negative');
          } else {
            expect(result.label).toBe('neutral');
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Property 17: Sentiment score is bounded
  // -------------------------------------------------------------------------

  /**
   * Property 17: Sentiment score is bounded
   *
   * For any input text, the normalized sentiment score should be in the
   * range [-1.0, 1.0].
   *
   * **Validates: Requirements 6.2**
   */
  describe('Property 17: Sentiment score is bounded', () => {
    it('score is in [-1.0, 1.0] for random text', () => {
      fc.assert(
        fc.property(randomTextArb, (text) => {
          const result = analyze(text);

          expect(result.score).toBeGreaterThanOrEqual(-1.0);
          expect(result.score).toBeLessThanOrEqual(1.0);
        }),
        { numRuns: 100 },
      );
    });

    it('score is in [-1.0, 1.0] for edge case text (emoji, special chars, long text)', () => {
      fc.assert(
        fc.property(edgeCaseTextArb, (text) => {
          const result = analyze(text);

          expect(result.score).toBeGreaterThanOrEqual(-1.0);
          expect(result.score).toBeLessThanOrEqual(1.0);
        }),
        { numRuns: 100 },
      );
    });

    it('score is in [-1.0, 1.0] for heavily positive or negative text', () => {
      /** Text designed to push scores to extremes */
      const extremeTextArb: fc.Arbitrary<string> = fc.oneof(
        // Maximally positive: repeat high-scoring AFINN words
        fc.array(
          fc.constantFrom('love', 'outstanding', 'superb', 'breathtaking', 'excellent'),
          { minLength: 10, maxLength: 50 },
        ).map((words) => words.join(' ')),
        // Maximally negative: repeat low-scoring AFINN words
        fc.array(
          fc.constantFrom('hate', 'terrible', 'horrific', 'disgusting', 'abysmal'),
          { minLength: 10, maxLength: 50 },
        ).map((words) => words.join(' ')),
      );

      fc.assert(
        fc.property(extremeTextArb, (text) => {
          const result = analyze(text);

          expect(result.score).toBeGreaterThanOrEqual(-1.0);
          expect(result.score).toBeLessThanOrEqual(1.0);
        }),
        { numRuns: 100 },
      );
    });

    it('score is in [-1.0, 1.0] for empty and whitespace-only text', () => {
      const emptyishTextArb: fc.Arbitrary<string> = fc.oneof(
        fc.constant(''),
        fc.constant('   '),
        fc.constant('\t\n'),
        fc.array(fc.constant(' '), { minLength: 0, maxLength: 20 }).map((arr) => arr.join('')),
      );

      fc.assert(
        fc.property(emptyishTextArb, (text) => {
          const result = analyze(text);

          expect(result.score).toBeGreaterThanOrEqual(-1.0);
          expect(result.score).toBeLessThanOrEqual(1.0);
        }),
        { numRuns: 100 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Property 18: Sentiment distribution percentages sum to 100%
  // -------------------------------------------------------------------------

  /**
   * Property 18: Sentiment distribution percentages sum to 100%
   *
   * For any non-empty set of sentiment results, the aggregate distribution
   * percentages (positive + negative + neutral) should sum to approximately
   * 100%.
   *
   * **Validates: Requirements 6.3**
   */
  describe('Property 18: Sentiment distribution percentages sum to 100%', () => {
    /** Generate a SentimentResult with a random label */
    const sentimentResultArb: fc.Arbitrary<SentimentResult> = fc
      .tuple(
        sentimentLabelArb,
        fc.double({ min: -1.0, max: 1.0, noNaN: true }),
      )
      .map(([label, score]) => ({
        score,
        comparative: score * 5,
        label,
        tokens: [],
      }));

    /** Non-empty array of SentimentResult objects */
    const sentimentResultsArb: fc.Arbitrary<SentimentResult[]> = fc.array(sentimentResultArb, {
      minLength: 1,
      maxLength: 100,
    });

    it('distribution percentages sum to approximately 100% for any non-empty results', () => {
      fc.assert(
        fc.property(sentimentResultsArb, (results) => {
          const dist = service.getAggregateDistribution(results);
          const sum = dist.positive + dist.negative + dist.neutral;

          expect(sum).toBeCloseTo(100, 5);
        }),
        { numRuns: 100 },
      );
    });

    it('each percentage is non-negative and at most 100%', () => {
      fc.assert(
        fc.property(sentimentResultsArb, (results) => {
          const dist = service.getAggregateDistribution(results);

          expect(dist.positive).toBeGreaterThanOrEqual(0);
          expect(dist.positive).toBeLessThanOrEqual(100);
          expect(dist.negative).toBeGreaterThanOrEqual(0);
          expect(dist.negative).toBeLessThanOrEqual(100);
          expect(dist.neutral).toBeGreaterThanOrEqual(0);
          expect(dist.neutral).toBeLessThanOrEqual(100);
        }),
        { numRuns: 100 },
      );
    });

    it('distribution sums to 100% when results come from actual analysis', () => {
      /** Generate text, analyze it, then check distribution */
      const analyzedResultsArb: fc.Arbitrary<SentimentResult[]> = fc
        .array(randomTextArb, { minLength: 1, maxLength: 30 })
        .map((texts) => texts.map((text) => analyze(text)));

      fc.assert(
        fc.property(analyzedResultsArb, (results) => {
          const dist = service.getAggregateDistribution(results);
          const sum = dist.positive + dist.negative + dist.neutral;

          expect(sum).toBeCloseTo(100, 5);
        }),
        { numRuns: 100 },
      );
    });

    it('distribution reflects correct proportions', () => {
      /** Generate results with known label counts */
      const knownDistArb = fc
        .tuple(
          fc.integer({ min: 0, max: 30 }),
          fc.integer({ min: 0, max: 30 }),
          fc.integer({ min: 0, max: 30 }),
        )
        .filter(([p, neg, neu]) => p + neg + neu > 0)
        .map(([posCount, negCount, neuCount]) => {
          const results: SentimentResult[] = [];
          for (let i = 0; i < posCount; i++) {
            results.push({ score: 0.5, comparative: 2.5, label: 'positive', tokens: [] });
          }
          for (let i = 0; i < negCount; i++) {
            results.push({ score: -0.5, comparative: -2.5, label: 'negative', tokens: [] });
          }
          for (let i = 0; i < neuCount; i++) {
            results.push({ score: 0.0, comparative: 0.0, label: 'neutral', tokens: [] });
          }
          return { results, posCount, negCount, neuCount };
        });

      fc.assert(
        fc.property(knownDistArb, ({ results, posCount, negCount, neuCount }) => {
          const dist = service.getAggregateDistribution(results);
          const total = posCount + negCount + neuCount;

          expect(dist.positive).toBeCloseTo((posCount / total) * 100, 5);
          expect(dist.negative).toBeCloseTo((negCount / total) * 100, 5);
          expect(dist.neutral).toBeCloseTo((neuCount / total) * 100, 5);
          expect(dist.positive + dist.negative + dist.neutral).toBeCloseTo(100, 5);
        }),
        { numRuns: 100 },
      );
    });
  });
});
