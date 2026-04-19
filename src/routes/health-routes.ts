/**
 * Health check route.
 *
 * GET /health — returns service status.
 *
 * **Validates: Requirements 10.7**
 */

import { Router } from 'express';
import type { Request, Response } from 'express';

export function createHealthRoutes(): Router {
  const router = Router();

  /**
   * GET /health
   *
   * Returns a simple health check response. This endpoint is not
   * protected by API key authentication.
   */
  router.get('/', (_req: Request, res: Response): void => {
    res.json({
      status: 'success',
      data: {
        service: 'reddit-data-scraper',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      },
      error: null,
    });
  });

  return router;
}
