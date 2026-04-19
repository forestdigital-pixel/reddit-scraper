import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseChannels,
  computeBackoffDelay,
} from '../../services/notification-service';
import type { KeywordMatchInfo } from '../../services/notification-service';

// ---------------------------------------------------------------------------
// Mock the database connection module
// ---------------------------------------------------------------------------
const mockQuery = vi.fn();
vi.mock('../../db/connection', () => ({
  getPool: () => ({ query: mockQuery }),
}));

/**
 * Unit tests for NotificationService.
 *
 * Tests preference-based routing (email vs in-app), retry logic,
 * and permalink inclusion.
 *
 * Requirements: 7.2, 7.3, 7.5, 7.6
 */
describe('NotificationService', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Pure helper functions
  // -----------------------------------------------------------------------
  describe('parseChannels()', () => {
    it('should parse a single channel', () => {
      expect(parseChannels('email')).toEqual(['email']);
    });

    it('should parse multiple comma-separated channels', () => {
      expect(parseChannels('email,in_app')).toEqual(['email', 'in_app']);
    });

    it('should trim whitespace around channel names', () => {
      expect(parseChannels(' email , in_app ')).toEqual(['email', 'in_app']);
    });

    it('should filter out invalid channel names', () => {
      expect(parseChannels('email,sms,in_app')).toEqual(['email', 'in_app']);
    });

    it('should return empty array for empty string', () => {
      expect(parseChannels('')).toEqual([]);
    });
  });

  describe('computeBackoffDelay()', () => {
    it('should return 2000ms for attempt 0', () => {
      expect(computeBackoffDelay(0)).toBe(2000);
    });

    it('should return 4000ms for attempt 1', () => {
      expect(computeBackoffDelay(1)).toBe(4000);
    });

    it('should return 8000ms for attempt 2', () => {
      expect(computeBackoffDelay(2)).toBe(8000);
    });
  });

  // -----------------------------------------------------------------------
  // getPreferences — Requirement 7.2, 7.3
  // -----------------------------------------------------------------------
  describe('getPreferences()', () => {
    it('should return stored preferences when they exist', async () => {
      const { NotificationService } = await import(
        '../../services/notification-service'
      );

      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'pref-1',
            user_id: 'user-1',
            channels: 'email,in_app',
            frequency: 'hourly',
          },
        ],
      });

      const service = new NotificationService();
      const prefs = await service.getPreferences('user-1');

      expect(prefs).toEqual({
        userId: 'user-1',
        channels: ['email', 'in_app'],
        frequency: 'hourly',
      });
    });

    it('should return default preferences when none are configured', async () => {
      const { NotificationService } = await import(
        '../../services/notification-service'
      );

      mockQuery.mockResolvedValueOnce({ rows: [] });

      const service = new NotificationService();
      const prefs = await service.getPreferences('user-2');

      expect(prefs).toEqual({
        userId: 'user-2',
        channels: ['in_app'],
        frequency: 'immediate',
      });
    });
  });

  // -----------------------------------------------------------------------
  // updatePreferences — Requirement 7.3
  // -----------------------------------------------------------------------
  describe('updatePreferences()', () => {
    it('should insert new preferences when none exist', async () => {
      const { NotificationService } = await import(
        '../../services/notification-service'
      );

      // First query: check existing → none found
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // Second query: insert
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const service = new NotificationService();
      await service.updatePreferences('user-1', {
        channels: ['email', 'in_app'],
        frequency: 'daily',
      });

      // Verify the INSERT was called with correct channels string
      const insertCall = mockQuery.mock.calls[1];
      expect(insertCall[0]).toContain('INSERT INTO notification_preferences');
      expect(insertCall[1]).toContain('email,in_app');
      expect(insertCall[1]).toContain('daily');
    });

    it('should update existing preferences', async () => {
      const { NotificationService } = await import(
        '../../services/notification-service'
      );

      // First query: check existing → found
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'pref-1' }] });
      // Second query: update
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const service = new NotificationService();
      await service.updatePreferences('user-1', {
        channels: ['email'],
        frequency: 'hourly',
      });

      const updateCall = mockQuery.mock.calls[1];
      expect(updateCall[0]).toContain('UPDATE notification_preferences');
    });
  });

  // -----------------------------------------------------------------------
  // sendNotification — Requirement 7.1, 7.2, 7.3, 7.6
  // -----------------------------------------------------------------------
  describe('sendNotification()', () => {
    const match: KeywordMatchInfo = {
      keywordId: 'kw-1',
      contentId: 'post-abc',
      contentType: 'post',
      permalink: '/r/typescript/comments/abc123/my_post/',
    };

    it('should route to in_app channel based on default preferences', async () => {
      const { NotificationService } = await import(
        '../../services/notification-service'
      );

      // getPreferences: no prefs → defaults to in_app
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // INSERT notification record
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      // UPDATE notification to sent
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const service = new NotificationService();
      await service.sendNotification('user-1', match);

      // Verify notification was inserted with in_app channel and permalink
      const insertCall = mockQuery.mock.calls[1];
      expect(insertCall[0]).toContain('INSERT INTO notifications');
      expect(insertCall[1]).toContain('in_app');
      expect(insertCall[1]).toContain(match.permalink);
    });

    it('should route to email channel when preferences specify email', async () => {
      const { NotificationService } = await import(
        '../../services/notification-service'
      );

      // getPreferences: email only
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'pref-1',
            user_id: 'user-1',
            channels: 'email',
            frequency: 'immediate',
          },
        ],
      });
      // INSERT notification record
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      // UPDATE notification to sent
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const service = new NotificationService();
      await service.sendNotification('user-1', match);

      // Verify email stub was called (logs the email)
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EMAIL STUB]'),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining(match.permalink),
      );

      consoleSpy.mockRestore();
    });

    it('should create notifications for both channels when both are configured', async () => {
      const { NotificationService } = await import(
        '../../services/notification-service'
      );

      // getPreferences: both channels
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'pref-1',
            user_id: 'user-1',
            channels: 'email,in_app',
            frequency: 'immediate',
          },
        ],
      });
      // INSERT + UPDATE for email notification
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      // INSERT + UPDATE for in_app notification
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      vi.spyOn(console, 'log').mockImplementation(() => {});

      const service = new NotificationService();
      await service.sendNotification('user-1', match);

      // Should have: 1 getPreferences query + 2 channels × 2 queries each = 5 total
      expect(mockQuery).toHaveBeenCalledTimes(5);
    });

    it('should include permalink in every notification record', async () => {
      const { NotificationService } = await import(
        '../../services/notification-service'
      );

      // getPreferences: in_app
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // INSERT notification
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      // UPDATE notification
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const service = new NotificationService();
      await service.sendNotification('user-1', match);

      // Check the INSERT call includes the permalink
      const insertCall = mockQuery.mock.calls[1];
      const params = insertCall[1] as unknown[];
      expect(params).toContain(match.permalink);
    });
  });

  // -----------------------------------------------------------------------
  // retryFailed — Requirement 7.5
  // -----------------------------------------------------------------------
  describe('retryFailed()', () => {
    it('should retry failed notifications and mark as sent on success', async () => {
      const { NotificationService } = await import(
        '../../services/notification-service'
      );

      const failedNotification = {
        id: 'notif-1',
        user_id: 'user-1',
        keyword_id: 'kw-1',
        content_id: 'post-abc',
        channel: 'in_app' as const,
        permalink: '/r/test/comments/xyz/',
        status: 'failed' as const,
        retry_count: 0,
        sent_at: null,
        created_at: new Date(),
      };

      // Query for failed notifications
      mockQuery.mockResolvedValueOnce({ rows: [failedNotification] });
      // UPDATE to sent
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const service = new NotificationService();
      // Override sleep to avoid real delays
      (service as any).sleep = vi.fn().mockResolvedValue(undefined);

      await service.retryFailed();

      // Verify the notification was updated to 'sent'
      const updateCall = mockQuery.mock.calls[1];
      expect(updateCall[0]).toContain("status = 'sent'");
      expect(updateCall[1]).toContain(1); // retry_count incremented
    });

    it('should not retry notifications that have exhausted retries', async () => {
      const { NotificationService } = await import(
        '../../services/notification-service'
      );

      // Query returns no notifications (all have retry_count >= MAX_RETRIES)
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const service = new NotificationService();
      await service.retryFailed();

      // Only the initial SELECT query should have been made
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('should increment retry count on continued failure', async () => {
      const { NotificationService } = await import(
        '../../services/notification-service'
      );

      const failedNotification = {
        id: 'notif-2',
        user_id: 'user-1',
        keyword_id: 'kw-1',
        content_id: 'post-def',
        channel: 'email' as const,
        permalink: '/r/test/comments/def/',
        status: 'failed' as const,
        retry_count: 1,
        sent_at: null,
        created_at: new Date(),
      };

      // Query for failed notifications
      mockQuery.mockResolvedValueOnce({ rows: [failedNotification] });

      // Mock console.log to capture email stub, then throw to simulate failure
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {
        throw new Error('Email delivery failed');
      });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // UPDATE with incremented retry count
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const service = new NotificationService();
      (service as any).sleep = vi.fn().mockResolvedValue(undefined);

      await service.retryFailed();

      // Verify retry count was incremented to 2
      const updateCall = mockQuery.mock.calls[1];
      expect(updateCall[1]).toContain(2); // retry_count = 1 + 1

      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('should log error when max retries are exhausted', async () => {
      const { NotificationService } = await import(
        '../../services/notification-service'
      );

      const failedNotification = {
        id: 'notif-3',
        user_id: 'user-1',
        keyword_id: 'kw-1',
        content_id: 'post-ghi',
        channel: 'email' as const,
        permalink: '/r/test/comments/ghi/',
        status: 'failed' as const,
        retry_count: 2, // One more retry will exhaust (MAX_RETRIES = 3)
        sent_at: null,
        created_at: new Date(),
      };

      // Query for failed notifications
      mockQuery.mockResolvedValueOnce({ rows: [failedNotification] });

      // Mock email to fail
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {
        throw new Error('Email delivery failed');
      });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // UPDATE with final retry count
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const service = new NotificationService();
      (service as any).sleep = vi.fn().mockResolvedValue(undefined);

      await service.retryFailed();

      // Verify error was logged about exhausted retries
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed after 3 retries'),
      );

      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });
  });
});
