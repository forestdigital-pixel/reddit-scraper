# Implementation Plan: Reddit Data Scraper

## Overview

Build a Node.js/TypeScript backend service that scrapes Reddit via public JSON endpoints, analyzes content (themes, sentiment, contributors), and exposes a REST API with webhook support for n8n integration. The implementation proceeds bottom-up: core infrastructure first (proxy, rate limiter, scraper), then services (search, themes, sentiment, keywords, subreddit stats, contributors), then notifications/webhooks, and finally the Express API layer that wires everything together.

## Tasks

- [x] 1. Project setup and core infrastructure
  - [x] 1.1 Initialize Node.js/TypeScript project
    - Initialize with `npm init`, install TypeScript, Express, `pg`, `bullmq`, `ioredis`, `sentiment`, `https-proxy-agent`, `dotenv`, `uuid`
    - Configure `tsconfig.json` with strict mode, ES2022 target, Node module resolution
    - Set up Vitest and `fast-check` as dev dependencies
    - Create directory structure: `src/`, `src/services/`, `src/core/`, `src/routes/`, `src/models/`, `src/jobs/`, `src/__tests__/unit/`, `src/__tests__/property/`, `src/__tests__/integration/`
    - Create `.env.example` with placeholders for `DATABASE_URL`, `REDIS_URL`, `PROXY_URL`, `API_KEY`, `SMTP_*`, `USER_AGENT`
    - _Requirements: 9.2, 10.1_

  - [x] 1.2 Implement RateLimiter
    - Create `src/core/rate-limiter.ts` implementing the `RateLimiter` class
    - Token-bucket approach: `acquire()` returns a Promise that resolves after the minimum interval has elapsed since the last request
    - Constructor accepts `minIntervalMs` (default 2000ms)
    - Implement `getQueueLength()` to report pending requests
    - _Requirements: 9.4_

  - [x] 1.3 Write property test for RateLimiter
    - **Property 23: Rate limiter enforces minimum interval**
    - **Validates: Requirements 9.4**

  - [x] 1.4 Implement ProxyManager
    - Create `src/core/proxy-manager.ts` implementing the `ProxyManager` class
    - Load proxy URL from environment variable `PROXY_URL`
    - Use `https-proxy-agent` to create an agent for proxied requests
    - Implement `fetch()` with retry logic: up to 3 retries with exponential backoff (2s, 8s, 32s) on 429/403/5xx
    - Set custom `User-Agent` header on every request from config
    - Fall back to direct connection if no proxy configured, log warning
    - Log all failed requests with timestamps
    - _Requirements: 9.1, 9.2, 9.3, 9.5, 9.6, 9.7_

  - [x] 1.5 Write unit tests for ProxyManager
    - Test fallback behavior when no proxy configured
    - Test retry logic with mocked HTTP errors (429, 403, 5xx)
    - Test custom User-Agent header is set
    - _Requirements: 9.1, 9.3, 9.5, 9.6_

  - [x] 1.6 Implement RedditScraper
    - Create `src/core/reddit-scraper.ts` implementing the `RedditScraper` class
    - Implement `fetchSearch()`: construct URL from `SearchParams`, call ProxyManager, parse Reddit JSON listing response
    - Implement `fetchSubredditPosts()`: fetch posts from `r/{subreddit}/{sort}.json`
    - Implement `fetchSubredditAbout()`: fetch from `r/{subreddit}/about.json`
    - Implement `fetchPostComments()`: fetch from `r/{subreddit}/comments/{postId}.json`, flatten comment tree
    - Implement `fetchNewPosts()`: fetch from `r/{subreddit}/new.json`
    - Handle pagination via `after` parameter, limit max 100 per request
    - Parse Reddit JSON `data.children` into typed `RedditPost` and `RedditComment` interfaces
    - _Requirements: 1.1, 1.2, 1.3, 1.6, 1.8_

  - [x] 1.7 Write property test for RedditScraper URL construction
    - **Property 1: Search URL construction preserves all parameters**
    - **Validates: Requirements 1.2, 1.3, 1.6, 1.8**

