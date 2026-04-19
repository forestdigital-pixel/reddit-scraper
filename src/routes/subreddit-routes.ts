/**
 * Subreddit, sentiment, and contributor routes.
 *
 * GET /api/v1/subreddits/:name/stats         — subreddit statistics
 * GET /api/v1/subreddits/:name/sentiment      — sentiment analysis
 * GET /api/v1/subreddits/:name/contributors   — top contributors
 * GET /api/v1/subreddits/:name/contributors/:username — contributor profile
 *
 * **Validates: Requirements 5.1–5.7, 6.1–6.5, 8.1–8.4**
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { SubredditAnalyzerService } from '../services/subreddit-analyzer-service.js';
import type { SentimentAnalyzerService } from '../services/sentiment-analyzer-service.js';
import type { ContributorRankerService } from '../services/contributor-ranker-service.js';
import { successResponse, errorResponse } from './middleware/response.js';

export function createSubredditRoutes(
  subredditService: SubredditAnalyzerService,
  sentimentService: SentimentAnalyzerService,
  contributorService: ContributorRankerService,
): Router {
  const router = Router();

  /**
   * GET /api/v1/subreddits/:name/stats
   * Query params: timeframe
   */
  router.get('/:name/stats', async (req: Request, res: Response): Promise<void> => {
    try {
      const name = req.params['name'] as string;
      if (!name) {
        res.status(400).json(errorResponse('Subreddit name is required'));
        return;
      }

      const timeframe = req.query['timeframe'] as string | undefined;
      const stats = await subredditService.getStats(name, timeframe);
      res.json(successResponse(stats));
    } catch (err) {
      console.error('Subreddit stats error:', err);
      res.status(500).json(errorResponse('Internal server error'));
    }
  });

  /**
   * GET /api/v1/subreddits/:name/sentiment
   * Query params: timeframe, theme
   */
  router.get('/:name/sentiment', async (req: Request, res: Response): Promise<void> => {
    try {
      const name = req.params['name'] as string;
      if (!name) {
        res.status(400).json(errorResponse('Subreddit name is required'));
        return;
      }

      const timeframe = req.query['timeframe'] as string | undefined;

      // Determine date range from timeframe
      const endDate = new Date();
      let startDate: Date;
      switch (timeframe) {
        case 'day':
          startDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
          break;
        case 'week':
          startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          break;
        case 'year':
          startDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
          break;
        case 'month':
        default:
          startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
          break;
      }

      const timeSeries = await sentimentService.getTimeSeries(name, startDate, endDate);
      res.json(successResponse(timeSeries));
    } catch (err) {
      console.error('Sentiment error:', err);
      res.status(500).json(errorResponse('Internal server error'));
    }
  });

  /**
   * GET /api/v1/subreddits/:name/contributors
   * Query params: timeframe, limit (default 25)
   */
  router.get('/:name/contributors', async (req: Request, res: Response): Promise<void> => {
    try {
      const name = req.params['name'] as string;
      if (!name) {
        res.status(400).json(errorResponse('Subreddit name is required'));
        return;
      }

      const limit = Math.min(Math.max(Number(req.query['limit']) || 25, 1), 25);
      const timeframe = req.query['timeframe'] as string | undefined;

      const contributors = await contributorService.getTopContributors(name, limit, timeframe);
      res.json(successResponse(contributors));
    } catch (err) {
      console.error('Contributors error:', err);
      res.status(500).json(errorResponse('Internal server error'));
    }
  });

  /**
   * GET /api/v1/subreddits/:name/contributors/:username
   */
  router.get('/:name/contributors/:username', async (req: Request, res: Response): Promise<void> => {
    try {
      const name = req.params['name'] as string;
      const username = req.params['username'] as string;

      if (!name || !username) {
        res.status(400).json(errorResponse('Subreddit name and username are required'));
        return;
      }

      const profile = await contributorService.getContributorProfile(username, name);
      res.json(successResponse(profile));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      if (message.includes('not found')) {
        res.status(404).json(errorResponse(message));
      } else {
        console.error('Contributor profile error:', err);
        res.status(500).json(errorResponse('Internal server error'));
      }
    }
  });

  return router;
}
