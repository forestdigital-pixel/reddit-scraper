/**
 * Webhook routes.
 *
 * GET    /api/v1/webhooks     — list webhooks
 * POST   /api/v1/webhooks     — register a webhook
 * DELETE /api/v1/webhooks/:id — unregister a webhook
 *
 * **Validates: Requirements 10.4, 10.5**
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { WebhookService } from '../services/webhook-service.js';
import type { WebhookEvent } from '../models/database.js';
import { successResponse, errorResponse } from './middleware/response.js';
import { getPool } from '../db/connection.js';

export function createWebhookRoutes(webhookService: WebhookService): Router {
  const router = Router();

  /**
   * GET /api/v1/webhooks — list all webhooks for the authenticated user.
   */
  router.get('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = (req as Request & { userId: string }).userId;
      const pool = getPool();

      const result = await pool.query(
        `SELECT id, user_id, url, events, is_active, created_at
         FROM webhook_registrations
         WHERE user_id = $1
         ORDER BY created_at DESC`,
        [userId],
      );

      res.json(successResponse(result.rows));
    } catch (err) {
      console.error('List webhooks error:', err);
      res.status(500).json(errorResponse('Internal server error'));
    }
  });

  /**
   * POST /api/v1/webhooks — register a new webhook.
   * Body: { url: string, events: string[] }
   */
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = (req as Request & { userId: string }).userId;
      const { url, events } = req.body as { url?: string; events?: string[] };

      if (!url || typeof url !== 'string') {
        res.status(400).json(errorResponse('Field "url" is required'));
        return;
      }

      if (!events || !Array.isArray(events) || events.length === 0) {
        res.status(400).json(errorResponse('Field "events" must be a non-empty array'));
        return;
      }

      const registration = await webhookService.register(
        userId,
        url,
        events as WebhookEvent[],
      );

      res.status(201).json(successResponse(registration));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      if (message.includes('Invalid webhook URL') || message.includes('At least one event')) {
        res.status(400).json(errorResponse(message));
      } else {
        console.error('Register webhook error:', err);
        res.status(500).json(errorResponse('Internal server error'));
      }
    }
  });

  /**
   * DELETE /api/v1/webhooks/:id — unregister a webhook.
   */
  router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      const webhookId = req.params['id'] as string;

      if (!webhookId) {
        res.status(400).json(errorResponse('Webhook ID is required'));
        return;
      }

      await webhookService.unregister(webhookId);
      res.json(successResponse({ deleted: true }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      if (message.includes('not found')) {
        res.status(404).json(errorResponse(message));
      } else {
        console.error('Unregister webhook error:', err);
        res.status(500).json(errorResponse('Internal server error'));
      }
    }
  });

  return router;
}
