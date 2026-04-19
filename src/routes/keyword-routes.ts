/**
 * Keyword tracking routes.
 *
 * GET    /api/v1/keywords              — list tracked keywords
 * POST   /api/v1/keywords              — add a keyword
 * DELETE /api/v1/keywords/:id          — remove a keyword
 * GET    /api/v1/keywords/:id/frequency — frequency time series
 * GET    /api/v1/keywords/:id/matches  — recent matches
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4**
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { KeywordTrackerService } from '../services/keyword-tracker-service.js';
import { successResponse, errorResponse } from './middleware/response.js';

export function createKeywordRoutes(keywordService: KeywordTrackerService): Router {
  const router = Router();

  /**
   * GET /api/v1/keywords — list all tracked keywords for the authenticated user.
   */
  router.get('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = (req as Request & { userId: string }).userId;
      const keywords = await keywordService.getKeywords(userId);
      res.json(successResponse(keywords));
    } catch (err) {
      console.error('List keywords error:', err);
      res.status(500).json(errorResponse('Internal server error'));
    }
  });

  /**
   * POST /api/v1/keywords — add a new tracked keyword.
   * Body: { keyword: string }
   */
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = (req as Request & { userId: string }).userId;
      const { keyword } = req.body as { keyword?: string };

      if (!keyword || typeof keyword !== 'string' || keyword.trim().length === 0) {
        res.status(400).json(errorResponse('Field "keyword" is required'));
        return;
      }

      const result = await keywordService.addKeyword(userId, keyword.trim());
      res.status(201).json(successResponse(result));
    } catch (err) {
      console.error('Add keyword error:', err);
      res.status(500).json(errorResponse('Internal server error'));
    }
  });

  /**
   * DELETE /api/v1/keywords/:id — remove (deactivate) a tracked keyword.
   */
  router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = (req as Request & { userId: string }).userId;
      const keywordId = req.params['id'] as string;

      if (!keywordId) {
        res.status(400).json(errorResponse('Keyword ID is required'));
        return;
      }

      await keywordService.removeKeyword(userId, keywordId);
      res.json(successResponse({ deleted: true }));
    } catch (err) {
      console.error('Delete keyword error:', err);
      res.status(500).json(errorResponse('Internal server error'));
    }
  });

  /**
   * GET /api/v1/keywords/:id/frequency — keyword frequency time series.
   * Query params: start_date, end_date
   */
  router.get('/:id/frequency', async (req: Request, res: Response): Promise<void> => {
    try {
      const keywordId = req.params['id'] as string;

      if (!keywordId) {
        res.status(400).json(errorResponse('Keyword ID is required'));
        return;
      }

      const startDate = req.query['start_date']
        ? new Date(req.query['start_date'] as string)
        : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // default: 30 days ago
      const endDate = req.query['end_date']
        ? new Date(req.query['end_date'] as string)
        : new Date();

      const frequencies = await keywordService.getFrequencyTimeSeries(
        keywordId,
        startDate,
        endDate,
      );
      res.json(successResponse(frequencies));
    } catch (err) {
      console.error('Keyword frequency error:', err);
      res.status(500).json(errorResponse('Internal server error'));
    }
  });

  /**
   * GET /api/v1/keywords/:id/matches — recent keyword matches.
   * Query params: limit (default 25)
   */
  router.get('/:id/matches', async (req: Request, res: Response): Promise<void> => {
    try {
      const keywordId = req.params['id'] as string;

      if (!keywordId) {
        res.status(400).json(errorResponse('Keyword ID is required'));
        return;
      }

      const limit = Math.min(
        Math.max(Number(req.query['limit']) || 25, 1),
        100,
      );

      const matches = await keywordService.getRecentMatches(keywordId, limit);
      res.json(successResponse(matches));
    } catch (err) {
      console.error('Keyword matches error:', err);
      res.status(500).json(errorResponse('Internal server error'));
    }
  });

  return router;
}
