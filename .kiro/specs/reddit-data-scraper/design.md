# Design Document: Reddit Data Scraper

## Overview

The Reddit Data Scraper is a Node.js/TypeScript backend service that fetches, processes, and analyzes Reddit data using the public JSON method (appending `.json` to Reddit URLs). It exposes a REST API for integration with n8n and other automation platforms, and supports outbound webhooks for event-driven workflows.

The system is designed around a polling-based architecture since Reddit's JSON endpoints provide no real-time push or streaming capabilities. All Reddit requests are routed through a Webshare rotating proxy to avoid IP-based rate limiting. The service is deployed on Railway and uses PostgreSQL for persistent storage and BullMQ (backed by Redis) for job scheduling.

### Key Design Decisions

1. **Reddit JSON method over OAuth API**: No API keys or OAuth tokens required. Trade-off: limited to 100 posts per request, ~1000 items per listing, no historical data, no per-user karma.
2. **Node.js/TypeScript with Express**: Lightweight, well-suited for I/O-heavy scraping workloads, strong ecosystem for HTTP clients and NLP libraries.
3. **PostgreSQL for persistence**: Relational model fits the structured data (posts, comments, keywords, snapshots). Supports time-series queries for growth metrics and keyword frequency.
4. **BullMQ + Redis for job scheduling**: Handles polling intervals, retry logic, and background processing (sentiment analysis, theme classification, contributor ranking).
5. **`sentiment` npm package for sentiment analysis**: AFINN-165 word list based, runs locally with no external API calls. Produces scores in the -5 to +5 range per word, normalized to -1.0 to 1.0 per document.
6. **Keyword-based theme classification**: Uses curated keyword dictionaries and scoring heuristics rather than ML models. Simpler to deploy, deterministic, and sufficient for the five predefined themes.
7. **`https-proxy-agent` for proxy routing**: Standard Node.js approach for routing HTTP requests through an HTTP proxy with authentication.

## Architecture

The system follows a layered architecture with clear separation between HTTP transport, business logic, data access, and background processing.

```mermaid
graph TB
    subgraph "External"
        Reddit["Reddit (.json endpoints)"]
        Proxy["Webshare Rotating Proxy"]
        n8n["n8n / Webhook Consumers"]
        Email["Email Service (SMTP)"]
    end

    subgraph "API Layer"
        Express["Express REST API"]
        AuthMW["API Key Auth Middleware"]
        HealthCheck["GET /health"]
    end

    subgraph "Service Layer"
        SearchSvc["SearchService"]
        ThemeSvc["ThemeClassifierService"]
        KeywordSvc["KeywordTrackerService"]
        SentimentSvc["SentimentAnalyzerService"]
        SubredditSvc["SubredditAnalyzerService"]
        ContributorSvc["ContributorRankerService"]
        NotificationSvc["NotificationService"]
        WebhookSvc["WebhookService"]
    end

    subgraph "Core Layer"
        Scraper["RedditScraper"]
        ProxyMgr["ProxyManager"]
        RateLimiter["RateLimiter"]
    end

    subgraph "Background Jobs (BullMQ)"
        KeywordPoll["Keyword Polling Job"]
        SubredditSnapshot["Subreddit Snapshot Job"]
        ContributorRefresh["Contributor Refresh Job"]
        WebhookDispatch["Webhook Dispatch Job"]
        NotificationDispatch["Notification Dispatch Job"]
    end

    subgraph "Data Layer"
        PG["PostgreSQL"]
        Redis["Redis"]
    end

    Express --> AuthMW
    AuthMW --> SearchSvc
    AuthMW --> ThemeSvc
    AuthMW --> KeywordSvc
    AuthMW --> SentimentSvc
    AuthMW --> SubredditSvc
    AuthMW --> ContributorSvc
    AuthMW --> NotificationSvc
    AuthMW --> WebhookSvc

    SearchSvc --> Scraper
    ThemeSvc --> Scraper
    KeywordSvc --> Scraper
    SentimentSvc --> Scraper
    SubredditSvc --> Scraper
    ContributorSvc --> Scraper

    Scraper --> ProxyMgr
    ProxyMgr --> RateLimiter
    RateLimiter --> Proxy
    Proxy --> Reddit

    KeywordPoll --> KeywordSvc
    SubredditSnapshot --> SubredditSvc
    ContributorRefresh --> ContributorSvc
    WebhookDispatch --> WebhookSvc
    NotificationDispatch --> NotificationSvc

    WebhookSvc --> n8n
    NotificationSvc --> Email

    SearchSvc --> PG
    ThemeSvc --> PG
    KeywordSvc --> PG
    SentimentSvc --> PG
    SubredditSvc --> PG
    ContributorSvc --> PG
    NotificationSvc --> PG
    WebhookSvc --> PG

    KeywordPoll --> Redis
    SubredditSnapshot --> Redis
    ContributorRefresh --> Redis
    WebhookDispatch --> Redis
    NotificationDispatch --> Redis
```

