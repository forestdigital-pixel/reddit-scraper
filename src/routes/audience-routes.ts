/**
 * Audience research routes.
 *
 * POST /api/v1/audience-research — audience research across subreddits
 *
 * **Validates: Requirements 4.1–4.5**
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { ThemeClassifierService, RedditContent } from '../services/theme-classifier-service.js';
import type { RedditScraper } from '../core/reddit-scraper.js';
import { successResponse, errorResponse } from './middleware/response.js';

export function createAudienceRoutes(
  themeService: ThemeClassifierService,
  scraper: RedditScraper,
): Router {
  const router = Router();

  /**
   * POST /api/v1/audience-research
   * Body: { subreddits: string[] }
   *
   * Fetches posts from multiple subreddits, classifies themes, and returns
   * aggregated audience research data.
   */
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const { subreddits } = req.body as { subreddits?: string[] };

      if (!subreddits || !Array.isArray(subreddits) || subreddits.length === 0) {
        res.status(400).json(errorResponse('Field "subreddits" must be a non-empty array'));
        return;
      }

      const allItems: RedditContent[] = [];

      // Fetch posts from each subreddit
      for (const subreddit of subreddits) {
        try {
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

          allItems.push(...items);
        } catch (err) {
          console.error(`Failed to fetch posts from r/${subreddit}:`, err);
          // Continue with other subreddits
        }
      }

      // Classify all items
      themeService.classifyBatch(allItems);

      // Summarize by theme
      const painPoints = themeService.summarizeThemes(allItems, 'pain_points');
      const solutionRequests = themeService.summarizeThemes(allItems, 'solution_requests');
      const moneyTalk = themeService.summarizeThemes(allItems, 'money_talk');
      const hotDiscussions = themeService.summarizeThemes(allItems, 'hot_discussions');
      const seekingAlternatives = themeService.summarizeThemes(allItems, 'seeking_alternatives');

      res.json(successResponse({
        subreddits,
        totalItems: allItems.length,
        themes: {
          pain_points: painPoints,
          solution_requests: solutionRequests,
          money_talk: moneyTalk,
          hot_discussions: hotDiscussions,
          seeking_alternatives: seekingAlternatives,
        },
      }));
    } catch (err) {
      console.error('Audience research error:', err);
      res.status(500).json(errorResponse('Internal server error'));
    }
  });

  return router;
}
