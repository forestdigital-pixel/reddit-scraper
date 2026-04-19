declare module 'sentiment' {
  interface SentimentAnalysisResult {
    score: number;
    comparative: number;
    calculation: Array<Record<string, number>>;
    tokens: string[];
    words: string[];
    positive: string[];
    negative: string[];
  }

  interface SentimentOptions {
    extras?: Record<string, number>;
    language?: string;
  }

  class Sentiment {
    analyze(phrase: string, options?: SentimentOptions): SentimentAnalysisResult;
  }

  export = Sentiment;
}
