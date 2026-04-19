-- 001_initial_schema.sql
-- Creates all tables and indexes for the Reddit Data Scraper.

-- Enable uuid-ossp extension for uuid_generate_v4()
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =========================================================================
-- users
-- =========================================================================
CREATE TABLE IF NOT EXISTS users (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  api_key    VARCHAR(255) NOT NULL UNIQUE,
  email      VARCHAR(255),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- =========================================================================
-- reddit_posts
-- =========================================================================
CREATE TABLE IF NOT EXISTS reddit_posts (
  id              VARCHAR(32) PRIMARY KEY,
  subreddit       VARCHAR(255) NOT NULL,
  author          VARCHAR(255) NOT NULL,
  title           TEXT NOT NULL,
  selftext        TEXT NOT NULL DEFAULT '',
  url             VARCHAR(2048) NOT NULL DEFAULT '',
  domain          VARCHAR(255) NOT NULL DEFAULT '',
  permalink       VARCHAR(2048) NOT NULL DEFAULT '',
  score           INTEGER NOT NULL DEFAULT 0,
  num_comments    INTEGER NOT NULL DEFAULT 0,
  is_self         BOOLEAN NOT NULL DEFAULT FALSE,
  link_flair_text VARCHAR(255),
  created_utc     TIMESTAMP NOT NULL,
  scraped_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reddit_posts_subreddit_created
  ON reddit_posts (subreddit, created_utc);
CREATE INDEX IF NOT EXISTS idx_reddit_posts_author
  ON reddit_posts (author);
CREATE INDEX IF NOT EXISTS idx_reddit_posts_score
  ON reddit_posts (score);

-- =========================================================================
-- reddit_comments
-- =========================================================================
CREATE TABLE IF NOT EXISTS reddit_comments (
  id          VARCHAR(32) PRIMARY KEY,
  post_id     VARCHAR(32) NOT NULL REFERENCES reddit_posts(id) ON DELETE CASCADE,
  subreddit   VARCHAR(255) NOT NULL,
  author      VARCHAR(255) NOT NULL,
  body        TEXT NOT NULL,
  score       INTEGER NOT NULL DEFAULT 0,
  permalink   VARCHAR(2048) NOT NULL DEFAULT '',
  created_utc TIMESTAMP NOT NULL,
  scraped_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reddit_comments_post_id
  ON reddit_comments (post_id);
CREATE INDEX IF NOT EXISTS idx_reddit_comments_subreddit_author
  ON reddit_comments (subreddit, author);
CREATE INDEX IF NOT EXISTS idx_reddit_comments_created_utc
  ON reddit_comments (created_utc);

-- =========================================================================
-- theme_classifications
-- =========================================================================
CREATE TABLE IF NOT EXISTS theme_classifications (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  content_id    VARCHAR(32) NOT NULL,
  content_type  VARCHAR(16) NOT NULL,  -- 'post' or 'comment'
  theme         VARCHAR(64) NOT NULL,
  confidence    REAL NOT NULL DEFAULT 0.0,
  classified_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_theme_classifications_content
  ON theme_classifications (content_id, content_type);

-- =========================================================================
-- sentiment_results
-- =========================================================================
CREATE TABLE IF NOT EXISTS sentiment_results (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  content_id  VARCHAR(32) NOT NULL,
  content_type VARCHAR(16) NOT NULL,  -- 'post' or 'comment'
  score       REAL NOT NULL DEFAULT 0.0,
  label       VARCHAR(16) NOT NULL,   -- 'positive', 'negative', 'neutral'
  analyzed_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sentiment_results_content
  ON sentiment_results (content_id, content_type);

-- =========================================================================
-- tracked_keywords
-- =========================================================================
CREATE TABLE IF NOT EXISTS tracked_keywords (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  keyword               VARCHAR(255) NOT NULL,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  notifications_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  last_match_at         TIMESTAMP,
  created_at            TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tracked_keywords_user_active
  ON tracked_keywords (user_id, is_active);

-- =========================================================================
-- keyword_frequencies
-- =========================================================================
CREATE TABLE IF NOT EXISTS keyword_frequencies (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  keyword_id UUID NOT NULL REFERENCES tracked_keywords(id) ON DELETE CASCADE,
  date       DATE NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_keyword_frequencies_keyword_date
  ON keyword_frequencies (keyword_id, date);

-- =========================================================================
-- keyword_matches
-- =========================================================================
CREATE TABLE IF NOT EXISTS keyword_matches (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  keyword_id   UUID NOT NULL REFERENCES tracked_keywords(id) ON DELETE CASCADE,
  content_id   VARCHAR(32) NOT NULL,
  content_type VARCHAR(16) NOT NULL,  -- 'post' or 'comment'
  matched_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

-- =========================================================================
-- subreddit_snapshots
-- =========================================================================
CREATE TABLE IF NOT EXISTS subreddit_snapshots (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subreddit    VARCHAR(255) NOT NULL,
  subscribers  INTEGER NOT NULL DEFAULT 0,
  active_users INTEGER NOT NULL DEFAULT 0,
  snapshot_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subreddit_snapshots_subreddit_at
  ON subreddit_snapshots (subreddit, snapshot_at);

-- =========================================================================
-- contributor_scores
-- =========================================================================
CREATE TABLE IF NOT EXISTS contributor_scores (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username            VARCHAR(255) NOT NULL,
  subreddit           VARCHAR(255) NOT NULL,
  post_count          INTEGER NOT NULL DEFAULT 0,
  comment_count       INTEGER NOT NULL DEFAULT 0,
  total_post_score    INTEGER NOT NULL DEFAULT 0,
  total_comment_score INTEGER NOT NULL DEFAULT 0,
  influence_score     REAL NOT NULL DEFAULT 0.0,
  computed_at         TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contributor_scores_subreddit_influence
  ON contributor_scores (subreddit, influence_score DESC);

-- =========================================================================
-- webhook_registrations
-- =========================================================================
CREATE TABLE IF NOT EXISTS webhook_registrations (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url        VARCHAR(2048) NOT NULL,
  secret     VARCHAR(255) NOT NULL,
  events     VARCHAR(255) NOT NULL,  -- comma-separated: 'keyword_match,theme_detected'
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- =========================================================================
-- webhook_deliveries
-- =========================================================================
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  webhook_id      UUID NOT NULL REFERENCES webhook_registrations(id) ON DELETE CASCADE,
  payload         JSONB NOT NULL,
  signature       VARCHAR(255) NOT NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'pending',  -- 'pending', 'delivered', 'failed'
  retry_count     INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMP,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- =========================================================================
-- notifications
-- =========================================================================
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  keyword_id  UUID NOT NULL REFERENCES tracked_keywords(id) ON DELETE CASCADE,
  content_id  VARCHAR(32) NOT NULL,
  channel     VARCHAR(16) NOT NULL,   -- 'email' or 'in_app'
  permalink   VARCHAR(2048) NOT NULL,
  status      VARCHAR(16) NOT NULL DEFAULT 'pending',  -- 'pending', 'sent', 'failed'
  retry_count INTEGER NOT NULL DEFAULT 0,
  sent_at     TIMESTAMP,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- =========================================================================
-- notification_preferences
-- =========================================================================
CREATE TABLE IF NOT EXISTS notification_preferences (
  id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id   UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  channels  VARCHAR(64) NOT NULL DEFAULT 'in_app',  -- comma-separated: 'email,in_app'
  frequency VARCHAR(16) NOT NULL DEFAULT 'immediate' -- 'immediate', 'hourly', 'daily'
);