### Request Flow

```mermaid
sequenceDiagram
    participant Client as n8n / Client
    participant API as Express API
    participant Auth as Auth Middleware
    participant Svc as Service Layer
    participant Scraper as RedditScraper
    participant Proxy as ProxyManager
    participant Reddit as Reddit .json
    participant DB as PostgreSQL

    Client->>API: GET /api/search?q=keyword
    API->>Auth: Validate X-API-Key
    Auth->>Svc: SearchService.search()
    Svc->>Scraper: fetchSearch(query, filters)
    Scraper->>Proxy: buildRequest(url)
    Proxy->>Reddit: GET reddit.com/search.json?q=keyword
    Reddit-->>Proxy: JSON response
    Proxy-->>Scraper: parsed data
    Scraper-->>Svc: RedditPost[]
    Svc->>Svc: Apply client-side filters (excluded keywords, users)
    Svc->>DB: Cache results
    Svc-->>API: { status, data, pagination }
    API-->>Client: JSON response
```

## Components and Interfaces

### 1. RedditScraper

The core HTTP client that fetches data from Reddit JSON endpoints.

```typescript
interface RedditScraperConfig {
  userAgent: string;
  proxyManager: ProxyManager;
  rateLimiter: RateLimiter;
}

interface PaginationParams {
  after?: string;
  limit?: number; // max 100
}

interface SearchParams {
  query: string;
  subreddit?: string;
  sort?: 'relevance' | 'new' | 'hot' | 'top' | 'comments';
  timeframe?: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';
  restrictSr?: boolean;
  pagination?: PaginationParams;
}

class RedditScraper {
  fetchSearch(params: SearchParams): Promise<RedditListing<RedditPost>>;
  fetchSubredditPosts(subreddit: string, sort: string, params: PaginationParams): Promise<RedditListing<RedditPost>>;
  fetchSubredditAbout(subreddit: string): Promise<SubredditAbout>;
  fetchPostComments(subreddit: string, postId: string): Promise<RedditComment[]>;
  fetchNewPosts(subreddit: string, params: PaginationParams): Promise<RedditListing<RedditPost>>;
}
```

### 2. ProxyManager

Routes all outbound requests through the Webshare rotating proxy.

```typescript
interface ProxyConfig {
  proxyUrl?: string;       // http://username-rotate:password@host:port
  userAgent: string;
  rateLimitMs: number;     // default: 2000 (1 req per 2s)
  maxRetries: number;      // default: 3
}

class ProxyManager {
  constructor(config: ProxyConfig);
  fetch(url: string, options?: RequestInit): Promise<Response>;
  getAgent(): HttpsProxyAgent | undefined;
  isProxyConfigured(): boolean;
}
```

### 3. RateLimiter

Token-bucket rate limiter ensuring requests stay below Reddit's detection thresholds.

```typescript
class RateLimiter {
  constructor(minIntervalMs: number);
  acquire(): Promise<void>;  // blocks until a token is available
  getQueueLength(): number;
}
```

### 4. ThemeClassifierService

Classifies Reddit content into predefined conversation themes using keyword dictionaries and scoring heuristics.

```typescript
interface ThemeClassification {
  theme: ConversationTheme;
  confidence: number; // 0.0 to 1.0
}

type ConversationTheme = 'pain_points' | 'solution_requests' | 'money_talk' | 'hot_discussions' | 'seeking_alternatives' | 'uncategorized';

interface ThemeDictionary {
  theme: ConversationTheme;
  keywords: string[];
  phrases: string[];
  weights: Record<string, number>;
}

class ThemeClassifierService {
  classify(text: string, metadata: PostMetadata): ThemeClassification[];
  classifyBatch(items: RedditContent[]): Map<string, ThemeClassification[]>;
  filterByTheme(items: RedditContent[], theme: ConversationTheme): RedditContent[];
  summarizeThemes(items: RedditContent[], theme: ConversationTheme): ThemeSummary;
}
```