- [x] 2. Database schema and data models
  - [x] 2.1 Create PostgreSQL migration and data models
    - Create `src/db/` directory with connection pool setup using `pg`
    - Create migration SQL file with all tables from the design: `users`, `reddit_posts`, `reddit_comments`, `theme_classifications`, `sentiment_results`, `tracked_keywords`, `keyword_frequencies`, `keyword_matches`, `subreddit_snapshots`, `contributor_scores`, `webhook_registrations`, `webhook_deliveries`, `notifications`, `notification_preferences`
    - Add all indexes specified in the design (composite indexes on subreddit+created_utc, content_id+content_type, etc.)
    - Create TypeScript interfaces in `src/models/` matching the database schema
    - Create a migration runner script
    - _Requirements: 3.2, 5.6, 8.1, 10.1_

- [x] 3. Checkpoint - Core infrastructure review
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Search and filtering service
  - [x] 4.1 Implement SearchService
    - Create `src/services/search-service.ts`
    - Implement `search()`: accept query, subreddit, sort, timeframe, exclude_keywords, exclude_users, pagination params
    - Call `RedditScraper.fetchSearch()` with constructed `SearchParams`
    - Apply client-side filtering: remove posts containing excluded keywords (check title + selftext), remove posts by excluded users
    - Cache results in `reddit_posts` table
    - Return filtered results with pagination metadata
    - Handle empty results with appropriate message
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8_

  - [x] 4.2 Write property test for client-side exclusion filtering
    - **Property 2: Client-side exclusion filtering removes all matching content**
    - **Validates: Requirements 1.4, 1.5**

- [x] 5. Theme classification service
  - [x] 5.1 Implement ThemeClassifierService
    - Create `src/services/theme-classifier-service.ts`
    - Define keyword dictionaries for each theme: `pain_points`, `solution_requests`, `money_talk`, `hot_discussions`, `seeking_alternatives`
    - Implement `classify()`: tokenize text, match against dictionaries, compute weighted scores normalized to 0.0–1.0
    - Apply engagement boost for `hot_discussions` theme based on score/comment count
    - Label as `uncategorized` if no theme exceeds 0.3 confidence threshold
    - Implement `classifyBatch()` for bulk classification
    - Implement `filterByTheme()` to return only items matching a given theme
    - Implement `summarizeThemes()` to aggregate and rank items by frequency
    - Store classifications in `theme_classifications` table
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 5.2 Write property tests for ThemeClassifierService
    - **Property 3: Theme classification assigns correct themes for keyword-bearing text**
    - **Validates: Requirements 2.1, 2.4**

  - [x] 5.3 Write property test for confidence bounds
    - **Property 4: Theme confidence scores are bounded**
    - **Validates: Requirements 2.2**

  - [x] 5.4 Write property test for theme filtering
    - **Property 5: Theme filtering returns only matching content**
    - **Validates: Requirements 2.3, 6.4**

  - [x] 5.5 Write property test for uncategorized labeling
    - **Property 6: Low-confidence text is labeled uncategorized**
    - **Validates: Requirements 2.5**

- [x] 6. Sentiment analysis service
  - [x] 6.1 Implement SentimentAnalyzerService
    - Create `src/services/sentiment-analyzer-service.ts`
    - Use the `sentiment` npm package (AFINN-165)
    - Implement `analyze()`: run sentiment analysis, normalize comparative score to [-1.0, 1.0] range, assign label (positive > 0.05, negative < -0.05, neutral otherwise)
    - Implement `analyzeBatch()` for bulk analysis
    - Implement `getAggregateDistribution()`: compute percentage of positive/negative/neutral from a set of results
    - Implement `getTimeSeries()`: query `sentiment_results` table for time-series data
    - Store results in `sentiment_results` table
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x] 6.2 Write property tests for SentimentAnalyzerService
    - **Property 16: Sentiment label is consistent with score**
    - **Validates: Requirements 6.1**

  - [x] 6.3 Write property test for sentiment score bounds
    - **Property 17: Sentiment score is bounded**
    - **Validates: Requirements 6.2**

  - [x] 6.4 Write property test for sentiment distribution
    - **Property 18: Sentiment distribution percentages sum to 100%**
    - **Validates: Requirements 6.3**

