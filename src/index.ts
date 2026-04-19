/**
 * Application entry point.
 *
 * Initializes the database pool, Redis connection, BullMQ workers,
 * and starts the Express server.
 *
 * **Validates: Requirements 10.1, 10.7**
 */

import dotenv from 'dotenv';

dotenv.config();

import { createApp } from './app.js';
import { getPool, closePool } from './db/connection.js';
import { closeAllQueues } from './jobs/queue-setup.js';
import { ProxyManager } from './core/proxy-manager.js';
import { RateLimiter } from './core/rate-limiter.js';
import { RedditScraper } from './core/reddit-scraper.js';
import { SearchService } from './services/search-service.js';
import { KeywordTrackerService } from './services/keyword-tracker-service.js';
import { SubredditAnalyzerService } from './services/subreddit-analyzer-service.js';
import { SentimentAnalyzerService } from './services/sentiment-analyzer-service.js';
import { ThemeClassifierService } from './services/theme-classifier-service.js';
import { ContributorRankerService } from './services/contributor-ranker-service.js';
import { WebhookService } from './services/webhook-service.js';
import { NotificationService } from './services/notification-service.js';

const PORT = Number(process.env['PORT']) || 3000;

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // Initialize core infrastructure
  // -------------------------------------------------------------------------

  const rateLimiter = new RateLimiter(
    Number(process.env['RATE_LIMIT_MS']) || 2000,
  );

  const proxyManager = new ProxyManager({
    proxyUrl: process.env['PROXY_URL'],
    userAgent: process.env['USER_AGENT'] ?? 'RedditScraper/1.0',
    rateLimitMs: Number(process.env['RATE_LIMIT_MS']) || 2000,
    maxRetries: 3,
  });

  const scraper = new RedditScraper({
    userAgent: process.env['USER_AGENT'] ?? 'RedditScraper/1.0',
    proxyManager,
    rateLimiter,
  });

  // -------------------------------------------------------------------------
  // Initialize services
  // -------------------------------------------------------------------------

  const searchService = new SearchService(scraper);
  const keywordService = new KeywordTrackerService(scraper);
  const subredditService = new SubredditAnalyzerService(scraper);
  const sentimentService = new SentimentAnalyzerService();
  const themeService = new ThemeClassifierService();
  const contributorService = new ContributorRankerService(scraper);
  const webhookService = new WebhookService();
  const notificationService = new NotificationService();

  // -------------------------------------------------------------------------
  // Create and start Express app FIRST so healthcheck passes
  // -------------------------------------------------------------------------

  const app = createApp({
    scraper,
    searchService,
    keywordService,
    subredditService,
    sentimentService,
    themeService,
    contributorService,
    webhookService,
    notificationService,
  });

  const server = app.listen(PORT, () => {
    console.log(`Reddit Scraper API listening on port ${PORT}`);
  });

  // -------------------------------------------------------------------------
  // Verify database connection (non-fatal — log warning, don't crash)
  // -------------------------------------------------------------------------

  try {
    const pool = getPool();
    await pool.query('SELECT 1');
    console.log('Database connection established');
  } catch (err) {
    console.warn('Warning: Could not connect to database on startup:', err instanceof Error ? err.message : err);
    console.warn('API is running but database-dependent endpoints will fail until DB is available.');
  }

  // -------------------------------------------------------------------------
  // Graceful shutdown
  // -------------------------------------------------------------------------

  const shutdown = async (): Promise<void> => {
    console.log('Shutting down...');

    server.close(() => {
      console.log('HTTP server closed');
    });

    try {
      await closeAllQueues();
      console.log('BullMQ queues closed');
    } catch (err) {
      console.error('Error closing queues:', err);
    }

    try {
      await closePool();
      console.log('Database pool closed');
    } catch (err) {
      console.error('Error closing database pool:', err);
    }

    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
