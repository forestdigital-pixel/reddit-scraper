/**
 * API key authentication middleware.
 *
 * Validates the `X-API-Key` header against the `users` table.
 * Returns 401 for missing or invalid keys.
 * Skips authentication for `GET /health`.
 *
 * **Validates: Requirements 10.3**
 */

import type { Request, Response, NextFunction } from 'express';
import { getPool } from '../../db/connection.js';

/**
 * Express middleware that validates the X-API-Key header.
 *
 * - If the request path is `/health`, authentication is skipped.
 * - If the header is missing or the key does not match any row in the
 *   `users` table, a 401 JSON response is returned.
 * - On success, the matched user ID is attached to `req` as `req.userId`.
 *
 * Exported for property testing (Property 25).
 */
export async function apiKeyAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Skip auth for the health and setup endpoints
  if (req.path === '/health' || req.path.startsWith('/setup')) {
    next();
    return;
  }

  const apiKey = req.header('X-API-Key');

  if (!apiKey) {
    res.status(401).json({
      status: 'error',
      data: null,
      error: 'Invalid or missing API key',
    });
    return;
  }

  try {
    const pool = getPool();
    const result = await pool.query<{ id: string }>(
      'SELECT id FROM users WHERE api_key = $1',
      [apiKey],
    );

    if (result.rows.length === 0) {
      res.status(401).json({
        status: 'error',
        data: null,
        error: 'Invalid or missing API key',
      });
      return;
    }

    // Attach user ID to the request for downstream handlers
    (req as Request & { userId: string }).userId = result.rows[0].id;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    res.status(500).json({
      status: 'error',
      data: null,
      error: 'Internal server error',
    });
  }
}
