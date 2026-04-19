import Sentiment from 'sentiment';
import { getPool } from '../db/connection.js';
import type { ContentType, SentimentLabel } from '../models/database.js';
import type { RedditContent } from './theme-classifier-service.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result of analyzing a single piece of text for sentiment.
 */
export interface SentimentResult {
  /** Normalized score in the range [-1.0, 1.0] */
  score: number;
  /** Raw comparative score (score per word) from the AFINN-165 analysis */
  comparative: number;
  /** Sentiment label derived from the normalized score */
  label: SentimentLabel;
  /** Tokens extracted from the input text */
  tokens: string[];
}

/**
 * Aggregate distribution of sentiment across a set of results.
 * Each field is a percentage (0–100) and all three sum to ~100%.
 */
export interface SentimentDistribution {
  positive: number;
  negative: number;
  neutral: number;
}

/**
 * A single data point in a sentiment time series.
 */
export interface SentimentTimePoint {
  date: Date;
  avgScore: number;
  count: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Threshold above which a score is labeled positive */
const POSITIVE_THRESHOLD = 0.05;

/** Threshold below which a score is labeled negative */
const NEGATIVE_THRESHOLD = -0.05;

/**
 * The maximum absolute value of the AFINN-165 comparative score used for
 * normalization. The AFINN-165 word list assigns scores from -5 to +5 per
 * word, so the comparative (score / token count) typically falls in [-5, 5].
 * We clamp to this range before normalizing to [-1, 1].
 */
const MAX_COMPARATIVE = 5;

// ---------------------------------------------------------------------------
// Singleton sentiment analyzer instance
// ---------------------------------------------------------------------------

const sentimentAnalyzer = new Sentiment();

// ---------------------------------------------------------------------------
// Pure analysis function (exported for property testing)
// ---------------------------------------------------------------------------

/**
 * Runs sentiment analysis on a text string and returns a normalized result.
 *
 * The raw AFINN-165 comparative score (typically -5 to +5 per word) is
 * clamped to [-5, 5] and then linearly normalized to [-1.0, 1.0].
 *
 * Thresholds:
 * - score > 0.05 → positive
 * - score < -0.05 → negative
 * - otherwise → neutral
 *
 * This is a **pure function** with no DB dependency — suitable for property testing.
 *
 * **Validates: Requirements 6.1, 6.2**
 */
export function analyze(text: string): SentimentResult {
  if (!text || text.trim().length === 0) {
    return {
      score: 0,
      comparative: 0,
      label: 'neutral',
      tokens: [],
    };
  }

  const raw = sentimentAnalyzer.analyze(text);

  // Clamp comparative to [-MAX_COMPARATIVE, MAX_COMPARATIVE] then normalize to [-1, 1]
  const clamped = Math.max(-MAX_COMPARATIVE, Math.min(MAX_COMPARATIVE, raw.comparative));
  const normalized = clamped / MAX_COMPARATIVE;

  let label: SentimentLabel;
  if (normalized > POSITIVE_THRESHOLD) {
    label = 'positive';
  } else if (normalized < NEGATIVE_THRESHOLD) {
    label = 'negative';
  } else {
    label = 'neutral';
  }

  return {
    score: normalized,
    comparative: raw.comparative,
    label,
    tokens: raw.tokens,
  };
}

// ---------------------------------------------------------------------------
// SentimentAnalyzerService
// ---------------------------------------------------------------------------

export class SentimentAnalyzerService {
  /**
   * Analyzes sentiment of a single text string.
   * Pure function wrapper — no DB dependency.
   *
   * **Validates: Requirements 6.1, 6.2**
   */
  analyze(text: string): SentimentResult {
    return analyze(text);
  }

  /**
   * Analyzes sentiment for a batch of Reddit content items.
   * Returns a Map from content ID to its SentimentResult.
   *
   * **Validates: Requirements 6.1, 6.2**
   */
  analyzeBatch(items: RedditContent[]): Map<string, SentimentResult> {
    const results = new Map<string, SentimentResult>();

    for (const item of items) {
      const result = analyze(item.text);
      results.set(item.id, result);
    }

    return results;
  }

  /**
   * Computes the aggregate sentiment distribution from a set of results.
   * Returns percentages (0–100) for positive, negative, and neutral that
   * sum to approximately 100%.
   *
   * **Validates: Requirements 6.3**
   */
  getAggregateDistribution(results: SentimentResult[]): SentimentDistribution {
    if (results.length === 0) {
      return { positive: 0, negative: 0, neutral: 0 };
    }

    let positiveCount = 0;
    let negativeCount = 0;
    let neutralCount = 0;

    for (const result of results) {
      switch (result.label) {
        case 'positive':
          positiveCount++;
          break;
        case 'negative':
          negativeCount++;
          break;
        case 'neutral':
          neutralCount++;
          break;
      }
    }

    const total = results.length;

    return {
      positive: (positiveCount / total) * 100,
      negative: (negativeCount / total) * 100,
      neutral: (neutralCount / total) * 100,
    };
  }

  /**
   * Queries the `sentiment_results` table for time-series sentiment data
   * within a date range for a given subreddit.
   *
   * Joins with `reddit_posts` and `reddit_comments` to filter by subreddit.
   * Groups by date and computes the average score per day.
   *
   * **Validates: Requirements 6.5**
   */
  async getTimeSeries(
    subreddit: string,
    startDate: Date,
    endDate: Date,
  ): Promise<SentimentTimePoint[]> {
    const pool = getPool();

    const query = `
      SELECT
        DATE(sr.analyzed_at) AS date,
        AVG(sr.score)        AS avg_score,
        COUNT(*)::int        AS count
      FROM sentiment_results sr
      LEFT JOIN reddit_posts rp
        ON sr.content_id = rp.id AND sr.content_type = 'post'
      LEFT JOIN reddit_comments rc
        ON sr.content_id = rc.id AND sr.content_type = 'comment'
      WHERE
        (rp.subreddit = $1 OR rc.subreddit = $1)
        AND sr.analyzed_at >= $2
        AND sr.analyzed_at <= $3
      GROUP BY DATE(sr.analyzed_at)
      ORDER BY date ASC
    `;

    const result = await pool.query(query, [subreddit, startDate, endDate]);

    return result.rows.map((row: { date: string | Date; avg_score: string | number; count: number }) => ({
      date: new Date(row.date),
      avgScore: Number(row.avg_score),
      count: row.count,
    }));
  }

  /**
   * Stores a sentiment result in the `sentiment_results` table.
   * Best-effort — logs errors but does not throw.
   */
  async storeResult(
    contentId: string,
    contentType: ContentType,
    result: SentimentResult,
  ): Promise<void> {
    const pool = getPool();

    const query = `
      INSERT INTO sentiment_results (content_id, content_type, score, label, analyzed_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT DO NOTHING
    `;

    try {
      await pool.query(query, [
        contentId,
        contentType,
        result.score,
        result.label,
      ]);
    } catch (err) {
      console.error(`Failed to store sentiment result for ${contentId}:`, err);
    }
  }

  /**
   * Analyzes a batch and persists results to the database.
   */
  async analyzeAndStore(
    items: RedditContent[],
  ): Promise<Map<string, SentimentResult>> {
    const results = this.analyzeBatch(items);

    for (const item of items) {
      const result = results.get(item.id);
      if (result) {
        await this.storeResult(item.id, item.contentType, result);
      }
    }

    return results;
  }
}
