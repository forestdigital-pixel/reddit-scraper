import { randomUUID } from 'node:crypto';
import { getPool } from '../db/connection.js';
import type {
  NotificationChannel,
  NotificationStatus,
  NotificationPreference,
  Notification,
  ContentType,
} from '../models/database.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Represents a keyword match that triggers a notification.
 * Includes the permalink to the original Reddit content.
 */
export interface KeywordMatchInfo {
  keywordId: string;
  contentId: string;
  contentType: ContentType;
  permalink: string;
}

/**
 * Parsed notification preferences returned to callers.
 */
export interface NotificationPreferences {
  userId: string;
  channels: NotificationChannel[];
  frequency: 'immediate' | 'hourly' | 'daily';
}

// ---------------------------------------------------------------------------
// Pure helper functions — exported for unit testing
// ---------------------------------------------------------------------------

/**
 * Parses a comma-separated channels string into an array of
 * NotificationChannel values.
 */
export function parseChannels(channelsStr: string): NotificationChannel[] {
  return channelsStr
    .split(',')
    .map((c) => c.trim())
    .filter((c): c is NotificationChannel => c === 'email' || c === 'in_app');
}

/**
 * Computes exponential backoff delay in milliseconds for a given retry
 * attempt (0-indexed). Formula: 2^(attempt+1) * 1000ms → 2s, 4s, 8s.
 */