**Classification approach**: Each theme has a curated dictionary of keywords, phrases, and weighted terms. The classifier tokenizes the input text, matches against dictionaries, and computes a weighted score normalized to 0.0–1.0. Posts with engagement metrics (high score, high comment count relative to subreddit average) get a boost for the `hot_discussions` theme. If no theme exceeds the 0.3 confidence threshold, the content is labeled `uncategorized`.

### 5. SentimentAnalyzerService

Analyzes sentiment using the `sentiment` npm package (AFINN-165 word list).

```typescript
interface SentimentResult {
  score: number;        // -1.0 to 1.0 (normalized)
  comparative: number;  // score per word
  label: 'positive' | 'negative' | 'neutral';
  tokens: string[];
}

class SentimentAnalyzerService {
  analyze(text: string): SentimentResult;
  analyzeBatch(items: RedditContent[]): Map<string, SentimentResult>;
  getAggregateDistribution(results: SentimentResult[]): SentimentDistribution;
  getTimeSeries(subreddit: string, startDate: Date, endDate: Date): SentimentTimePoint[];
}
```

**Normalization**: The raw AFINN-165 comparative score (typically -5 to +5 per word) is clamped and normalized to the -1.0 to 1.0 range. Thresholds: score > 0.05 = positive, score < -0.05 = negative, otherwise neutral.

### 6. KeywordTrackerService

Manages keyword tracking, frequency recording, and trend analysis.

```typescript
interface TrackedKeyword {
  id: string;
  userId: string;
  keyword: string;
  isActive: boolean;
  createdAt: Date;
  lastMatchAt: Date | null;
  notificationsEnabled: boolean;
}

interface KeywordFrequency {
  keywordId: string;
  date: Date;
  count: number;
}

class KeywordTrackerService {
  addKeyword(userId: string, keyword: string): Promise<TrackedKeyword>;
  removeKeyword(userId: string, keywordId: string): Promise<void>;
  getKeywords(userId: string): Promise<TrackedKeyword[]>;
  getFrequencyTimeSeries(keywordId: string, startDate: Date, endDate: Date): Promise<KeywordFrequency[]>;
  getRecentMatches(keywordId: string, limit: number): Promise<RedditContent[]>;
  pollKeyword(keyword: TrackedKeyword): Promise<RedditContent[]>;
  flagInactiveKeywords(): Promise<void>;
}
```

### 7. SubredditAnalyzerService

Computes and presents subreddit statistics.

```typescript
interface SubredditStats {
  name: string;
  subscribers: number;
  activeUsers: number;
  postTypeDistribution: Record<PostType, number>; // percentages
  flairDistribution: Record<string, number>;
  topKeywords: Array<{ keyword: string; count: number }>; // top 20
  topPosts: RedditPost[]; // top 10 by score
  growthMetrics: GrowthMetrics;
  engagementMetrics: EngagementMetrics;
}

interface GrowthMetrics {
  currentSubscribers: number;
  previousSubscribers: number | null;
  subscriberChange: number | null;
  avgPostsPerDay: number;
  snapshotDate: Date;
}

interface EngagementMetrics {
  avgScorePerPost: number;
  avgCommentsPerPost: number;
  periodDays: number; // 30
}

type PostType = 'text' | 'link' | 'image' | 'video';

class SubredditAnalyzerService {
  getStats(subreddit: string, timeframe?: string): Promise<SubredditStats>;
  recordSnapshot(subreddit: string): Promise<void>;
  classifyPostType(post: RedditPost): PostType;
  extractTopKeywords(posts: RedditPost[], limit: number): Array<{ keyword: string; count: number }>;
  computeEngagementMetrics(posts: RedditPost[]): EngagementMetrics;
}
```

### 8. ContributorRankerService

Identifies and ranks influential contributors within subreddits.

