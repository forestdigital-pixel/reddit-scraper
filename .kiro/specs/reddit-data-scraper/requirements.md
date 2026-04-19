# Requirements Document

## Introduction

A Reddit data scraper and audience research platform inspired by Gummy Search. The system fetches Reddit data exclusively via the Reddit JSON method (appending `.json` to Reddit URLs, e.g. `reddit.com/r/subreddit/new.json`). This approach requires no API keys or OAuth authentication but has inherent limitations: max 100 posts per request, ~1000 items per listing, no real-time push/streaming, and no historical subscriber data. The system enables users to search Reddit content, categorize conversations into actionable themes, track keywords over time, analyze sentiment, gather subreddit statistics, identify influential contributors, and receive polling-based notifications for relevant discussions. The goal is to provide a comprehensive tool for audience research, market validation, and community monitoring using Reddit as a data source.

## Glossary

- **Scraper**: The core system component responsible for fetching and processing Reddit data via the Reddit JSON method (appending `.json` to Reddit URLs). Limited to 100 posts per request with pagination via the `after` parameter, and approximately 1000 items per listing
- **Theme_Classifier**: The component that categorizes Reddit posts and comments into predefined conversation themes
- **Keyword_Tracker**: The component that monitors Reddit for specified keywords and tracks their frequency over time
- **Sentiment_Analyzer**: The component that determines the emotional tone (positive, negative, neutral) of Reddit posts and comments
- **Notification_Service**: The component that sends alerts to users when tracked keywords or topics appear in new Reddit content. Operates via periodic polling of Reddit JSON endpoints since no real-time push/streaming is available
- **Subreddit_Analyzer**: The component that computes and presents statistics about a given subreddit. Note: Reddit JSON provides current subscriber count and active users but no historical subscriber data — growth tracking requires the system to record snapshots over time
- **Contributor_Ranker**: The component that identifies and ranks influential users within subreddits. Reddit JSON does not provide per-subreddit karma — influence scores are computed by aggregating post/comment scores from scraped data within the target subreddit
- **Proxy_Manager**: The component that routes all outbound HTTP requests to Reddit through a rotating proxy service (e.g. Webshare) using the `http://username-rotate:password@host:port` format to avoid IP-based rate limiting and blocks
- **API_Gateway**: The component that exposes the scraper's functionality as REST API endpoints and supports outbound webhook delivery, enabling integration with automation platforms like n8n
- **Search_Engine**: The component that allows users to query Reddit content with filters and sorting options. Uses `reddit.com/search.json?q=keyword` for full-text search. Keyword exclusion and user exclusion filters are applied client-side after fetching results
- **Conversation_Theme**: A category label assigned to a Reddit discussion, such as Pain Points, Solution Requests, Money Talk, Hot Discussions, or Seeking Alternatives
- **Pain_Points**: Discussions where users express frustration, complaints, or unmet needs
- **Solution_Requests**: Discussions where users ask for recommendations, tools, or solutions
- **Money_Talk**: Discussions involving pricing, revenue, costs, or willingness to pay
- **Hot_Discussions**: Discussions with high engagement (upvotes, comments) relative to the subreddit norm
- **Seeking_Alternatives**: Discussions where users look for alternatives to existing products or services
- **Subreddit**: A community forum on Reddit dedicated to a specific topic
- **Contributor**: A Reddit user who posts or comments within a subreddit

## Requirements

### Requirement 1: Reddit Content Search

**User Story:** As a researcher, I want to search Reddit content with advanced filters, so that I can find relevant discussions across communities.

#### Acceptance Criteria

1. WHEN a search query is submitted, THE Search_Engine SHALL query `reddit.com/search.json` and return matching Reddit posts and comments ranked by relevance
2. WHEN a search query includes subreddit filters, THE Search_Engine SHALL restrict results to the specified subreddits using the `restrict_sr` parameter or by querying `reddit.com/r/{subreddit}/search.json`
3. WHEN a search query includes a timeframe filter, THE Search_Engine SHALL use the `t` parameter (hour, day, week, month, year, all) to return only results within the specified timeframe
4. WHEN a search query includes excluded keywords, THE Search_Engine SHALL apply client-side filtering to omit results containing those keywords from the response
5. WHEN a search query includes excluded users, THE Search_Engine SHALL apply client-side filtering to omit results authored by those users from the response
6. WHEN a search query includes a sort parameter, THE Search_Engine SHALL order results according to the specified sort criteria (relevance, new, hot, top, comments) using the `sort` parameter
7. IF a search query returns no results, THEN THE Search_Engine SHALL display a message indicating no matching content was found
8. WHEN paginating through results, THE Search_Engine SHALL use the `after` parameter from the previous response to fetch the next page of up to 100 results

### Requirement 2: Conversation Theme Categorization

**User Story:** As a researcher, I want Reddit discussions automatically categorized into themes, so that I can quickly identify actionable insights from community conversations.

#### Acceptance Criteria

