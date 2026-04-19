/**
 * One-time setup route for initializing the database schema.
 *
 * POST /setup/init-db — creates all tables and inserts a default user.
 * Protected by a setup secret to prevent unauthorized access.
 * This endpoint should be called once after first deploy, then removed.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { getPool } from '../db/connection.js';

export function createSetupRoutes(): Router {
  const router = Router();

  router.post('/init-db', async (req: Request, res: Response): Promise<void> => {
    // Simple protection: require the API_KEY env var as a setup secret
    const setupSecret = req.header('X-Setup-Secret');
    const expectedSecret = process.env['API_KEY'];

    if (!setupSecret || setupSecret !== expectedSecret) {
      res.status(401).json({ error: 'Invalid or missing X-Setup-Secret header' });
      return;
    }

    const pool = getPool();

    try {
      // Enable UUID extension
      await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);

      // Users
      await pool.query(`CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        api_key VARCHAR(255) NOT NULL UNIQUE,
        email VARCHAR(255),
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );`);

      // Reddit posts
      await pool.query(`CREATE TABLE IF NOT EXISTS reddit_posts (
        id VARCHAR(32) PRIMARY KEY,
        subreddit VARCHAR(255) NOT NULL,
        author VARCHAR(255) NOT NULL,
        title TEXT NOT NULL,
        selftext TEXT NOT NULL DEFAULT '',
        url VARCHAR(2048) NOT NULL DEFAULT '',
        domain VARCHAR(255) NOT NULL DEFAULT '',
        permalink VARCHAR(2048) NOT NULL DEFAULT '',
        score INTEGER NOT NULL DEFAULT 0,
        num_comments INTEGER NOT NULL DEFAULT 0,
        is_self BOOLEAN NOT NULL DEFAULT FALSE,
        link_flair_text VARCHAR(255),
        created_utc TIMESTAMP NOT NULL,
        scraped_at TIMESTAMP NOT NULL DEFAULT NOW()
      );`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_reddit_posts_subreddit_created ON reddit_posts (subreddit, created_utc);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_reddit_posts_author ON reddit_posts (author);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_reddit_posts_score ON reddit_posts (score);`);

      // Reddit comments
      await pool.query(`CREATE TABLE IF NOT EXISTS reddit_comments (
        id VARCHAR(32) PRIMARY KEY,
        post_id VARCHAR(32) NOT NULL REFERENCES reddit_posts(id) ON DELETE CASCADE,
        subreddit VARCHAR(255) NOT NULL,
        author VARCHAR(255) NOT NULL,
        body TEXT NOT NULL,
        score INTEGER NOT NULL DEFAULT 0,
        permalink VARCHAR(2048) NOT NULL DEFAULT '',
        created_utc TIMESTAMP NOT NULL,
        scraped_at TIMESTAMP NOT NULL DEFAULT NOW()
      );`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_reddit_comments_post_id ON reddit_comments (post_id);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_reddit_comments_subreddit_author ON reddit_comments (subreddit, author);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_reddit_comments_created_utc ON reddit_comments (created_utc);`);

      // Theme classifications
      await pool.query(`CREATE TABLE IF NOT EXISTS theme_classifications (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        content_id VARCHAR(32) NOT NULL,
        content_type VARCHAR(16) NOT NULL,
        theme VARCHAR(64) NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.0,
        classified_at TIMESTAMP NOT NULL DEFAULT NOW()
      );`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_theme_classifications_content ON theme_classifications (content_id, content_type);`);

      // Sentiment results
      await pool.query(`CREATE TABLE IF NOT EXISTS sentiment_results (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        content_id VARCHAR(32) NOT NULL,
        content_type VARCHAR(16) NOT NULL,
        score REAL NOT NULL DEFAULT 0.0,
        label VARCHAR(16) NOT NULL,
        analyzed_at TIMESTAMP NOT NULL DEFAULT NOW()
      );`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_sentiment_results_content ON sentiment_results (content_id, content_type);`);

      // Tracked keywords
      await pool.query(`CREATE TABLE IF NOT EXISTS tracked_keywords (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        keyword VARCHAR(255) NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        notifications_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        last_match_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_tracked_keywords_user_active ON tracked_keywords (user_id, is_active);`);

      // Keyword frequencies
      await pool.query(`CREATE TABLE IF NOT EXISTS keyword_frequencies (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        keyword_id UUID NOT NULL REFERENCES tracked_keywords(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        count INTEGER NOT NULL DEFAULT 0
      );`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_keyword_frequencies_keyword_date ON keyword_frequencies (keyword_id, date);`);

      // Keyword matches
      await pool.query(`CREATE TABLE IF NOT EXISTS keyword_matches (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        keyword_id UUID NOT NULL REFERENCES tracked_keywords(id) ON DELETE CASCADE,
        content_id VARCHAR(32) NOT NULL,
        content_type VARCHAR(16) NOT NULL,
        matched_at TIMESTAMP NOT NULL DEFAULT NOW()
      );`);

      // Subreddit snapshots
      await pool.query(`CREATE TABLE IF NOT EXISTS subreddit_snapshots (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        subreddit VARCHAR(255) NOT NULL,
        subscribers INTEGER NOT NULL DEFAULT 0,
        active_users INTEGER NOT NULL DEFAULT 0,
        snapshot_at TIMESTAMP NOT NULL DEFAULT NOW()
      );`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_subreddit_snapshots_subreddit_at ON subreddit_snapshots (subreddit, snapshot_at);`);

      // Contributor scores
      await pool.query(`CREATE TABLE IF NOT EXISTS contributor_scores (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        username VARCHAR(255) NOT NULL,
        subreddit VARCHAR(255) NOT NULL,
        post_count INTEGER NOT NULL DEFAULT 0,
        comment_count INTEGER NOT NULL DEFAULT 0,
        total_post_score INTEGER NOT NULL DEFAULT 0,
        total_comment_score INTEGER NOT NULL DEFAULT 0,
        influence_score REAL NOT NULL DEFAULT 0.0,
        computed_at TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT contributor_scores_username_subreddit_key UNIQUE (username, subreddit)
      );`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_contributor_scores_subreddit_influence ON contributor_scores (subreddit, influence_score DESC);`);

      // Webhook registrations
      await pool.query(`CREATE TABLE IF NOT EXISTS webhook_registrations (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        url VARCHAR(2048) NOT NULL,
        secret VARCHAR(255) NOT NULL,
        events VARCHAR(255) NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );`);

      // Webhook deliveries
      await pool.query(`CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        webhook_id UUID NOT NULL REFERENCES webhook_registrations(id) ON DELETE CASCADE,
        payload JSONB NOT NULL,
        signature VARCHAR(255) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );`);

      // Notifications
      await pool.query(`CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        keyword_id UUID NOT NULL REFERENCES tracked_keywords(id) ON DELETE CASCADE,
        content_id VARCHAR(32) NOT NULL,
        channel VARCHAR(16) NOT NULL,
        permalink VARCHAR(2048) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        retry_count INTEGER NOT NULL DEFAULT 0,
        sent_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );`);

      // Notification preferences
      await pool.query(`CREATE TABLE IF NOT EXISTS notification_preferences (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        channels VARCHAR(64) NOT NULL DEFAULT 'in_app',
        frequency VARCHAR(16) NOT NULL DEFAULT 'immediate'
      );`);

      // Insert default user with the API key
      const apiKey = process.env['API_KEY'] || 'default-api-key';
      await pool.query(
        `INSERT INTO users (api_key, email) VALUES ($1, 'admin@reddit-scraper.local') ON CONFLICT (api_key) DO NOTHING;`,
        [apiKey],
      );

      res.json({
        status: 'success',
        message: 'Database initialized. All 14 tables created and default user inserted.',
      });
    } catch (err) {
      console.error('Setup failed:', err);
      res.status(500).json({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
