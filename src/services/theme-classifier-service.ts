import { getPool } from '../db/connection.js';
import type { ConversationTheme, ContentType } from '../models/database.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Represents a piece of Reddit content (post or comment) for classification.
 */
export interface RedditContent {
  id: string;
  text: string;
  contentType: ContentType;
  metadata?: PostMetadata;
  classifications?: ThemeClassificationResult[];
}

/**
 * Engagement metadata used for hot_discussions boost.
 */
export interface PostMetadata {
  score: number;
  num_comments: number;
}

/**
 * Result of classifying a single piece of content against one theme.
 */
export interface ThemeClassificationResult {
  theme: ConversationTheme;
  confidence: number; // 0.0 to 1.0
}

/**
 * Dictionary definition for a single theme.
 */
export interface ThemeDictionary {
  theme: ConversationTheme;
  keywords: string[];
  phrases: string[];
  weights: Record<string, number>;
}

/**
 * A single item in a theme summary — a common phrase/topic with its frequency.
 */
export interface ThemeSummaryItem {
  phrase: string;
  count: number;
  contentIds: string[];
}

/**
 * Aggregated summary for a theme.
 */
export interface ThemeSummary {
  theme: ConversationTheme;
  totalItems: number;
  topPhrases: ThemeSummaryItem[];
}

// ---------------------------------------------------------------------------
// Theme dictionaries — exported so property tests can reference them
// ---------------------------------------------------------------------------