```typescript
interface ContributorProfile {
  username: string;
  subreddit: string;
  postCount: number;
  commentCount: number;
  totalPostScore: number;
  totalCommentScore: number;
  avgPostScore: number;
  avgCommentScore: number;
  influenceScore: number;
}

class ContributorRankerService {
  getTopContributors(subreddit: string, limit: number, timeframe?: string): Promise<ContributorProfile[]>;
  getContributorProfile(username: string, subreddit: string): Promise<ContributorProfile>;
  computeInfluenceScore(profile: Omit<ContributorProfile, 'influenceScore'>): number;
  refreshRankings(subreddit: string): Promise<void>;
}
```

**Influence score formula**: `influenceScore = (totalPostScore * 1.0) + (totalCommentScore * 0.5) + (postCount * 10) + (commentCount * 2)`. This weights post scores higher than comment scores, with activity bonuses for volume.

### 9. NotificationService

Handles polling-based notifications for keyword matches.

```typescript
interface NotificationPreferences {
  userId: string;
  channels: ('email' | 'in_app')[];
  frequency: 'immediate' | 'hourly' | 'daily';
}

interface Notification {
  id: string;
  userId: string;
  keywordId: string;
  contentId: string;
  channel: 'email' | 'in_app';
  permalink: string;
  status: 'pending' | 'sent' | 'failed';
  retryCount: number;
  createdAt: Date;
  sentAt: Date | null;
}

class NotificationService {
  sendNotification(userId: string, match: KeywordMatch): Promise<void>;
  getPreferences(userId: string): Promise<NotificationPreferences>;
  updatePreferences(userId: string, prefs: Partial<NotificationPreferences>): Promise<void>;
  retryFailed(): Promise<void>;
}
```

### 10. WebhookService

Manages outbound webhook delivery with HMAC-SHA256 signing.

```typescript
interface WebhookRegistration {
  id: string;
  userId: string;
  url: string;
  secret: string;       // for HMAC-SHA256 signing
  events: WebhookEvent[];
  isActive: boolean;
}

type WebhookEvent = 'keyword_match' | 'theme_detected';

interface WebhookDelivery {
  id: string;
  webhookId: string;
  payload: object;
  signature: string;    // X-Webhook-Signature header value
  status: 'pending' | 'delivered' | 'failed';
  retryCount: number;
  lastAttemptAt: Date;
}

class WebhookService {
  register(userId: string, url: string, events: WebhookEvent[]): Promise<WebhookRegistration>;
  unregister(webhookId: string): Promise<void>;
  dispatch(event: WebhookEvent, payload: object): Promise<void>;
  sign(payload: string, secret: string): string; // HMAC-SHA256
  verify(payload: string, signature: string, secret: string): boolean;
}
```

### 11. API Gateway (Express Routes)

```typescript
// Route structure
// All routes prefixed with /api/v1
// All routes require X-API-Key header (except /health)

// Search
GET  /api/v1/search?q=&subreddit=&sort=&timeframe=&exclude_keywords=&exclude_users=&page=&page_size=

// Keywords
GET    /api/v1/keywords
POST   /api/v1/keywords              { keyword: string }
DELETE /api/v1/keywords/:id
GET    /api/v1/keywords/:id/frequency?start_date=&end_date=
GET    /api/v1/keywords/:id/matches?limit=

// Subreddit Stats
GET  /api/v1/subreddits/:name/stats?timeframe=

// Sentiment
GET  /api/v1/subreddits/:name/sentiment?timeframe=&theme=

// Theme Categorization
POST /api/v1/themes/classify         { subreddit: string, limit?: number }
GET  /api/v1/themes/:theme/discussions?subreddit=

// Audience Research
POST /api/v1/audience-research       { subreddits: string[] }

// Contributors
GET  /api/v1/subreddits/:name/contributors?timeframe=&limit=
GET  /api/v1/subreddits/:name/contributors/:username

// Webhooks
GET    /api/v1/webhooks
POST   /api/v1/webhooks              { url: string, events: string[] }
DELETE /api/v1/webhooks/:id

// Notifications
GET  /api/v1/notifications/preferences
PUT  /api/v1/notifications/preferences  { channels: string[], frequency: string }

// Health
GET  /health

// Standard response envelope
interface ApiResponse<T> {
  status: 'success' | 'error';
  data: T | null;
  error: string | null;
  pagination?: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}
```

## Data Models

### PostgreSQL Schema