- [x] 7. Checkpoint - Services review
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Keyword tracking service
  - [x] 8.1 Implement KeywordTrackerService
    - Create `src/services/keyword-tracker-service.ts`
    - Implement `addKeyword()`: insert into `tracked_keywords` table, return `TrackedKeyword`
    - Implement `removeKeyword()`: soft-delete by setting `is_active = false`
    - Implement `getKeywords()`: fetch all active keywords for a user
    - Implement `pollKeyword()`: call `RedditScraper.fetchSearch()` for the keyword, detect new matches, store in `keyword_matches`, update `keyword_frequencies`
    - Implement `getFrequencyTimeSeries()`: query `keyword_frequencies` for date range
    - Implement `getRecentMatches()`: query `keyword_matches` joined with `reddit_posts`/`reddit_comments`
    - Implement `flagInactiveKeywords()`: mark keywords with zero matches in past 30 days as inactive
    - Support minimum 50 keywords per user
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [x] 8.2 Write property test for keyword frequency counting
    - **Property 7: Daily keyword frequency equals match count**
    - **Validates: Requirements 3.2**

  - [x] 8.3 Write property test for keyword match content
    - **Property 8: Keyword match results all contain the keyword**
    - **Validates: Requirements 3.4**

  - [x] 8.4 Write property test for theme summary ranking
    - **Property 9: Theme summary ranks items by frequency descending**
    - **Validates: Requirements 4.2, 4.3, 4.4**

- [x] 9. Subreddit analysis service
  - [x] 9.1 Implement SubredditAnalyzerService
    - Create `src/services/subreddit-analyzer-service.ts`
    - Implement `getStats()`: orchestrate fetching subreddit about data, recent posts, and compute all metrics
    - Implement `classifyPostType()`: return `text` when `is_self` is true, `image` for image URL extensions, `video` for video extensions/domains, `link` otherwise
    - Implement `extractTopKeywords()`: tokenize titles + selftext, count occurrences, return top 20 sorted by count descending
    - Implement `computeEngagementMetrics()`: compute `avgScorePerPost` and `avgCommentsPerPost` from post data
    - Implement `recordSnapshot()`: store current subscriber/active user counts in `subreddit_snapshots`
    - Compute growth metrics by comparing current snapshot to previous snapshot
    - Compute `avgPostsPerDay` from posts with `created_utc` over past 30 days
    - Compute flair distribution as percentages from `link_flair_text` field
    - Return top 10 posts by score
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

  - [x] 9.2 Write property test for post type classification
    - **Property 10: Post type classification is deterministic and correct**
    - **Validates: Requirements 5.2**

  - [x] 9.3 Write property test for flair distribution
    - **Property 11: Flair distribution percentages sum to 100%**
    - **Validates: Requirements 5.3**

  - [x] 9.4 Write property test for top keywords
    - **Property 12: Top keywords are ordered by count and limited to 20**
    - **Validates: Requirements 5.4**

  - [x] 9.5 Write property test for top posts ordering
    - **Property 13: Top posts are ordered by score and limited to 10**
    - **Validates: Requirements 5.5**

  - [x] 9.6 Write property test for growth metrics
    - **Property 14: Growth metrics computation is correct**
    - **Validates: Requirements 5.6**

  - [x] 9.7 Write property test for engagement metrics
    - **Property 15: Engagement metrics are correct averages**
    - **Validates: Requirements 5.7**

- [x] 10. Contributor ranking service
  - [x] 10.1 Implement ContributorRankerService
    - Create `src/services/contributor-ranker-service.ts`
    - Implement `getTopContributors()`: query `contributor_scores` for a subreddit, return top N (max 25) ordered by influence score descending
    - Implement `getContributorProfile()`: return a single contributor's stats for a subreddit
    - Implement `computeInfluenceScore()`: apply formula `(totalPostScore * 1.0) + (totalCommentScore * 0.5) + (postCount * 10) + (commentCount * 2)`
    - Implement `refreshRankings()`: scrape recent posts/comments for a subreddit, aggregate by author, compute scores, upsert into `contributor_scores`
    - Support timeframe filtering using `created_utc` timestamps
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [x] 10.2 Write property test for contributor ranking order
    - **Property 19: Contributor ranking is ordered by influence score**
    - **Validates: Requirements 8.1**

  - [x] 10.3 Write property test for influence score formula
    - **Property 20: Influence score follows the defined formula**
    - **Validates: Requirements 8.2**

  - [x] 10.4 Write property test for contributor averages
    - **Property 21: Contributor averages are correctly computed**
    - **Validates: Requirements 8.3**

  - [x] 10.5 Write property test for timeframe filtering
    - **Property 22: Timeframe filtering includes only activity within range**
    - **Validates: Requirements 8.4**

