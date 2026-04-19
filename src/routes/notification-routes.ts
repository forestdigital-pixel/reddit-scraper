/**
 * Notification routes.
 *
 * GET /api/v1/notifications/preferences — get notification preferences
 * PUT /api/v1/notifications/preferences — update notification preferences
 *
 * **Validates: Requirements 7.2, 7.3**
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { NotificationService } from '../services/notification-service.js';
import { successResponse, errorResponse } from './middleware/response.js';

export function createNotificationRoutes(notificationService: NotificationService): Router {
  const router = Router();

  /**
   * GET /api/v1/notifications/preferences
   */
  router.get('/preferences', async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = (req as Request & { userId: string }).userId;
      const prefs = await notificationService.getPreferences(userId);
      res.json(successResponse(prefs));
    } catch (err) {
      console.error('Get notification preferences error:', err);
      res.status(500).json(errorResponse('Internal server error'));
    }
  });

  /**
   * PUT /api/v1/notifications/preferences
   * Body: { channels: string[], frequency: string }
   */
  router.put('/preferences', async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = (req as Request & { userId: string }).userId;
      const { channels, frequency } = req.body as {
        channels?: string[];
        frequency?: string;
      };

      if (channels !== undefined && (!Array.isArray(channels) || channels.length === 0)) {
        res.status(400).json(errorResponse('Field "channels" must be a non-empty array'));
        return;
      }

      const validFrequencies = ['immediate', 'hourly', 'daily'];
      if (frequency !== undefined && !validFrequencies.includes(frequency)) {
        res.status(400).json(errorResponse(
          `Field "frequency" must be one of: ${validFrequencies.join(', ')}`,
        ));
        return;
      }

      await notificationService.updatePreferences(userId, {
        channels: channels as ('email' | 'in_app')[] | undefined,
        frequency: frequency as 'immediate' | 'hourly' | 'daily' | undefined,
      });

      // Return updated preferences
      const updated = await notificationService.getPreferences(userId);
      res.json(successResponse(updated));
    } catch (err) {
      console.error('Update notification preferences error:', err);
      res.status(500).json(errorResponse('Internal server error'));
    }
  });

  return router;
}
