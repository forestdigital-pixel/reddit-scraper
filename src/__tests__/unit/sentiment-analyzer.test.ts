import { describe, it, expect } from 'vitest';
import {
  analyze,
  SentimentAnalyzerService,
} from '../../services/sentiment-analyzer-service.js';
import type { RedditContent } from '../../services/theme-classifier-service.js';

describe('analyze (pure function)', () => {
  it('returns neutral for empty text', () => {
    const result = analyze('');
    expect(result.score).toBe(0);
    expect(result.label).toBe('neutral');
    expect(result.tokens).toEqual([]);
  });

  it('returns neutral for whitespace-only text', () => {
    const result = analyze('   ');
    expect(result.score).toBe(0);
    expect(result.label).toBe('neutral');
  });

  it('returns positive label for clearly positive text', () => {
    const result = analyze('I love this amazing wonderful product');
    expect(result.score).toBeGreaterThan(0.05);
    expect(result.label).toBe('positive');
  });

  it('returns negative label for clearly negative text', () => {
    const result = analyze('This is terrible awful horrible garbage');
    expect(result.score).toBeLessThan(-0.05);
    expect(result.label).toBe('negative');
  });

  it('returns neutral label for neutral text', () => {
    const result = analyze('The table is made of wood');
    expect(result.score).toBeGreaterThanOrEqual(-0.05);
    expect(result.score).toBeLessThanOrEqual(0.05);
    expect(result.label).toBe('neutral');
  });

  it('normalizes score to [-1.0, 1.0] range', () => {
    const result = analyze('love love love love love');
    expect(result.score).toBeGreaterThanOrEqual(-1.0);
    expect(result.score).toBeLessThanOrEqual(1.0);
  });

  it('preserves raw comparative score', () => {
    const result = analyze('I love this');
    expect(result.comparative).toBeDefined();
    expect(typeof result.comparative).toBe('number');
  });

  it('returns tokens from the analyzed text', () => {
    const result = analyze('hello world');
    expect(result.tokens).toContain('hello');
    expect(result.tokens).toContain('world');
  });
});

describe('SentimentAnalyzerService', () => {
  const service = new SentimentAnalyzerService();

  describe('analyze', () => {
    it('delegates to the pure analyze function', () => {
      const result = service.analyze('I love this');
      expect(result.label).toBe('positive');
      expect(result.score).toBeGreaterThan(0.05);
    });
  });

  describe('analyzeBatch', () => {
    it('returns a map of content ID to sentiment result', () => {
      const items: RedditContent[] = [
        { id: 'post1', text: 'I love this product', contentType: 'post' },
        { id: 'post2', text: 'This is terrible', contentType: 'post' },
        { id: 'post3', text: 'The sky is blue', contentType: 'comment' },
      ];

      const results = service.analyzeBatch(items);

      expect(results.size).toBe(3);
      expect(results.get('post1')?.label).toBe('positive');
      expect(results.get('post2')?.label).toBe('negative');
      expect(results.get('post3')?.label).toBe('neutral');
    });

    it('handles empty batch', () => {
      const results = service.analyzeBatch([]);
      expect(results.size).toBe(0);
    });
  });

  describe('getAggregateDistribution', () => {
    it('computes correct percentages for mixed results', () => {
      const results = [
        { score: 0.5, comparative: 2.5, label: 'positive' as const, tokens: [] },
        { score: -0.5, comparative: -2.5, label: 'negative' as const, tokens: [] },
        { score: 0.0, comparative: 0.0, label: 'neutral' as const, tokens: [] },
      ];

      const dist = service.getAggregateDistribution(results);

      expect(dist.positive).toBeCloseTo(33.33, 1);
      expect(dist.negative).toBeCloseTo(33.33, 1);
      expect(dist.neutral).toBeCloseTo(33.33, 1);
      expect(dist.positive + dist.negative + dist.neutral).toBeCloseTo(100, 5);
    });

    it('returns all zeros for empty results', () => {
      const dist = service.getAggregateDistribution([]);
      expect(dist.positive).toBe(0);
      expect(dist.negative).toBe(0);
      expect(dist.neutral).toBe(0);
    });

    it('handles all-positive results', () => {
      const results = [
        { score: 0.5, comparative: 2.5, label: 'positive' as const, tokens: [] },
        { score: 0.8, comparative: 4.0, label: 'positive' as const, tokens: [] },
      ];

      const dist = service.getAggregateDistribution(results);

      expect(dist.positive).toBe(100);
      expect(dist.negative).toBe(0);
      expect(dist.neutral).toBe(0);
    });

    it('handles all-negative results', () => {
      const results = [
        { score: -0.5, comparative: -2.5, label: 'negative' as const, tokens: [] },
        { score: -0.8, comparative: -4.0, label: 'negative' as const, tokens: [] },
      ];

      const dist = service.getAggregateDistribution(results);

      expect(dist.positive).toBe(0);
      expect(dist.negative).toBe(100);
      expect(dist.neutral).toBe(0);
    });
  });
});