```mermaid
erDiagram
    users {
        uuid id PK
        varchar api_key UK
        varchar email
        timestamp created_at
    }

    reddit_posts {
        varchar id PK
        varchar subreddit
        varchar author
        text title
        text selftext
        varchar url
        varchar domain
        varchar permalink
        integer score
        integer num_comments
        boolean is_self
        varchar link_flair_text
        timestamp created_utc
        timestamp scraped_at
    }

    reddit_comments {
        varchar id PK
        varchar post_id FK
        varchar subreddit
        varchar author
        text body
        integer score
        varchar permalink
        timestamp created_utc
        timestamp scraped_at
    }

    theme_classifications {
        uuid id PK
        varchar content_id
        varchar content_type
        varchar theme
        float confidence
        timestamp classified_at
    }

    sentiment_results {
        uuid id PK
        varchar content_id
        varchar content_type
        float score
        varchar label
        timestamp analyzed_at
    }

    tracked_keywords {
        uuid id PK
        uuid user_id FK
        varchar keyword
        boolean is_active
        boolean notifications_enabled
        timestamp last_match_at
        timestamp created_at
    }

    keyword_frequencies {
        uuid id PK
        uuid keyword_id FK
        date date
        integer count
    }

    keyword_matches {
        uuid id PK
        uuid keyword_id FK
        varchar content_id
        varchar content_type
        timestamp matched_at
    }

    subreddit_snapshots {
        uuid id PK
        varchar subreddit
        integer subscribers
        integer active_users
        timestamp snapshot_at
    }

    contributor_scores {
        uuid id PK
        varchar username
        varchar subreddit
        integer post_count
        integer comment_count
        integer total_post_score
        integer total_comment_score
        float influence_score
        timestamp computed_at
    }

    webhook_registrations {
        uuid id PK
        uuid user_id FK
        varchar url
        varchar secret
        varchar events
        boolean is_active
        timestamp created_at
    }

    webhook_deliveries {
        uuid id PK
        uuid webhook_id FK
        jsonb payload
        varchar signature
        varchar status
        integer retry_count
        timestamp last_attempt_at
        timestamp created_at
    }

    notifications {
        uuid id PK
        uuid user_id FK
        uuid keyword_id FK
        varchar content_id
        varchar channel
        varchar permalink
        varchar status
        integer retry_count
        timestamp sent_at
        timestamp created_at
    }

    notification_preferences {
        uuid id PK
        uuid user_id FK
        varchar channels
        varchar frequency
    }

    users ||--o{ tracked_keywords : "tracks"
    users ||--o{ webhook_registrations : "registers"
    users ||--o{ notifications : "receives"
    users ||--|| notification_preferences : "has"
    tracked_keywords ||--o{ keyword_frequencies : "records"
    tracked_keywords ||--o{ keyword_matches : "matches"
    reddit_posts ||--o{ reddit_comments : "has"
    webhook_registrations ||--o{ webhook_deliveries : "delivers"
```

### Key Indexes

- `reddit_posts`: composite index on `(subreddit, created_utc)`, index on `author`, index on `score`
- `reddit_comments`: index on `(post_id)`, index on `(subreddit, author)`, index on `created_utc`
- `theme_classifications`: composite index on `(content_id, content_type)`
- `sentiment_results`: composite index on `(content_id, content_type)`
- `keyword_frequencies`: composite index on `(keyword_id, date)`
- `subreddit_snapshots`: composite index on `(subreddit, snapshot_at)`
- `contributor_scores`: composite index on `(subreddit, influence_score DESC)`
- `tracked_keywords`: index on `(user_id, is_active)`


## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Search URL construction preserves all parameters

*For any* valid combination of search parameters (query, subreddit, sort, timeframe, after token), the URL constructed by RedditScraper should contain each specified parameter as the correct query parameter or path segment.

**Validates: Requirements 1.2, 1.3, 1.6, 1.8**

### Property 2: Client-side exclusion filtering removes all matching content

*For any* set of Reddit posts and any set of excluded keywords and excluded users, the filtered result should contain no posts whose title or body contains any excluded keyword, and no posts authored by any excluded user.

**Validates: Requirements 1.4, 1.5**

### Property 3: Theme classification assigns correct themes for keyword-bearing text

*For any* text containing keywords from one or more theme dictionaries, the ThemeClassifierService should assign all themes whose keywords are present, and should not assign themes whose keywords are absent.

