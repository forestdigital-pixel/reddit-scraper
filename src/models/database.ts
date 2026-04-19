/**
 * TypeScript interfaces matching the PostgreSQL database schema.
 *
 * These interfaces represent the rows stored in the database and are used
 * by services and data-access code. The Reddit-specific domain models
 * (RedditPost, RedditComment, etc.) live in ./reddit.ts and represent
 * the shape returned by Reddit JSON endpoints. The DB row types here
 * may overlap but include DB-specific fields like scraped_at.
 */

// =========================================================================
// Users
// =========================================================================

export interface User {
  id: string;          // UUID
  api_key: string;
  email: string | null;
  created_at: Date;
}

// =========================================================================
// Reddit Posts (DB row)
// =========================================================================

export interface RedditPostRow {
  id: string;
  subreddit: string;
  author: string;
  title: string;
  selftext: string;
  url: string;
  domain: string;
  permalink: string;
  score: number;
  num_comments: number;
  is_self: boolean;
  link_flair_text: string | null;
  created_utc: Date;
  scraped_at: Date;
}

// =========================================================================
// Reddit Comments (DB row)
// =========================================================================

export interface RedditCommentRow {
  id: string;
  post_id: string;
  subreddit: string;
  author: string;
  body: string;
  score: number;
  permalink: string;
  created_utc: Date;
  scraped_at: Date;
}

// =========================================================================
// Theme Classifications
// =========================================================================

export type ConversationTheme =
  | 'pain_points'
  | 'solution_requests'
  | 'money_talk'
  | 'hot_discussions'
  | 'seeking_alternatives'
  | 'uncategorized';

export type ContentType = 'post' | 'comment';

export interface ThemeClassification {
  id: string;           // UUID
  content_id: string;
  content_type: ContentType;
  theme: ConversationTheme;
  confidence: number;   // 0.0 to 1.0
  classified_at: Date;
}

// =========================================================================
// Sentiment Results
// =========================================================================

export type SentimentLabel = 'positive' | 'negative' | 'neutral';

export interface SentimentResult {
  id: string;           // UUID
  content_id: string;
  content_type: ContentType;
  score: number;        // -1.0 to 1.0
  label: SentimentLabel;
  analyzed_at: Date;
}

// =========================================================================
// Tracked Keywords
// =========================================================================

export interface TrackedKeyword {
  id: string;           // UUID
  user_id: string;      // UUID
  keyword: string;
  is_active: boolean;
  notifications_enabled: boolean;
  last_match_at: Date | null;
  created_at: Date;
}

// =========================================================================
// Keyword Frequencies
// =========================================================================

export interface KeywordFrequency {
  id: string;           // UUID
  keyword_id: string;   // UUID
  date: Date;
  count: number;
}

// =========================================================================
// Keyword Matches
// =========================================================================

export interface KeywordMatch {
  id: string;           // UUID
  keyword_id: string;   // UUID
  content_id: string;
  content_type: ContentType;
  matched_at: Date;
}

// =========================================================================
// Subreddit Snapshots
// =========================================================================

export interface SubredditSnapshot {
  id: string;           // UUID
  subreddit: string;
  subscribers: number;
  active_users: number;
  snapshot_at: Date;
}

// =========================================================================
// Contributor Scores
// =========================================================================

export interface ContributorScore {
  id: string;           // UUID
  username: string;
  subreddit: string;
  post_count: number;
  comment_count: number;
  total_post_score: number;
  total_comment_score: number;
  influence_score: number;
  computed_at: Date;
}

// =========================================================================
// Webhook Registrations
// =========================================================================

export type WebhookEvent = 'keyword_match' | 'theme_detected';

export interface WebhookRegistration {
  id: string;           // UUID
  user_id: string;      // UUID
  url: string;
  secret: string;
  events: string;       // comma-separated WebhookEvent values
  is_active: boolean;
  created_at: Date;
}

// =========================================================================
// Webhook Deliveries
// =========================================================================

export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface WebhookDelivery {
  id: string;           // UUID
  webhook_id: string;   // UUID
  payload: object;      // JSONB
  signature: string;
  status: DeliveryStatus;
  retry_count: number;
  last_attempt_at: Date | null;
  created_at: Date;
}

// =========================================================================
// Notifications
// =========================================================================

export type NotificationChannel = 'email' | 'in_app';
export type NotificationStatus = 'pending' | 'sent' | 'failed';

export interface Notification {
  id: string;           // UUID
  user_id: string;      // UUID
  keyword_id: string;   // UUID
  content_id: string;
  channel: NotificationChannel;
  permalink: string;
  status: NotificationStatus;
  retry_count: number;
  sent_at: Date | null;
  created_at: Date;
}

// =========================================================================
// Notification Preferences
// =========================================================================

export type NotificationFrequency = 'immediate' | 'hourly' | 'daily';

export interface NotificationPreference {
  id: string;           // UUID
  user_id: string;      // UUID
  channels: string;     // comma-separated NotificationChannel values
  frequency: NotificationFrequency;
}