export const THEME_DICTIONARIES: ThemeDictionary[] = [
  {
    theme: 'pain_points',
    keywords: [
      'frustrated', 'frustrating', 'frustration',
      'annoying', 'annoyed', 'annoyance',
      'broken', 'buggy', 'bug',
      'terrible', 'horrible', 'awful',
      'hate', 'hated', 'hating',
      'problem', 'problems', 'issue', 'issues',
      'complaint', 'complain', 'complaining',
      'struggling', 'struggle', 'struggled',
      'disappointed', 'disappointing', 'disappointment',
      'unusable', 'useless', 'worthless',
      'painful', 'pain',
      'nightmare', 'disaster',
      'sucks', 'worst',
      'failing', 'failed', 'failure',
      'difficult', 'difficulty',
      'unreliable', 'unstable',
    ],
    phrases: [
      'does not work',
      'doesn\'t work',
      'cant stand',
      'can\'t stand',
      'fed up',
      'sick of',
      'tired of',
      'waste of time',
      'waste of money',
      'deal breaker',
      'so bad',
      'drives me crazy',
      'makes me angry',
      'i hate',
      'really annoying',
      'major issue',
      'keeps crashing',
      'not working',
    ],
    weights: {
      'frustrated': 1.5, 'frustrating': 1.5, 'frustration': 1.5,
      'nightmare': 2.0, 'disaster': 2.0,
      'unusable': 2.0, 'useless': 1.8,
      'hate': 1.5, 'terrible': 1.5, 'horrible': 1.5,
      'problem': 1.0, 'issue': 1.0,
      'annoying': 1.2, 'broken': 1.3,
      'painful': 1.5, 'pain': 1.2,
      'worst': 1.8, 'sucks': 1.5,
      'failing': 1.3, 'failed': 1.3, 'failure': 1.5,
      'disappointed': 1.3, 'disappointing': 1.3,
      'struggling': 1.2, 'difficult': 1.0,
      'unreliable': 1.5, 'unstable': 1.5,
    },
  },
  {
    theme: 'solution_requests',
    keywords: [
      'recommend', 'recommendation', 'recommendations',
      'suggest', 'suggestion', 'suggestions',
      'looking for', 'searching for',
      'need', 'needed',
      'help', 'advice',
      'best', 'top',
      'tool', 'tools',
      'app', 'apps',
      'software', 'service', 'services',
      'solution', 'solutions',
      'how to', 'howto',
      'tutorial', 'guide',
      'tips', 'trick', 'tricks',
      'workflow', 'setup',
      'resource', 'resources',
    ],
    phrases: [
      'any recommendations',
      'can anyone recommend',
      'what do you use',
      'what should i use',
      'best way to',
      'how do i',
      'how can i',
      'looking for a',
      'need help with',
      'anyone know',
      'does anyone know',
      'what is the best',
      'which one should',
      'please help',
      'any suggestions',
      'any advice',
      'how do you',
    ],
    weights: {
      'recommend': 1.8, 'recommendation': 1.8, 'recommendations': 1.8,
      'suggest': 1.5, 'suggestion': 1.5, 'suggestions': 1.5,
      'advice': 1.3, 'help': 1.0,
      'solution': 1.5, 'solutions': 1.5,
      'tool': 1.2, 'tools': 1.2,
      'best': 1.0, 'top': 0.8,
      'tutorial': 1.3, 'guide': 1.3,
      'tips': 1.0, 'resource': 1.0,
      'need': 0.8, 'needed': 0.8,
    },
  },
  {
    theme: 'money_talk',
    keywords: [
      'price', 'pricing', 'priced',
      'cost', 'costs', 'costly',
      'expensive', 'cheap', 'affordable',
      'budget', 'budgeting',
      'revenue', 'profit', 'profits',
      'income', 'salary', 'salaries',
      'money', 'cash',
      'invest', 'investing', 'investment',
      'subscription', 'subscriptions',
      'fee', 'fees',
      'pay', 'paying', 'paid', 'payment',
      'free', 'freemium',
      'discount', 'discounts', 'coupon',
      'roi', 'mrr', 'arr',
      'funding', 'fundraising',
      'valuation', 'worth',
      'dollar', 'dollars',
    ],
    phrases: [
      'how much does',
      'how much is',
      'is it worth',
      'worth the money',
      'worth the price',
      'too expensive',
      'good deal',
      'save money',
      'make money',
      'willing to pay',
      'would pay',
      'per month',
      'per year',
      'free trial',
      'money back',
      'return on investment',
    ],
    weights: {
      'price': 1.5, 'pricing': 1.5, 'cost': 1.5,
      'expensive': 1.8, 'cheap': 1.3, 'affordable': 1.3,
      'revenue': 2.0, 'profit': 2.0, 'income': 1.5,
      'money': 1.2, 'budget': 1.3,
      'invest': 1.5, 'investment': 1.5,
      'subscription': 1.3, 'fee': 1.2, 'fees': 1.2,
      'pay': 1.0, 'paying': 1.0, 'paid': 1.0,
      'roi': 2.0, 'mrr': 2.0, 'arr': 2.0,
      'funding': 1.8, 'valuation': 1.8,
      'discount': 1.3, 'free': 0.8, 'freemium': 1.5,
    },
  },
  {
    theme: 'hot_discussions',
    keywords: [
      'controversial', 'controversy',
      'debate', 'debating',
      'unpopular', 'opinion', 'opinions',
      'disagree', 'disagreement',
      'agree', 'agreement',
      'trending', 'viral',
      'breaking', 'news',
      'update', 'announcement',
      'drama', 'outrage',
      'rant', 'vent', 'venting',
      'thoughts', 'discussion',
      'hot take', 'change my mind',
    ],
    phrases: [
      'what do you think',
      'am i the only one',
      'unpopular opinion',
      'hot take',
      'change my mind',
      'let\'s discuss',
      'thoughts on',
      'anyone else',
      'does anyone else',
      'can we talk about',
      'i think we need to',
      'just announced',
      'breaking news',
    ],
    weights: {
      'controversial': 2.0, 'controversy': 2.0,
      'debate': 1.5, 'debating': 1.5,
      'drama': 1.8, 'outrage': 1.8,
      'rant': 1.5, 'vent': 1.3,
      'trending': 1.5, 'viral': 1.8,
      'unpopular': 1.3, 'opinion': 0.8,
      'disagree': 1.2, 'agree': 0.8,
      'discussion': 1.0, 'thoughts': 0.8,
      'announcement': 1.3, 'breaking': 1.3,
    },
  },
  {
    theme: 'seeking_alternatives',
    keywords: [
      'alternative', 'alternatives',
      'replacement', 'replace', 'replacing',
      'switch', 'switching', 'switched',
      'migrate', 'migrating', 'migration',
      'instead', 'instead of',
      'competitor', 'competitors',
      'versus', 'vs',
      'comparison', 'compare', 'comparing',
      'better than', 'worse than',
      'similar to', 'like',
      'equivalent',
      'substitute',
      'ditch', 'ditching', 'ditched',
      'leave', 'leaving', 'left',
      'move from', 'move to',
    ],
    phrases: [
      'looking for alternative',
      'looking for alternatives',
      'alternative to',
      'alternatives to',
      'replacement for',
      'switch from',
      'switch to',
      'switching from',
      'switching to',
      'migrate from',
      'migrate to',
      'better alternative',
      'instead of using',
      'similar to',
      'compared to',
      'anyone switched',
      'thinking of switching',
      'moved away from',
      'moved from',
    ],
    weights: {
      'alternative': 2.0, 'alternatives': 2.0,
      'replacement': 1.8, 'replace': 1.5,
      'switch': 1.5, 'switching': 1.5, 'switched': 1.5,
      'migrate': 1.5, 'migrating': 1.5, 'migration': 1.5,
      'competitor': 1.5, 'competitors': 1.5,
      'versus': 1.3, 'vs': 1.3,
      'comparison': 1.3, 'compare': 1.3,
      'substitute': 1.5, 'equivalent': 1.3,
      'ditch': 1.8, 'ditching': 1.8,
      'instead': 1.0,
    },
  },
];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum confidence threshold — below this, content is labeled uncategorized */
const CONFIDENCE_THRESHOLD = 0.3;