export function computeBackoffDelay(attempt: number): number {
  return Math.pow(2, attempt + 1) * 1000;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of delivery retries for a failed notification. */
const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// NotificationService
// ---------------------------------------------------------------------------

/**
 * Handles notification delivery for keyword matches.
 *
 * Supports email and in-app channels. Email delivery uses a placeholder
 * stub that logs the email (actual SMTP integration is out of scope).
 * In-app notifications are stored in the `notifications` table with
 * status 'sent'.
 *
 * Every notification includes a permalink to the original Reddit content.
 *
 * **Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 7.6**
 */
export class NotificationService {
  // -----------------------------------------------------------------------
  // sendNotification
  // -----------------------------------------------------------------------

  /**
   * Sends a notification to a user for a keyword match.
   *
   * Routes to email or in-app channel based on user preferences.
   * Creates one notification record per configured channel.
   *
   * **Validates: Requirements 7.1, 7.2, 7.3, 7.6**
   */
  async sendNotification(
    userId: string,
    match: KeywordMatchInfo,
  ): Promise<void> {
    const prefs = await this.getPreferences(userId);

    const deliveryPromises = prefs.channels.map((channel) =>
      this.deliverNotification(userId, match, channel),
    );

    await Promise.allSettled(deliveryPromises);
  }

  // -----------------------------------------------------------------------
  // getPreferences
  // -----------------------------------------------------------------------

  /**
   * Retrieves notification preferences for a user.
   *
   * Returns default preferences (in_app, immediate) if none are configured.
   *
   * **Validates: Requirements 7.2, 7.3**
   */
  async getPreferences(userId: string): Promise<NotificationPreferences> {
    const pool = getPool();

    const result = await pool.query<NotificationPreference>(
      `SELECT id, user_id, channels, frequency
       FROM notification_preferences
       WHERE user_id = $1`,
      [userId],
    );

    if (result.rows.length === 0) {
      // Return defaults when no preferences are configured
      return {
        userId,
        channels: ['in_app'],
        frequency: 'immediate',
      };
    }

    const row = result.rows[0];
    return {
      userId: row.user_id,
      channels: parseChannels(row.channels),
      frequency: row.frequency as NotificationPreferences['frequency'],
    };
  }

  // -----------------------------------------------------------------------
  // updatePreferences
  // -----------------------------------------------------------------------

  /**
   * Creates or updates notification preferences for a user.
   *
   * **Validates: Requirements 7.3**
   */
  async updatePreferences(
    userId: string,
    prefs: Partial<NotificationPreferences>,
  ): Promise<void> {
    const pool = getPool();

    // Build the channels string
    const channelsStr = prefs.channels ? prefs.channels.join(',') : undefined;
    const frequency = prefs.frequency;

    // Check if preferences already exist
    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM notification_preferences WHERE user_id = $1`,
      [userId],
    );

    if (existing.rows.length > 0) {
      // Update existing preferences
      const updates: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (channelsStr !== undefined) {
        updates.push(`channels = $${paramIndex++}`);
        values.push(channelsStr);
      }
      if (frequency !== undefined) {
        updates.push(`frequency = $${paramIndex++}`);
        values.push(frequency);
      }

      if (updates.length > 0) {
        values.push(userId);
        await pool.query(
          `UPDATE notification_preferences SET ${updates.join(', ')} WHERE user_id = $${paramIndex}`,
          values,
        );
      }
    } else {
      // Insert new preferences
      const id = randomUUID();
      await pool.query(
        `INSERT INTO notification_preferences (id, user_id, channels, frequency)
         VALUES ($1, $2, $3, $4)`,
        [
          id,
          userId,
          channelsStr ?? 'in_app',
          frequency ?? 'immediate',
        ],
      );
    }
  }

  // -----------------------------------------------------------------------
  // retryFailed
  // -----------------------------------------------------------------------

  /**
   * Queries failed notifications and retries delivery up to 3 times
   * with exponential backoff.
   *
   * **Validates: Requirements 7.5**
   */
  async retryFailed(): Promise<void> {
    const pool = getPool();

    // Find all failed notifications that haven't exhausted retries
    const result = await pool.query<Notification>(
      `SELECT id, user_id, keyword_id, content_id, channel, permalink,
              status, retry_count, sent_at, created_at
       FROM notifications
       WHERE status = 'failed' AND retry_count < $1
       ORDER BY created_at ASC`,
      [MAX_RETRIES],
    );

    for (const notification of result.rows) {
      // Apply exponential backoff delay
      const delay = computeBackoffDelay(notification.retry_count);
      await this.sleep(delay);

      try {
        await this.attemptDelivery(
          notification.channel,
          notification.user_id,
          notification.permalink,
        );

        // Mark as sent on success
        await pool.query(
          `UPDATE notifications SET status = 'sent', sent_at = NOW(), retry_count = $1
           WHERE id = $2`,
          [notification.retry_count + 1, notification.id],
        );
      } catch {
        // Increment retry count; mark as failed if exhausted
        const newRetryCount = notification.retry_count + 1;
        const newStatus: NotificationStatus =
          newRetryCount >= MAX_RETRIES ? 'failed' : 'failed';

        await pool.query(
          `UPDATE notifications SET status = $1, retry_count = $2
           WHERE id = $3`,
          [newStatus, newRetryCount, notification.id],
        );

        if (newRetryCount >= MAX_RETRIES) {
          console.error(
            `Notification ${notification.id} failed after ${MAX_RETRIES} retries.`,
          );
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Delivers a single notification through the specified channel.
   * Creates a notification record and attempts delivery.
   */
  private async deliverNotification(
    userId: string,
    match: KeywordMatchInfo,
    channel: NotificationChannel,
  ): Promise<void> {
    const pool = getPool();
    const id = randomUUID();
    const now = new Date();

    // Store the notification record as pending
    await pool.query(
      `INSERT INTO notifications (id, user_id, keyword_id, content_id, channel, permalink, status, retry_count, sent_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', 0, NULL, $7)`,
      [id, userId, match.keywordId, match.contentId, channel, match.permalink, now],
    );

    try {
      await this.attemptDelivery(channel, userId, match.permalink);

      // Mark as sent
      await pool.query(
        `UPDATE notifications SET status = 'sent', sent_at = NOW() WHERE id = $1`,
        [id],
      );
    } catch (err) {
      // Mark as failed — retryFailed() will pick it up later
      await pool.query(
        `UPDATE notifications SET status = 'failed' WHERE id = $1`,
        [id],
      );

      console.error(
        `Failed to deliver ${channel} notification ${id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Attempts to deliver a notification through the specified channel.
   *
   * - **email**: Placeholder/stub that logs the email. Actual SMTP
   *   integration is out of scope.
   * - **in_app**: No-op — the notification is already stored in the
   *   `notifications` table, which serves as the in-app notification store.
   */
  private async attemptDelivery(
    channel: NotificationChannel,
    userId: string,
    permalink: string,
  ): Promise<void> {
    if (channel === 'email') {
      await this.sendEmail(userId, permalink);
    }
    // in_app: notification is already stored in the DB — nothing else to do
  }

  /**
   * Placeholder email sender. Logs the email details instead of sending
   * via SMTP. Replace with actual email integration when ready.
   *
   * **Validates: Requirements 7.2**
   */
  private async sendEmail(userId: string, permalink: string): Promise<void> {
    // Placeholder: log the email that would be sent
    console.log(
      `[EMAIL STUB] Sending notification email to user ${userId} — ` +
        `Reddit content: https://reddit.com${permalink}`,
    );
  }

  /**
   * Sleeps for the specified number of milliseconds.
   * Extracted as a method to allow overriding in tests.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
