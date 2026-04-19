/**
 * Express application setup.
 *
 * Wires all route modules, middleware (auth, JSON parsing, error handling),
 * and exports the Express app for testing.
 *
 * **Validates: Requirements 10.1, 10.7**
 */

import express from 'express';
import type { Request, Response, NextFunction } from 'express';

import { apiKeyAuth } from './routes/middleware/auth.js';
import { errorResponse } from './routes/middleware/response.js';
import { createHealthRoutes } from './routes/health-routes.js';
import { createSetupRoutes } from './routes/setup-routes.js';
import { createSearchRoutes } from './routes/search-routes.js';
import { createKeywordRoutes } from './routes/keyword-routes.js';
import { createSubredditRoutes } from './routes/subreddit-routes.js';
import { createThemeRoutes } from './routes/theme-routes.js';
import { createAudienceRoutes } from './routes/audience-routes.js';
import { createWebhookRoutes } from './routes/webhook-routes.js';
import { createNotificationRoutes } from './routes/notification-routes.js';

import type { RedditScraper } from './core/reddit-scraper.js';
import type { SearchService } from './services/search-service.js';
import type { KeywordTrackerService } from './services/keyword-tracker-service.js';
import type { SubredditAnalyzerService } from './services/subreddit-analyzer-service.js';
import type { SentimentAnalyzerService } from './services/sentiment-analyzer-service.js';
import type { ThemeClassifierService } from './services/theme-classifier-service.js';
import type { ContributorRankerService } from './services/contributor-ranker-service.js';
import type { WebhookService } from './services/webhook-service.js';
import type { NotificationService } from './services/notification-service.js';

// ---------------------------------------------------------------------------
// Service dependencies
// ---------------------------------------------------------------------------

export interface AppDependencies {
  scraper: RedditScraper;
  searchService: SearchService;
  keywordService: KeywordTrackerService;
  subredditService: SubredditAnalyzerService;
  sentimentService: SentimentAnalyzerService;
  themeService: ThemeClassifierService;
  contributorService: ContributorRankerService;
  webhookService: WebhookService;
  notificationService: NotificationService;
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

/**
 * Creates and configures the Express application with all routes and
 * middleware. Accepts service dependencies via injection for testability.
 */
export function createApp(deps: AppDependencies): express.Express {
  const app = express();

  // ---------------------------------------------------------------------------
  // Global middleware
  // ---------------------------------------------------------------------------

  // Parse JSON request bodies
  app.use(express.json());

  // ---------------------------------------------------------------------------
  // Health endpoint (no auth required)
  // ---------------------------------------------------------------------------

  app.use('/health', createHealthRoutes());

  // ---------------------------------------------------------------------------
  // Setup endpoint (no auth — protected by X-Setup-Secret header)
  // ---------------------------------------------------------------------------

  app.use('/setup', createSetupRoutes());

  // ---------------------------------------------------------------------------
  // API key authentication (applied to all /api routes)
  // ---------------------------------------------------------------------------

  app.use(apiKeyAuth);

  // ---------------------------------------------------------------------------
  // API v1 routes
  // ---------------------------------------------------------------------------

  app.use('/api/v1/search', createSearchRoutes(deps.searchService));
  app.use('/api/v1/keywords', createKeywordRoutes(deps.keywordService));
  app.use(
    '/api/v1/subreddits',
    createSubredditRoutes(
      deps.subredditService,
      deps.sentimentService,
      deps.contributorService,
    ),
  );
  app.use('/api/v1/themes', createThemeRoutes(deps.themeService, deps.scraper));
  app.use('/api/v1/audience-research', createAudienceRoutes(deps.themeService, deps.scraper));
  app.use('/api/v1/webhooks', createWebhookRoutes(deps.webhookService));
  app.use('/api/v1/notifications', createNotificationRoutes(deps.notificationService));

  // ---------------------------------------------------------------------------
  // 404 handler
  // ---------------------------------------------------------------------------

  app.use((_req: Request, res: Response): void => {
    res.status(404).json(errorResponse('Not found'));
  });

  // ---------------------------------------------------------------------------
  // Global error handler
  // ---------------------------------------------------------------------------

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction): void => {
    console.error('Unhandled error:', err);
    res.status(500).json(errorResponse('Internal server error'));
  });

  return app;
}