/** Engagement boost factor for hot_discussions */
const ENGAGEMENT_SCORE_THRESHOLD = 50;
const ENGAGEMENT_COMMENTS_THRESHOLD = 20;
const ENGAGEMENT_BOOST = 0.15;

/** Maximum confidence after normalization */
const MAX_CONFIDENCE = 1.0;

// ---------------------------------------------------------------------------
// Tokenization helpers
// ---------------------------------------------------------------------------

/**
 * Tokenizes text into lowercase words, stripping punctuation.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Normalizes text for phrase matching — lowercase, collapse whitespace.
 */
function normalizeForPhrases(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Core classification (pure function)
// ---------------------------------------------------------------------------

/**
 * Classifies text against all theme dictionaries and returns classifications.
 * This is a **pure function** with no DB dependency — suitable for property testing.
 *
 * @param text - The text to classify
 * @param metadata - Optional engagement metadata (score, num_comments)
 * @returns Array of ThemeClassificationResult for themes exceeding the threshold,
 *          or a single 'uncategorized' result if none exceed 0.3.
 *
 * **Validates: Requirements 2.1, 2.2, 2.4, 2.5**
 */
export function classify(
  text: string,
  metadata?: PostMetadata,
): ThemeClassificationResult[] {
  if (!text || text.trim().length === 0) {
    return [{ theme: 'uncategorized', confidence: 0.0 }];
  }

  const tokens = tokenize(text);
  const normalizedText = normalizeForPhrases(text);
  const tokenCount = tokens.length;

  if (tokenCount === 0) {
    return [{ theme: 'uncategorized', confidence: 0.0 }];
  }

  const results: ThemeClassificationResult[] = [];

  for (const dict of THEME_DICTIONARIES) {
    let rawScore = 0;

    // Score individual keyword matches
    for (const token of tokens) {
      if (dict.keywords.includes(token)) {
        const weight = dict.weights[token] ?? 1.0;
        rawScore += weight;
      }
    }

    // Score phrase matches (phrases contribute more weight)
    for (const phrase of dict.phrases) {
      if (normalizedText.includes(phrase)) {
        // Phrases get a flat bonus of 2.0 per match
        rawScore += 2.0;
      }
    }

    // Normalize score to 0.0–1.0 range
    // Use a sigmoid-like normalization: confidence = rawScore / (rawScore + k)
    // where k scales with token count to handle varying text lengths
    const k = Math.max(tokenCount * 0.3, 3);
    let confidence = rawScore / (rawScore + k);

    // Apply engagement boost for hot_discussions
    if (dict.theme === 'hot_discussions' && metadata) {
      if (
        metadata.score >= ENGAGEMENT_SCORE_THRESHOLD ||
        metadata.num_comments >= ENGAGEMENT_COMMENTS_THRESHOLD
      ) {
        confidence = Math.min(confidence + ENGAGEMENT_BOOST, MAX_CONFIDENCE);
      }
    }

    // Clamp to [0.0, 1.0]
    confidence = Math.max(0.0, Math.min(MAX_CONFIDENCE, confidence));

    if (confidence > CONFIDENCE_THRESHOLD) {
      results.push({ theme: dict.theme, confidence });
    }
  }

  // If no theme exceeds threshold, label as uncategorized
  if (results.length === 0) {
    return [{ theme: 'uncategorized', confidence: 0.0 }];
  }

  // Sort by confidence descending
  results.sort((a, b) => b.confidence - a.confidence);

  return results;
}

// ---------------------------------------------------------------------------
// ThemeClassifierService
// ---------------------------------------------------------------------------

export class ThemeClassifierService {
  /**
   * Classifies a single text against all theme dictionaries.
   * Pure function wrapper — no DB dependency.
   *
   * **Validates: Requirements 2.1, 2.2, 2.4, 2.5**
   */
  classify(text: string, metadata?: PostMetadata): ThemeClassificationResult[] {
    return classify(text, metadata);
  }

  /**
   * Classifies a batch of Reddit content items.
   * Returns a Map from content ID to its classifications.
   *
   * **Validates: Requirements 2.1, 2.4**
   */
  classifyBatch(items: RedditContent[]): Map<string, ThemeClassificationResult[]> {
    const results = new Map<string, ThemeClassificationResult[]>();

    for (const item of items) {
      const classifications = classify(item.text, item.metadata);
      results.set(item.id, classifications);
      // Attach classifications to the item for downstream use
      item.classifications = classifications;
    }

    return results;
  }

  /**
   * Filters items to return only those classified with the given theme.
   * Works on pre-classified items (uses item.classifications).
   * If an item has no classifications, it is classified on the fly.
   *
   * **Validates: Requirements 2.3**
   */
  filterByTheme(items: RedditContent[], theme: ConversationTheme): RedditContent[] {
    return items.filter((item) => {
      const classifications = item.classifications ?? classify(item.text, item.metadata);
      return classifications.some((c) => c.theme === theme);
    });
  }

  /**
   * Summarizes items for a given theme by grouping them by common
   * phrases/topics and ranking by frequency.
   *
   * **Validates: Requirements 4.2, 4.3, 4.4**
   */
  summarizeThemes(items: RedditContent[], theme: ConversationTheme): ThemeSummary {
    // Filter to items matching the theme
    const matchingItems = this.filterByTheme(items, theme);

    // Find the dictionary for this theme
    const dict = THEME_DICTIONARIES.find((d) => d.theme === theme);

    if (!dict || matchingItems.length === 0) {
      return {
        theme,
        totalItems: 0,
        topPhrases: [],
      };
    }

    // Count phrase occurrences across matching items
    const phraseCounts = new Map<string, { count: number; contentIds: string[] }>();

    for (const item of matchingItems) {
      const normalizedText = normalizeForPhrases(item.text);
      const matchedPhrases = new Set<string>();

      // Check phrase matches
      for (const phrase of dict.phrases) {
        if (normalizedText.includes(phrase)) {
          matchedPhrases.add(phrase);
        }
      }

      // Check keyword matches (group individual keywords)
      const tokens = tokenize(item.text);
      for (const token of tokens) {
        if (dict.keywords.includes(token)) {
          matchedPhrases.add(token);
        }
      }

      // Tally up
      for (const phrase of matchedPhrases) {
        const existing = phraseCounts.get(phrase);
        if (existing) {
          existing.count++;
          existing.contentIds.push(item.id);
        } else {
          phraseCounts.set(phrase, { count: 1, contentIds: [item.id] });
        }
      }
    }

    // Convert to sorted array (descending by count)
    const topPhrases: ThemeSummaryItem[] = Array.from(phraseCounts.entries())
      .map(([phrase, data]) => ({
        phrase,
        count: data.count,
        contentIds: data.contentIds,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      theme,
      totalItems: matchingItems.length,
      topPhrases,
    };
  }

  /**
   * Stores classification results in the `theme_classifications` table.
   * Best-effort — logs errors but does not throw.
   */
  async storeClassifications(
    contentId: string,
    contentType: ContentType,
    classifications: ThemeClassificationResult[],
  ): Promise<void> {
    const pool = getPool();

    const query = `
      INSERT INTO theme_classifications (content_id, content_type, theme, confidence, classified_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT DO NOTHING
    `;

    for (const classification of classifications) {
      try {
        await pool.query(query, [
          contentId,
          contentType,
          classification.theme,
          classification.confidence,
        ]);
      } catch (err) {
        console.error(
          `Failed to store classification for ${contentId}:`,
          err,
        );
      }
    }
  }

  /**
   * Classifies a batch and persists results to the database.
   */
  async classifyAndStore(items: RedditContent[]): Promise<Map<string, ThemeClassificationResult[]>> {
    const results = this.classifyBatch(items);

    for (const item of items) {
      const classifications = results.get(item.id);
      if (classifications) {
        await this.storeClassifications(item.id, item.contentType, classifications);
      }
    }

    return results;
  }
}