- [x] 11. Checkpoint - All services review
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Notification and webhook services
  - [x] 12.1 Implement WebhookService
    - Create `src/services/webhook-service.ts`
    - Implement `register()`: validate URL, generate HMAC secret, store in `webhook_registrations`
    - Implement `unregister()`: deactivate webhook registration
    - Implement `dispatch()`: serialize payload, sign with HMAC-SHA256, POST to registered URLs, store delivery in `webhook_deliveries`
    - Implement `sign()` and `verify()` for HMAC-SHA256 signature generation and verification
    - Retry failed deliveries up to 3 times with exponential backoff (1s, 4s, 16s)
    - _Requirements: 10.4, 10.5, 10.6_

  - [x] 12.2 Write property test for webhook signatures
    - **Property 26: Webhook signature round-trip**
    - **Validates: Requirements 10.5**

  - [x] 12.3 Write unit tests for WebhookService
    - Test HMAC-SHA256 signing with known test vectors
    - Test URL validation
    - Test retry exhaustion behavior
    - _Requirements: 10.4, 10.5, 10.6_

  - [x] 12.4 Implement NotificationService
    - Create `src/services/notification-service.ts`
    - Implement `sendNotification()`: route to email or in-app channel based on user preferences
    - Implement `getPreferences()` and `updatePreferences()`: CRUD on `notification_preferences` table
    - Implement `retryFailed()`: query failed notifications, retry up to 3 times with exponential backoff
    - Include permalink to original Reddit content in every notification
    - Store notifications in `notifications` table with status tracking
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

  - [x] 12.5 Write unit tests for NotificationService
    - Test preference-based routing (email vs in-app)
    - Test retry logic
    - Test permalink inclusion
    - _Requirements: 7.2, 7.3, 7.5, 7.6_

- [x] 13. Background jobs with BullMQ
  - [x] 13.1 Set up BullMQ job infrastructure
    - Create `src/jobs/` with queue setup and worker configuration using `ioredis` connection
    - Define queues: `keyword-polling`, `subreddit-snapshot`, `contributor-refresh`, `webhook-dispatch`, `notification-dispatch`
    - _Requirements: 3.1, 5.6, 8.5, 10.4, 7.1_

  - [x] 13.2 Implement keyword polling job
    - Create `src/jobs/keyword-polling-job.ts`
    - Poll every ~10 minutes for each active keyword
    - Call `KeywordTrackerService.pollKeyword()` for each active keyword
    - On new matches: trigger `NotificationService.sendNotification()` and `WebhookService.dispatch('keyword_match', ...)`
    - Ensure 30-minute SLA for notification delivery
    - _Requirements: 7.1, 7.4, 10.4_

  - [x] 13.3 Implement subreddit snapshot and contributor refresh jobs
    - Create `src/jobs/subreddit-snapshot-job.ts`: periodically call `SubredditAnalyzerService.recordSnapshot()`
    - Create `src/jobs/contributor-refresh-job.ts`: call `ContributorRankerService.refreshRankings()` at least once every 24 hours
    - _Requirements: 5.6, 8.5_

  - [x] 13.4 Implement webhook and notification dispatch jobs
    - Create `src/jobs/webhook-dispatch-job.ts`: process queued webhook deliveries with retry logic
    - Create `src/jobs/notification-dispatch-job.ts`: process queued notifications with retry logic
    - _Requirements: 10.6, 7.5_

