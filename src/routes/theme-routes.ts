/**
 * Theme classification routes.
 *
 * POST /api/v1/themes/classify            — classify subreddit content
 * GET  /api/v1/themes/:theme/discussions  — get discussions by theme
 *
 * **Validates: Requirements 2.1–2.5, 4.1–4.5**
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { ThemeClassifierService, RedditContent } from '../services/theme-classifier-service.js';
import type { RedditScraper } from '../core/reddit-scraper.js';
import type { ConversationTheme } from '../models/database.js';
import { successResponse, errorResponse } from './middleware/response.js';

const VALID_THEMES: ConversationTheme[] = [
  'pain_points',
  'solution_requests',
  'money_talk',
  'hot_discussions',
  'seeking_alternatives',
  'uncategorized',
];

export function createThemeRoutes(
  themeService: ThemeClassifierService,
  scraper: RedditScraper,
): Router {
  const router = Router();

  /**
   * POST /api/v1/themes/classify
   * Body: { subreddit: string, limit?: number }
   *
   * Fetches recent posts from the subreddit, classifies them, and returns
   * the classification results.
   */
  router.post('/classify', async (req: Request, res: Response): Promise<void> => {
    try {
      const { subreddit, limit } = req.body as { subreddit?: string; limit?: number };

      if (!subreddit || typeof subreddit !== 'string') {
        res.status(400).json(errorResponse('Field "subreddit" is required'));
        return;
      }

      const effectiveLimit = Math.min(Math.max(limit ?? 25, 1), 100);

      // Fetch recent posts from the subreddit
      const listing = await scraper.fetchSubredditPosts(subreddit, 'new', {
        limit: effectiveLimit,
      });

      // Convert to RedditContent for classification
      const items: RedditContent[] = listing.children.map((post) => ({
        id: post.id,
        text: `${post.title} ${post.selftext}`.trim(),
        contentType: 'post' as const,
        metadata: {
          score: post.score,
          num_comments: post.num_comments,
        },
      }));

      // Classify all items
      const classifications = themeService.classifyBatch(items);

      // Build response with items and their classifications
      const result = items.map((item) => ({
        id: item.id,
        text: item.text,
        classifications: classifications.get(item.id) ?? [],
      }));

      res.json(successResponse(result));
    } catch (err) {
      console.error('Theme classify error:', err);
      res.status(500).json(errorResponse('Internal server error'));
    }
  });

  /**
   * GET /api/v1/themes/:theme/discussions
   * Query params: subreddit (required)
   *
   * Returns discussions classified under the given theme for a subreddit.
   */
  router.get('/:theme/discussions', async (req: Request, res: Response): Promise<void> => {
    try {
      const theme = req.params['theme'] as ConversationTheme;

      if (!theme || !VALID_THEMES.includes(theme)) {
        res.status(400).json(errorResponse(
          `Invalid theme. Must be one of: ${VALID_THEMES.join(', ')}`,
        ));
        return;
      }

      const subreddit = req.query['subreddit'] as string | undefined;
      if (!subreddit) {
        res.status(400).json(errorResponse('Query parameter "subreddit" is required'));
        return;
      }

      // Fetch recent posts and classify
      const listing = await scraper.fetchSubredditPosts(subreddit, 'new', {
        limit: 100,
      });

      const items: RedditContent[] = listing.children.map((post) => ({
        id: post.id,
        text: `${post.title} ${post.selftext}`.trim(),
        contentType: 'post' as const,
        metadata: {
          score: post.score,
          num_comments: post.num_comments,
        },
      }));

      // Classify and filter by theme
      themeService.classifyBatch(items);
      const filtered = themeService.filterByTheme(items, theme);

      // Summarize
      const summary = themeService.summarizeThemes(items, theme);

      res.json(successResponse({
        discussions: filtered,
        summary,
      }));
    } catch (err) {
      console.error('Theme discussions error:', err);
      res.status(500).json(errorResponse('Internal server error'));
    }
  });

  return router;
}