**Validates: Requirements 2.1, 2.4**

### Property 4: Theme confidence scores are bounded

*For any* input text, all confidence scores returned by the ThemeClassifierService should be in the range [0.0, 1.0].

**Validates: Requirements 2.2**

### Property 5: Theme filtering returns only matching content

*For any* set of classified content items and a selected theme, filtering by that theme should return only items that have been classified with that theme, and should return all such items.

**Validates: Requirements 2.3, 6.4**

### Property 6: Low-confidence text is labeled uncategorized

*For any* input text where no theme's confidence score exceeds 0.3, the ThemeClassifierService should label the content as "uncategorized".

**Validates: Requirements 2.5**

### Property 7: Daily keyword frequency equals match count

*For any* set of keyword matches with timestamps, the recorded daily frequency for each day should equal the number of matches whose timestamp falls on that day.

**Validates: Requirements 3.2**

### Property 8: Keyword match results all contain the keyword

*For any* tracked keyword and a set of Reddit posts/comments, the returned matches should all contain the keyword in their title or body text.

**Validates: Requirements 3.4**

### Property 9: Theme summary ranks items by frequency descending

*For any* set of posts classified under a theme (pain_points or solution_requests), the summary should list items ordered by frequency of occurrence in descending order.

**Validates: Requirements 4.2, 4.3, 4.4**

### Property 10: Post type classification is deterministic and correct

*For any* Reddit post, `classifyPostType` should return `text` when `is_self` is true, `image` when the URL ends with an image extension, `video` when the URL ends with a video extension or domain is a known video host, and `link` otherwise. The same input should always produce the same output.

**Validates: Requirements 5.2**

### Property 11: Flair distribution percentages sum to 100%

*For any* non-empty set of posts with flair values, the flair distribution percentages should sum to approximately 100% (within floating-point tolerance), and each flair's percentage should equal its count divided by the total number of posts with flairs.

**Validates: Requirements 5.3**

### Property 12: Top keywords are ordered by count and limited to 20

*For any* set of posts, `extractTopKeywords` should return at most 20 keywords, ordered by count in descending order, and each keyword's count should reflect its actual occurrence in the post titles and selftext fields.

**Validates: Requirements 5.4**

### Property 13: Top posts are ordered by score and limited to 10

*For any* set of posts, the top posts result should contain at most 10 posts, ordered by score in descending order.

**Validates: Requirements 5.5**

### Property 14: Growth metrics computation is correct

*For any* two subreddit snapshots (current and previous), `subscriberChange` should equal `currentSubscribers - previousSubscribers`. For any set of posts with `created_utc` timestamps over a 30-day period, `avgPostsPerDay` should equal the total post count divided by 30.

**Validates: Requirements 5.6**

### Property 15: Engagement metrics are correct averages

*For any* non-empty set of posts, `avgScorePerPost` should equal the sum of all scores divided by the number of posts, and `avgCommentsPerPost` should equal the sum of all `num_comments` divided by the number of posts.

**Validates: Requirements 5.7**

### Property 16: Sentiment label is consistent with score

*For any* analyzed text, the sentiment label should be `positive` when the normalized score > 0.05, `negative` when the score < -0.05, and `neutral` otherwise.

**Validates: Requirements 6.1**

### Property 17: Sentiment score is bounded

*For any* input text, the normalized sentiment score should be in the range [-1.0, 1.0].

**Validates: Requirements 6.2**

### Property 18: Sentiment distribution percentages sum to 100%

*For any* non-empty set of sentiment results, the aggregate distribution percentages (positive + negative + neutral) should sum to approximately 100%.

**Validates: Requirements 6.3**

### Property 19: Contributor ranking is ordered by influence score

*For any* set of contributor profiles, `getTopContributors` should return at most 25 profiles ordered by influence score in descending order.

**Validates: Requirements 8.1**

### Property 20: Influence score follows the defined formula

*For any* contributor data (totalPostScore, totalCommentScore, postCount, commentCount), `computeInfluenceScore` should return `(totalPostScore * 1.0) + (totalCommentScore * 0.5) + (postCount * 10) + (commentCount * 2)`.

**Validates: Requirements 8.2**

### Property 21: Contributor averages are correctly computed

*For any* contributor with postCount > 0 and commentCount > 0, `avgPostScore` should equal `totalPostScore / postCount` and `avgCommentScore` should equal `totalCommentScore / commentCount`.