1. WHEN Reddit posts and comments are retrieved, THE Theme_Classifier SHALL assign each discussion to one or more Conversation_Themes (Pain_Points, Solution_Requests, Money_Talk, Hot_Discussions, Seeking_Alternatives)
2. THE Theme_Classifier SHALL provide a confidence score between 0.0 and 1.0 for each assigned Conversation_Theme
3. WHEN a user filters results by a specific Conversation_Theme, THE Theme_Classifier SHALL return only discussions matching that theme
4. WHEN a discussion matches multiple Conversation_Themes, THE Theme_Classifier SHALL assign all applicable themes to that discussion
5. IF the Theme_Classifier cannot determine a theme with a confidence score above 0.3, THEN THE Theme_Classifier SHALL label the discussion as "Uncategorized"

### Requirement 3: Keyword Tracking

**User Story:** As a marketer, I want to track specific keywords on Reddit over time, so that I can monitor trends and discover emerging conversations relevant to my business.

#### Acceptance Criteria

1. WHEN a user adds a keyword to the tracking list, THE Keyword_Tracker SHALL begin monitoring Reddit for new posts and comments containing that keyword
2. WHILE a keyword is being tracked, THE Keyword_Tracker SHALL record the frequency of mentions per day
3. WHEN a user views a tracked keyword, THE Keyword_Tracker SHALL display a time-series chart of mention frequency
4. WHEN a user views a tracked keyword, THE Keyword_Tracker SHALL list the most recent posts and comments containing that keyword
5. THE Keyword_Tracker SHALL support tracking a minimum of 50 keywords per user simultaneously
6. IF a tracked keyword has zero mentions in the past 30 days, THEN THE Keyword_Tracker SHALL flag the keyword as inactive

### Requirement 4: Audience Research & Pain Point Discovery

**User Story:** As a product manager, I want to understand what problems my target audience discusses on Reddit, so that I can validate product ideas and identify unmet needs.

#### Acceptance Criteria

1. WHEN a user selects one or more subreddits for audience research, THE Scraper SHALL retrieve recent posts and comments from those subreddits
2. WHEN audience research data is retrieved, THE Theme_Classifier SHALL summarize the top Pain_Points discussed in the selected subreddits
3. WHEN audience research data is retrieved, THE Theme_Classifier SHALL summarize the top Solution_Requests discussed in the selected subreddits
4. THE Theme_Classifier SHALL rank Pain_Points and Solution_Requests by frequency of occurrence
5. WHEN a user drills into a specific Pain_Point or Solution_Request, THE Scraper SHALL display the original Reddit posts and comments that contributed to that summary

### Requirement 5: Subreddit Statistics & Details

**User Story:** As a researcher, I want to view detailed statistics about subreddits, so that I can evaluate community size, engagement, and content patterns.

#### Acceptance Criteria

1. WHEN a user selects a subreddit, THE Subreddit_Analyzer SHALL display the subreddit subscriber count (from `subscribers` field) and active user count (from `accounts_active` field)
2. WHEN a user selects a subreddit, THE Subreddit_Analyzer SHALL fetch recent posts and classify them by type (text via `is_self`, link via `domain`, image/video inferred from `url` file extensions and `domain`) and display the distribution as percentages
3. WHEN a user selects a subreddit, THE Subreddit_Analyzer SHALL display the distribution of post flairs using the `link_flair_text` field from scraped posts
4. WHEN a user selects a subreddit, THE Subreddit_Analyzer SHALL extract and display the top 20 most common keywords found in post `title` and `selftext` fields
5. WHEN a user selects a subreddit, THE Subreddit_Analyzer SHALL display the top 10 posts by `score` within a user-specified timeframe using the `t` sort parameter
6. WHEN a user selects a subreddit, THE Subreddit_Analyzer SHALL display growth metrics by comparing the current subscriber count against previously recorded snapshots stored by the system, and compute average posts per day from scraped post `created_utc` timestamps over the past 30 days
7. WHEN a user selects a subreddit, THE Subreddit_Analyzer SHALL display average engagement metrics including mean `score` per post and mean `num_comments` per post computed from scraped data over the past 30 days

### Requirement 6: Sentiment Analysis

**User Story:** As a brand manager, I want to analyze the sentiment of discussions within specific subreddits, so that I can gauge community perception of topics or products.

#### Acceptance Criteria

1. WHEN a user requests sentiment analysis for a subreddit, THE Sentiment_Analyzer SHALL classify each post and comment as positive, negative, or neutral
2. THE Sentiment_Analyzer SHALL assign a sentiment score between -1.0 (most negative) and 1.0 (most positive) to each analyzed post and comment
3. WHEN sentiment analysis is complete, THE Sentiment_Analyzer SHALL display an aggregate sentiment distribution (percentage of positive, negative, neutral) for the subreddit
4. WHEN a user filters sentiment results by Conversation_Theme, THE Sentiment_Analyzer SHALL display sentiment distribution for only the selected theme
5. WHEN a user specifies a timeframe for sentiment analysis, THE Sentiment_Analyzer SHALL display a time-series chart of average sentiment score over that period