- [x] 14. Express API layer
  - [x] 14.1 Implement API key authentication middleware
    - Create `src/routes/middleware/auth.ts`
    - Validate `X-API-Key` header against `users` table
    - Return 401 for missing or invalid keys
    - Skip auth for `GET /health`
    - _Requirements: 10.3_

  - [x] 14.2 Write property test for API key authentication
    - **Property 25: API key authentication enforcement**
    - **Validates: Requirements 10.3**

  - [x] 14.3 Implement response envelope and pagination utilities
    - Create `src/routes/middleware/response.ts` with `ApiResponse<T>` envelope helper
    - Create pagination utility: parse `page` and `page_size` query params, default page_size=25, max 100
    - Ensure all responses follow `{ status, data, error, pagination? }` structure
    - _Requirements: 10.2, 10.8_

  - [x] 14.4 Write property tests for API response envelope and pagination
    - **Property 24: API response envelope structure**
    - **Validates: Requirements 10.2**
    - **Property 27: Pagination respects bounds**
    - **Validates: Requirements 10.8**

  - [x] 14.5 Implement search routes
    - Create `src/routes/search-routes.ts`
    - `GET /api/v1/search` — wire to `SearchService.search()` with query params: `q`, `subreddit`, `sort`, `timeframe`, `exclude_keywords`, `exclude_users`, `page`, `page_size`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8_

  - [x] 14.6 Implement keyword routes
    - Create `src/routes/keyword-routes.ts`
    - `GET /api/v1/keywords` — list tracked keywords
    - `POST /api/v1/keywords` — add keyword
    - `DELETE /api/v1/keywords/:id` — remove keyword
    - `GET /api/v1/keywords/:id/frequency` — frequency time series
    - `GET /api/v1/keywords/:id/matches` — recent matches
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [x] 14.7 Implement subreddit, sentiment, theme, audience research, and contributor routes
    - Create `src/routes/subreddit-routes.ts`
    - `GET /api/v1/subreddits/:name/stats` — subreddit statistics
    - `GET /api/v1/subreddits/:name/sentiment` — sentiment analysis with optional theme filter
    - `GET /api/v1/subreddits/:name/contributors` — top contributors
    - `GET /api/v1/subreddits/:name/contributors/:username` — contributor profile
    - Create `src/routes/theme-routes.ts`
    - `POST /api/v1/themes/classify` — classify subreddit content
    - `GET /api/v1/themes/:theme/discussions` — get discussions by theme
    - Create `src/routes/audience-routes.ts`
    - `POST /api/v1/audience-research` — audience research across subreddits
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 6.1, 6.2, 6.3, 6.4, 6.5, 8.1, 8.2, 8.3, 8.4_

  - [x] 14.8 Implement webhook and notification routes
    - Create `src/routes/webhook-routes.ts`
    - `GET /api/v1/webhooks` — list webhooks
    - `POST /api/v1/webhooks` — register webhook
    - `DELETE /api/v1/webhooks/:id` — unregister webhook
    - Create `src/routes/notification-routes.ts`
    - `GET /api/v1/notifications/preferences` — get preferences
    - `PUT /api/v1/notifications/preferences` — update preferences
    - _Requirements: 10.4, 10.5, 7.2, 7.3_

  - [x] 14.9 Implement health endpoint and wire Express app
    - Create `src/routes/health-routes.ts` with `GET /health` returning service status
    - Create `src/app.ts` wiring all route modules, middleware (auth, error handling, JSON parsing)
    - Create `src/index.ts` entry point: initialize DB pool, Redis connection, BullMQ workers, start Express server
    - _Requirements: 10.7, 10.1_

- [x] 15. Checkpoint - Full API review
  - Ensure all tests pass, ask the user if questions arise.

- [x] 16. Final integration and wiring
  - [x] 16.1 Audience research orchestration
    - Wire `POST /api/v1/audience-research` to fetch posts from multiple subreddits, classify themes, summarize pain points and solution requests, rank by frequency
    - Ensure drill-down returns original posts/comments contributing to each summary item
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x] 16.2 Write integration tests for key flows
    - Test full search flow: API request → scraper → mock Reddit → filtering → API response
    - Test keyword polling cycle: BullMQ job → scraper → match detection → notification
    - Test webhook delivery cycle: event → signing → POST → retry
    - Test subreddit snapshot recording and growth metric computation
    - _Requirements: 1.1, 3.1, 7.1, 10.4, 5.6_

- [x] 17. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at key milestones
- Property tests validate the 27 correctness properties defined in the design document using `fast-check`
- Unit tests validate specific examples and edge cases
- The implementation uses TypeScript throughout with Vitest as the test runner
- All Reddit requests are routed through ProxyManager → RateLimiter → Webshare proxy