**Validates: Requirements 8.3**

### Property 22: Timeframe filtering includes only activity within range

*For any* set of posts/comments with `created_utc` timestamps and a timeframe filter (start, end), only items where `created_utc` falls within [start, end] should contribute to the influence score computation.

**Validates: Requirements 8.4**

### Property 23: Rate limiter enforces minimum interval

*For any* sequence of N requests through the RateLimiter, the total elapsed time should be at least `(N - 1) * minIntervalMs`.

**Validates: Requirements 9.4**

### Property 24: API response envelope structure

*For any* API endpoint response, the JSON body should contain `status` (either "success" or "error"), `data` (object or null), and `error` (string or null). When status is "success", error should be null. When status is "error", data should be null.

**Validates: Requirements 10.2**

### Property 25: API key authentication enforcement

*For any* request to a protected endpoint, if the `X-API-Key` header is missing or does not match a valid key, the response should be HTTP 401. If the key is valid, the request should proceed.

**Validates: Requirements 10.3**

### Property 26: Webhook signature round-trip

*For any* payload string and secret, `verify(payload, sign(payload, secret), secret)` should return `true`. Additionally, `verify(payload, sign(payload, secret), differentSecret)` should return `false`.

**Validates: Requirements 10.5**

### Property 27: Pagination respects bounds

*For any* list endpoint request with `page_size` parameter, the response should contain at most `min(page_size, 100)` items. When no `page_size` is specified, the default should be 25.

**Validates: Requirements 10.8**

## Error Handling

### Reddit Request Errors

| Error | Handling Strategy |
|-------|-------------------|
| HTTP 429 (Too Many Requests) | Retry up to 3 times with exponential backoff (2s, 8s, 32s). Log the event. If all retries fail, return error to caller. |
| HTTP 403 (Forbidden) | Retry up to 3 times with exponential backoff. If persistent, log warning about potential IP block and return error. |
| HTTP 5xx (Server Error) | Retry up to 3 times with exponential backoff. Log the error with timestamp and URL. |
| Network timeout | 30-second timeout per request. Retry once. Log the timeout. |
| Invalid JSON response | Log the raw response (truncated), return a parse error to the caller. Do not retry. |
| Empty listing (no results) | Return empty array with appropriate message. Not an error condition. |

### Proxy Errors

| Error | Handling Strategy |
|-------|-------------------|
| Proxy connection refused | Fall back to direct connection if configured. Log warning. |
| Proxy authentication failure | Log error with redacted credentials. Do not retry — configuration issue. |
| No proxy configured | Use direct connection. Log warning on startup that requests may be rate-limited. |

### Webhook Delivery Errors

| Error | Handling Strategy |
|-------|-------------------|
| HTTP 4xx from webhook URL | Retry up to 3 times with exponential backoff (1s, 4s, 16s). Mark as failed after exhausting retries. |
| HTTP 5xx from webhook URL | Retry up to 3 times with exponential backoff. Mark as failed after exhausting retries. |
| Network error / timeout | 10-second timeout. Retry up to 3 times. Mark as failed after exhausting retries. |
| Invalid webhook URL | Validate URL format on registration. Reject invalid URLs with 400 error. |

### Notification Delivery Errors

| Error | Handling Strategy |
|-------|-------------------|
| Email delivery failure | Retry up to 3 times with exponential backoff. Mark notification as failed. |
| In-app notification failure | Retry up to 3 times. Log error. |

### API Errors

| Error | Handling Strategy |
|-------|-------------------|
| Missing/invalid API key | Return HTTP 401 with `{ status: "error", data: null, error: "Invalid or missing API key" }` |
| Invalid request parameters | Return HTTP 400 with descriptive error message in the error field |
| Resource not found | Return HTTP 404 with error message |
| Internal server error | Return HTTP 500 with generic error message. Log full error details server-side. |
| Rate limit exceeded (API-level) | Return HTTP 429 with `Retry-After` header |

### Data Processing Errors

| Error | Handling Strategy |
|-------|-------------------|
| Sentiment analysis failure | Log error, skip the item, continue processing batch. Return partial results with a warning. |
| Theme classification failure | Log error, label as "uncategorized", continue processing. |
| Keyword extraction failure | Log error, return empty keyword list for the affected item. |