### Requirement 7: Real-Time Notifications

**User Story:** As a business owner, I want to receive notifications when relevant conversations happen on Reddit, so that I can engage with potential customers or respond to mentions promptly.

#### Acceptance Criteria

1. WHEN a new Reddit post or comment matches a user's tracked keyword, THE Notification_Service SHALL send a notification to the user within 30 minutes of the content being posted, based on a polling interval of approximately 10 minutes against `search.json` or `new.json` endpoints
2. THE Notification_Service SHALL support notification delivery via email and in-app channels
3. WHEN a user configures notification preferences, THE Notification_Service SHALL respect the selected delivery channels and frequency settings
4. WHILE notifications are enabled for a keyword, THE Notification_Service SHALL continue polling and alerting until the user disables notifications for that keyword
5. IF the Notification_Service fails to deliver a notification, THEN THE Notification_Service SHALL retry delivery up to 3 times with exponential backoff
6. WHEN a user receives a notification, THE Notification_Service SHALL include a direct link to the original Reddit post or comment using the `permalink` field

### Requirement 8: Influential Contributor Identification

**User Story:** As a community manager, I want to identify the most influential contributors in specific subreddits, so that I can understand who drives conversations and engagement.

#### Acceptance Criteria

1. WHEN a user selects a subreddit, THE Contributor_Ranker SHALL identify and rank the top 25 contributors by an influence score computed from scraped data within that subreddit
2. THE Contributor_Ranker SHALL compute the influence score by aggregating each contributor's total post `score`, total comment `score`, number of posts, and number of comments from scraped data within the selected subreddit
3. WHEN a user views a contributor profile, THE Contributor_Ranker SHALL display the contributor's post count, comment count, average `score` per post, and average `score` per comment within the subreddit, all computed from scraped data
4. WHEN a user specifies a timeframe, THE Contributor_Ranker SHALL compute influence scores based only on scraped activity within that timeframe using `created_utc` timestamps
5. THE Contributor_Ranker SHALL update influence rankings at least once every 24 hours by re-scraping recent subreddit data


### Requirement 9: Proxy & Rate Limit Management

**User Story:** As a system operator, I want all Reddit requests routed through a rotating proxy, so that the scraper avoids IP-based rate limiting and blocks from Reddit.

#### Acceptance Criteria

1. THE Proxy_Manager SHALL route all outbound HTTP requests to Reddit JSON endpoints through a configured rotating proxy using the `http://username-rotate:password@host:port` format (e.g. Webshare)
2. THE Proxy_Manager SHALL load proxy credentials from Railway environment variables (configured via the Railway dashboard), and SHALL NOT hardcode credentials in source code. Locally, credentials SHALL be loaded from a `.env` file
3. WHEN a request to Reddit returns a 429 (Too Many Requests) or 403 (Forbidden) status code, THE Proxy_Manager SHALL automatically retry the request up to 3 times with exponential backoff
4. THE Proxy_Manager SHALL enforce a configurable rate limit (default: maximum 1 request per 2 seconds) to stay below Reddit's detection thresholds
5. THE Proxy_Manager SHALL set a custom `User-Agent` header on every request to comply with Reddit's scraping guidelines
6. IF no proxy is configured, THEN THE Proxy_Manager SHALL fall back to direct connections and log a warning that requests may be rate-limited
7. THE Proxy_Manager SHALL log all failed requests (status codes 429, 403, 5xx) with timestamps for monitoring and debugging

### Requirement 10: n8n Integration via REST API & Webhooks

**User Story:** As an automation engineer, I want to connect the Reddit scraper to n8n workflows, so that I can trigger downstream actions (Slack alerts, Google Sheets logging, CRM updates, email campaigns) based on scraped data.

#### Acceptance Criteria

1. THE API_Gateway SHALL expose REST API endpoints for all core scraper functions: search, keyword tracking, subreddit stats, sentiment analysis, theme categorization, and contributor ranking
2. THE API_Gateway SHALL return all responses in JSON format with consistent structure including `status`, `data`, and `error` fields
3. THE API_Gateway SHALL support API key authentication via an `X-API-Key` header to secure access to all endpoints
4. WHEN a user registers a webhook URL, THE API_Gateway SHALL send an HTTP POST request with a JSON payload to that URL whenever a tracked keyword is matched or a new discussion matching a configured theme is detected
5. THE API_Gateway SHALL include a `X-Webhook-Signature` header (HMAC-SHA256) on all outbound webhook requests so that n8n workflows can verify the payload authenticity
6. IF a webhook delivery fails, THEN THE API_Gateway SHALL retry delivery up to 3 times with exponential backoff (1s, 4s, 16s)
7. THE API_Gateway SHALL expose a `GET /health` endpoint that returns the service status, enabling n8n or Railway health checks
8. THE API_Gateway SHALL support pagination on list endpoints via `page` and `page_size` query parameters with a default page size of 25 and a maximum of 100
