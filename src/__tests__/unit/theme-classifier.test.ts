import { describe, it, expect } from 'vitest';
import {
  classify,
  ThemeClassifierService,
  THEME_DICTIONARIES,
  type RedditContent,
  type PostMetadata,
} from '../../services/theme-classifier-service.js';

describe('ThemeClassifierService', () => {
  const service = new ThemeClassifierService();

  // -----------------------------------------------------------------------
  // classify() — pure function
  // -----------------------------------------------------------------------

  describe('classify()', () => {
    it('should return uncategorized for empty text', () => {
      const result = classify('', undefined);
      expect(result).toHaveLength(1);
      expect(result[0].theme).toBe('uncategorized');
      expect(result[0].confidence).toBe(0.0);
    });

    it('should return uncategorized for whitespace-only text', () => {
      const result = classify('   \n\t  ', undefined);
      expect(result).toHaveLength(1);
      expect(result[0].theme).toBe('uncategorized');
    });

    it('should classify pain_points text correctly', () => {
      const text = 'This software is so frustrating and broken. The bugs are a nightmare and it keeps crashing.';
      const result = classify(text);
      const painPoints = result.find((r) => r.theme === 'pain_points');
      expect(painPoints).toBeDefined();
      expect(painPoints!.confidence).toBeGreaterThan(0.3);
      expect(painPoints!.confidence).toBeLessThanOrEqual(1.0);
    });

    it('should classify solution_requests text correctly', () => {
      const text = 'Can anyone recommend a good tool for project management? Looking for suggestions and advice.';
      const result = classify(text);
      const solutions = result.find((r) => r.theme === 'solution_requests');
      expect(solutions).toBeDefined();
      expect(solutions!.confidence).toBeGreaterThan(0.3);
    });

    it('should classify money_talk text correctly', () => {
      const text = 'The pricing is too expensive. What is the cost of the subscription? Is there a discount or free trial?';
      const result = classify(text);
      const money = result.find((r) => r.theme === 'money_talk');
      expect(money).toBeDefined();
      expect(money!.confidence).toBeGreaterThan(0.3);
    });

    it('should classify hot_discussions text correctly', () => {
      const text = 'Unpopular opinion: this is a controversial take. What do you think? Let\'s discuss this drama.';
      const result = classify(text);
      const hot = result.find((r) => r.theme === 'hot_discussions');
      expect(hot).toBeDefined();
      expect(hot!.confidence).toBeGreaterThan(0.3);
    });

    it('should classify seeking_alternatives text correctly', () => {
      const text = 'Looking for alternatives to Slack. I want to switch from it. Any replacement or competitor recommendations?';
      const result = classify(text);
      const alternatives = result.find((r) => r.theme === 'seeking_alternatives');
      expect(alternatives).toBeDefined();
      expect(alternatives!.confidence).toBeGreaterThan(0.3);
    });

    it('should assign multiple themes when text matches several', () => {
      const text = 'This tool is frustrating and broken. Can anyone recommend an alternative? Looking for a replacement.';
      const result = classify(text);
      const themes = result.map((r) => r.theme);
      expect(themes).toContain('pain_points');
      expect(themes).toContain('seeking_alternatives');
    });

    it('should return uncategorized for generic text with no theme keywords', () => {
      const text = 'The weather today is quite pleasant and the sky is blue.';
      const result = classify(text);
      expect(result).toHaveLength(1);
      expect(result[0].theme).toBe('uncategorized');
    });

    it('should keep all confidence scores between 0.0 and 1.0', () => {
      const text = 'frustrated broken nightmare disaster unusable terrible horrible hate sucks worst failing unreliable';
      const result = classify(text);
      for (const r of result) {
        expect(r.confidence).toBeGreaterThanOrEqual(0.0);
        expect(r.confidence).toBeLessThanOrEqual(1.0);
      }
    });

    it('should apply engagement boost for hot_discussions', () => {
      const text = 'What do you think about this discussion?';
      const metadata: PostMetadata = { score: 100, num_comments: 50 };

      const withMeta = classify(text, metadata);
      const withoutMeta = classify(text);

      const hotWithMeta = withMeta.find((r) => r.theme === 'hot_discussions');
      const hotWithoutMeta = withoutMeta.find((r) => r.theme === 'hot_discussions');

      // With high engagement, hot_discussions should get a boost
      if (hotWithMeta && hotWithoutMeta) {
        expect(hotWithMeta.confidence).toBeGreaterThan(hotWithoutMeta.confidence);
      }
    });

    it('should sort results by confidence descending', () => {
      const text = 'This is frustrating and broken. Can anyone recommend an alternative replacement?';
      const result = classify(text);
      for (let i = 1; i < result.length; i++) {
        expect(result[i - 1].confidence).toBeGreaterThanOrEqual(result[i].confidence);
      }
    });
  });

  // -----------------------------------------------------------------------
  // classifyBatch()
  // -----------------------------------------------------------------------

  describe('classifyBatch()', () => {
    it('should classify multiple items and return a map', () => {
      const items: RedditContent[] = [
        { id: '1', text: 'This is frustrating and broken', contentType: 'post' },
        { id: '2', text: 'Can anyone recommend a good tool?', contentType: 'comment' },
        { id: '3', text: 'The weather is nice today', contentType: 'post' },
      ];

      const results = service.classifyBatch(items);

      expect(results.size).toBe(3);
      expect(results.has('1')).toBe(true);
      expect(results.has('2')).toBe(true);
      expect(results.has('3')).toBe(true);

      // Item 1 should have pain_points
      const item1 = results.get('1')!;
      expect(item1.some((r) => r.theme === 'pain_points')).toBe(true);

      // Item 3 should be uncategorized
      const item3 = results.get('3')!;
      expect(item3[0].theme).toBe('uncategorized');
    });

    it('should attach classifications to items', () => {
      const items: RedditContent[] = [
        { id: '1', text: 'This is frustrating and broken', contentType: 'post' },
      ];

      service.classifyBatch(items);

      expect(items[0].classifications).toBeDefined();
      expect(items[0].classifications!.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // filterByTheme()
  // -----------------------------------------------------------------------

  describe('filterByTheme()', () => {
    it('should return only items matching the given theme', () => {
      const items: RedditContent[] = [
        { id: '1', text: 'This is frustrating and broken nightmare', contentType: 'post' },
        { id: '2', text: 'Can anyone recommend a good tool? Any suggestions?', contentType: 'comment' },
        { id: '3', text: 'The weather is nice today', contentType: 'post' },
      ];

      // Pre-classify
      service.classifyBatch(items);

      const painPoints = service.filterByTheme(items, 'pain_points');
      expect(painPoints.length).toBeGreaterThanOrEqual(1);
      expect(painPoints.every((item) =>
        item.classifications!.some((c) => c.theme === 'pain_points'),
      )).toBe(true);
    });

    it('should return empty array when no items match', () => {
      const items: RedditContent[] = [
        { id: '1', text: 'The weather is nice today', contentType: 'post' },
      ];

      service.classifyBatch(items);

      const result = service.filterByTheme(items, 'money_talk');
      expect(result).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // summarizeThemes()
  // -----------------------------------------------------------------------

  describe('summarizeThemes()', () => {
    it('should summarize pain_points with ranked phrases', () => {
      const items: RedditContent[] = [
        { id: '1', text: 'This is frustrating and broken. A real nightmare.', contentType: 'post' },
        { id: '2', text: 'So frustrating! The bugs are terrible.', contentType: 'post' },
        { id: '3', text: 'Broken again, this is a nightmare disaster.', contentType: 'post' },
      ];

      service.classifyBatch(items);

      const summary = service.summarizeThemes(items, 'pain_points');
      expect(summary.theme).toBe('pain_points');
      expect(summary.totalItems).toBeGreaterThanOrEqual(1);
      expect(summary.topPhrases.length).toBeGreaterThan(0);

      // Phrases should be sorted by count descending
      for (let i = 1; i < summary.topPhrases.length; i++) {
        expect(summary.topPhrases[i - 1].count).toBeGreaterThanOrEqual(
          summary.topPhrases[i].count,
        );
      }
    });

    it('should return empty summary for theme with no matches', () => {
      const items: RedditContent[] = [
        { id: '1', text: 'The weather is nice today', contentType: 'post' },
      ];

      service.classifyBatch(items);

      const summary = service.summarizeThemes(items, 'money_talk');
      expect(summary.theme).toBe('money_talk');
      expect(summary.totalItems).toBe(0);
      expect(summary.topPhrases).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Theme dictionaries validation
  // -----------------------------------------------------------------------

  describe('THEME_DICTIONARIES', () => {
    it('should have dictionaries for all 5 classifiable themes', () => {
      const themes = THEME_DICTIONARIES.map((d) => d.theme);
      expect(themes).toContain('pain_points');
      expect(themes).toContain('solution_requests');
      expect(themes).toContain('money_talk');
      expect(themes).toContain('hot_discussions');
      expect(themes).toContain('seeking_alternatives');
    });

    it('should have non-empty keywords and phrases for each theme', () => {
      for (const dict of THEME_DICTIONARIES) {
        expect(dict.keywords.length).toBeGreaterThan(0);
        expect(dict.phrases.length).toBeGreaterThan(0);
        expect(Object.keys(dict.weights).length).toBeGreaterThan(0);
      }
    });
  });
});