## Testing Strategy

### Testing Framework

- **Test runner**: Vitest (fast, TypeScript-native, compatible with the Node.js ecosystem)
- **Property-based testing**: `fast-check` library for generating random inputs and verifying properties
- **HTTP mocking**: `msw` (Mock Service Worker) for mocking Reddit JSON endpoint responses
- **Database testing**: Test containers or in-memory SQLite for isolated database tests

### Unit Tests

Unit tests cover specific examples, edge cases, and error conditions:

- **RedditScraper**: URL construction for various parameter combinations, response parsing for different Reddit JSON structures, error handling for malformed responses
- **ThemeClassifierService**: Classification of known text samples, edge cases (empty text, very long text, mixed-language text), uncategorized threshold behavior
- **SentimentAnalyzerService**: Known positive/negative/neutral texts, edge cases (empty string, single word, emoji-heavy text), normalization boundary values
- **SubredditAnalyzerService**: Post type classification edge cases (ambiguous URLs, missing fields), empty post sets, single-post sets
- **ContributorRankerService**: Zero-activity contributors, single-post contributors, tie-breaking in rankings
- **ProxyManager**: Fallback behavior when no proxy configured, retry logic with mocked HTTP errors (429, 403, 5xx)
- **WebhookService**: HMAC-SHA256 signing with known test vectors, URL validation, retry exhaustion
- **API middleware**: Authentication with valid/invalid/missing keys, pagination parameter validation, response envelope consistency
- **NotificationService**: Preference-based routing, retry logic, permalink inclusion

### Property-Based Tests

Each property test uses `fast-check` with a minimum of 100 iterations and references its design document property.

Property tests are tagged with: **Feature: reddit-data-scraper, Property {number}: {title}**

Key property test groups:

1. **Search & Filtering** (Properties 1–2): URL construction, client-side exclusion filtering
2. **Theme Classification** (Properties 3–6): Theme assignment, confidence bounds, filtering, uncategorized labeling
3. **Keyword Tracking** (Properties 7–8): Frequency counting, match content filtering
4. **Theme Summarization** (Property 9): Frequency-based ranking
5. **Subreddit Analysis** (Properties 10–15): Post type classification, flair distribution, keyword extraction, top posts ordering, growth metrics, engagement metrics
6. **Sentiment Analysis** (Properties 16–18): Label consistency, score bounds, distribution percentages
7. **Contributor Ranking** (Properties 19–22): Ranking order, influence formula, averages, timeframe filtering
8. **Infrastructure** (Properties 23–27): Rate limiter timing, API envelope, authentication, webhook signatures, pagination

### Integration Tests

Integration tests verify end-to-end flows with mocked Reddit endpoints:

- Full search flow: API request → scraper → mock Reddit → response parsing → client-side filtering → API response
- Keyword polling cycle: BullMQ job → scraper → match detection → notification dispatch
- Webhook delivery cycle: Event trigger → signing → HTTP POST → retry on failure
- Subreddit snapshot recording and growth metric computation over multiple snapshots
- Contributor ranking refresh cycle

### Test Organization

```
src/
├── __tests__/
│   ├── unit/
│   │   ├── scraper.test.ts
│   │   ├── proxy-manager.test.ts
│   │   ├── rate-limiter.test.ts
│   │   ├── theme-classifier.test.ts
│   │   ├── sentiment-analyzer.test.ts
│   │   ├── keyword-tracker.test.ts
│   │   ├── subreddit-analyzer.test.ts
│   │   ├── contributor-ranker.test.ts
│   │   ├── webhook-service.test.ts
│   │   ├── notification-service.test.ts
│   │   └── api-middleware.test.ts
│   ├── property/
│   │   ├── search-filtering.property.test.ts
│   │   ├── theme-classification.property.test.ts
│   │   ├── keyword-tracking.property.test.ts
│   │   ├── subreddit-analysis.property.test.ts
│   │   ├── sentiment-analysis.property.test.ts
│   │   ├── contributor-ranking.property.test.ts
│   │   └── infrastructure.property.test.ts
│   └── integration/
│       ├── search-flow.integration.test.ts
│       ├── keyword-polling.integration.test.ts
│       ├── webhook-delivery.integration.test.ts
│       └── subreddit-snapshot.integration.test.ts
```
