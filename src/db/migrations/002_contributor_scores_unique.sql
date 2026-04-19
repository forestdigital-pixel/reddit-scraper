-- 002_contributor_scores_unique.sql
-- Adds unique constraint on (username, subreddit) for contributor_scores upsert.

ALTER TABLE contributor_scores
  ADD CONSTRAINT contributor_scores_username_subreddit_key
  UNIQUE (username, subreddit);
