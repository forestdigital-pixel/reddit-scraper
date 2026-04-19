/**
 * Search routes.
 *
 * GET /api/v1/search — search Reddit with filtering and pagination.
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8**
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { SearchService } from '../services/search-service.js';
import { successResponse, errorResponse, parsePagination } from './middleware/response.js';

export function createSearchRoutes(searchService: SearchService): Router {
  const router = Router();

  /**
   * GET /api/v1/search
   *
   * Query params:
   *   q              — search query (required)
   *   subreddit      — restrict to subreddit
   *   sort           — relevance | new | hot | top | comments
   *   timeframe      — hour | day | week | month | year | all
   *   exclude_keywords — comma-separated keywords to exclude
   *   exclude_users  — comma-separated users to exclude
   *   page           — page number (default 1)
   *   page_size      — items per page (default 25, max 100)
   */
  router.get('/search', async (req: Request, res: Response): Promise<void> => {
    try {
      const q = req.query['q'] as string | undefined;
      if (!q) {
        res.status(400).json(errorResponse('Query parameter "q" is required'));
        return;
      }

      const { page, pageSize } = parsePagination(req.query as Record<string, string>);

      const excludeKeywordsRaw = req.query['exclude_keywords'] as string | undefined;
      const excludeUsersRaw = req.query['exclude_users'] as string | undefined;

      const result = await searchService.search({
        query: q,
        subreddit: req.query['subreddit'] as string | undefined,
        sort: req.query['sort'] as 'relevance' | 'new' | 'hot' | 'top' | 'comments' | undefined,
        timeframe: req.query['timeframe'] as 'hour' | 'day' | 'week' | 'month' | 'year' | 'all' | undefined,
        excludeKeywords: excludeKeywordsRaw ? excludeKeywordsRaw.split(',').map((k) => k.trim()) : undefined,
        excludeUsers: excludeUsersRaw ? excludeUsersRaw.split(',').map((u) => u.trim()) : undefined,
        page,
        pageSize,
      });

      res.json(successResponse(result.posts, {
        page: result.pagination.page,
        pageSize: result.pagination.pageSize,
        totalItems: result.pagination.totalItems,
        totalPages: result.pagination.totalPages,
      }));
    } catch (err) {
      console.error('Search error:', err);
      res.status(500).json(errorResponse('Internal server error'));
    }
  });

  return router;
}
