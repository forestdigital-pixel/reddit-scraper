import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getPool } from '../db/connection.js';
import type {
  WebhookRegistration,
  WebhookEvent,
  DeliveryStatus,
} from '../models/database.js';

// ---------------------------------------------------------------------------
// Pure helper functions — exported for property testing (Property 26)
// ---------------------------------------------------------------------------

/**
 * Generates an HMAC-SHA256 signature for a payload using the given secret.
 *
 * Exported as a standalone function for property testing.
 *
 * **Validates: Requirements 10.5**
 */
export function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Verifies an HMAC-SHA256 signature against a payload and secret.
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * Exported as a standalone function for property testing.
 *
 * **Validates: Requirements 10.5**
 */
export function verify(payload: string, signature: string, secret: string): boolean {
  const expected = sign(payload, secret);
  // Both are hex strings of the same hash algorithm, so same length when valid
  if (expected.length !== signature.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signature, 'utf8'));
}

/**
 * Validates that a URL starts with http:// or https://.
 *
 * Exported for unit testing.
 */
export function isValidWebhookUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of delivery retries. */
const MAX_RETRIES = 3;

/** Exponential backoff delays in milliseconds: 1s, 4s, 16s. */
const BACKOFF_DELAYS_MS = [1_000, 4_000, 16_000];

// ---------------------------------------------------------------------------
// WebhookService
// ---------------------------------------------------------------------------

/**
 * Manages outbound webhook registration, delivery, and HMAC-SHA256 signing.
 *
 * **Validates: Requirements 10.4, 10.5, 10.6**
 */
export class WebhookService {
  // -----------------------------------------------------------------------
  // register
  // -----------------------------------------------------------------------

  /**
   * Registers a new webhook for a user.
   *
   * Validates the URL, generates an HMAC secret, and stores the registration
   * in the `webhook_registrations` table.
   */
  async register(
    userId: string,
    url: string,
    events: WebhookEvent[],
  ): Promise<WebhookRegistration> {
    if (!isValidWebhookUrl(url)) {
      throw new Error('Invalid webhook URL. Must start with http:// or https://.');
    }

    if (events.length === 0) {
      throw new Error('At least one event type must be specified.');
    }

    const pool = getPool();
    const id = randomUUID();
    const secret = randomBytes(32).toString('hex');
    const eventsStr = events.join(',');
    const now = new Date();

    await pool.query(
      `INSERT INTO webhook_registrations (id, user_id, url, secret, events, is_active, created_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, $6)`,
      [id, userId, url, secret, eventsStr, now],
    );

    return {
      id,
      user_id: userId,
      url,
      secret,
      events: eventsStr,
      is_active: true,
      created_at: now,
    };
  }

  // -----------------------------------------------------------------------
  // unregister
  // -----------------------------------------------------------------------

  /**
   * Deactivates a webhook registration by setting `is_active = false`.
   */
  async unregister(webhookId: string): Promise<void> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE webhook_registrations SET is_active = FALSE WHERE id = $1`,
      [webhookId],
    );
    if (result.rowCount === 0) {
      throw new Error('Webhook registration not found.');
    }
  }

  // -----------------------------------------------------------------------
  // dispatch
  // -----------------------------------------------------------------------

  /**
   * Dispatches a webhook event to all active registrations subscribed to
   * the given event type.
   *
   * For each matching webhook:
   * 1. Serializes the payload to JSON
   * 2. Signs the payload with the webhook's HMAC secret
   * 3. POSTs to the registered URL with the signature header
   * 4. Stores a delivery record in `webhook_deliveries`
   * 5. Retries failed deliveries up to 3 times with exponential backoff
   *
   * **Validates: Requirements 10.4, 10.5, 10.6**
   */
  async dispatch(event: WebhookEvent, payload: object): Promise<void> {
    const pool = getPool();

    // Find all active webhooks subscribed to this event
    const result = await pool.query<WebhookRegistration>(
      `SELECT id, user_id, url, secret, events, is_active, created_at
       FROM webhook_registrations
       WHERE is_active = TRUE`,
    );

    const matchingWebhooks = result.rows.filter((wh) => {
      const subscribedEvents = wh.events.split(',').map((e) => e.trim());
      return subscribedEvents.includes(event);
    });

    // Dispatch to each matching webhook
    const deliveryPromises = matchingWebhooks.map((webhook) =>
      this.deliverToWebhook(webhook, event, payload),
    );

    await Promise.allSettled(deliveryPromises);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Delivers a payload to a single webhook, with retry logic.
   */
  private async deliverToWebhook(
    webhook: WebhookRegistration,
    event: WebhookEvent,
    payload: object,
  ): Promise<void> {
    const pool = getPool();
    const payloadStr = JSON.stringify(payload);
    const signature = sign(payloadStr, webhook.secret);
    const deliveryId = randomUUID();
    const now = new Date();

    // Create the delivery record as pending
    await pool.query(
      `INSERT INTO webhook_deliveries (id, webhook_id, payload, signature, status, retry_count, last_attempt_at, created_at)
       VALUES ($1, $2, $3, $4, 'pending', 0, $5, $5)`,
      [deliveryId, webhook.id, JSON.stringify(payload), signature, now],
    );

    let lastError: Error | null = null;
    let delivered = false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Wait for backoff delay on retries (not on first attempt)
      if (attempt > 0) {
        const delay = BACKOFF_DELAYS_MS[attempt - 1] ?? BACKOFF_DELAYS_MS[BACKOFF_DELAYS_MS.length - 1];
        await this.sleep(delay);
      }

      try {
        const response = await fetch(webhook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Signature': signature,
            'X-Webhook-Event': event,
          },
          body: payloadStr,
          signal: AbortSignal.timeout(10_000), // 10s timeout
        });

        if (response.ok) {
          delivered = true;
          break;
        }

        lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }

      // Update retry count after each failed attempt
      await this.updateDeliveryStatus(
        deliveryId,
        'pending',
        attempt + 1,
      );
    }

    // Final status update
    const finalStatus: DeliveryStatus = delivered ? 'delivered' : 'failed';
    const retryCount = delivered ? 0 : MAX_RETRIES;
    await this.updateDeliveryStatus(deliveryId, finalStatus, retryCount);

    if (!delivered && lastError) {
      console.error(
        `Webhook delivery failed for ${webhook.url} after ${MAX_RETRIES} retries:`,
        lastError.message,
      );
    }
  }

  /**
   * Updates the status and retry count of a webhook delivery record.
   */
  private async updateDeliveryStatus(
    deliveryId: string,
    status: DeliveryStatus,
    retryCount: number,
  ): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE webhook_deliveries
       SET status = $1, retry_count = $2, last_attempt_at = NOW()
       WHERE id = $3`,
      [status, retryCount, deliveryId],
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
