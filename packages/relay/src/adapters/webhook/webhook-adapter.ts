/**
 * Webhook adapter — bridges generic HTTP webhooks into the Relay subject hierarchy.
 *
 * Inbound: Receives HTTP POST with Stripe-style HMAC-SHA256 signature verification
 * (timestamp-prefixed message format: `{timestamp}.{rawBody}`).
 *
 * Outbound: Sends HTTP POST with signed headers (X-Signature, X-Timestamp, X-Nonce).
 *
 * Security:
 * - Timestamp window of ±300 seconds prevents replay attacks from expired tokens
 * - Nonce map with TTL pruning prevents replay attacks within the window
 * - Dual-secret rotation allows zero-downtime secret rotation
 * - All signature comparisons use `crypto.timingSafeEqual` to prevent timing attacks
 *
 * @module relay/adapters/webhook
 */
import crypto from 'node:crypto';
import type { RelayEnvelope, AdapterManifest } from '@dorkos/shared/relay-schemas';
import type { AdapterContext, DeliveryResult, WebhookAdapterConfig, RelayPublisher } from '../../types.js';
import { BaseRelayAdapter } from '../../base-adapter.js';

/** Stripe-standard timestamp window for replay attack prevention (±5 minutes). */
const TIMESTAMP_WINDOW_SECS = 300;

/** How long a nonce is remembered to prevent replay attacks. */
const NONCE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** How often expired nonces are pruned from the in-memory map. */
const NONCE_PRUNE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// === Manifest ===

/** Static adapter manifest for the Webhook built-in adapter. */
export const WEBHOOK_MANIFEST: AdapterManifest = {
  type: 'webhook',
  displayName: 'Webhook',
  description: 'Send and receive messages via HMAC-signed HTTP webhooks.',
  iconEmoji: '🔗',
  category: 'automation',
  builtin: true,
  multiInstance: true,
  configFields: [
    {
      key: 'inbound.subject',
      label: 'Inbound Subject',
      type: 'text',
      required: true,
      placeholder: 'relay.webhook.my-service',
      description: 'Relay subject to publish inbound messages to.',
      section: 'Inbound',
    },
    {
      key: 'inbound.secret',
      label: 'Inbound Secret',
      type: 'password',
      required: true,
      description: 'HMAC-SHA256 secret for verifying inbound webhooks (min 16 characters).',
      section: 'Inbound',
      helpMarkdown: `Generate a secure random secret (minimum 16 characters):

\`\`\`bash
openssl rand -hex 32
\`\`\`

This secret is used to verify that incoming webhook requests are authentic. Share it with the service sending webhooks to your DorkOS instance.`,
    },
    {
      key: 'outbound.url',
      label: 'Outbound URL',
      type: 'url',
      required: true,
      placeholder: 'https://api.example.com/webhook',
      description: 'URL to POST outbound messages to.',
      section: 'Outbound',
      helpMarkdown: `The URL where DorkOS sends outbound messages. Requirements:
- Must accept **POST** requests with JSON body
- Should return **2xx** status for success
- Response body is ignored`,
    },
    {
      key: 'outbound.secret',
      label: 'Outbound Secret',
      type: 'password',
      required: true,
      description: 'HMAC-SHA256 secret for signing outbound requests (min 16 characters).',
      section: 'Outbound',
    },
    {
      key: 'outbound.headers',
      label: 'Custom Headers',
      type: 'textarea',
      required: false,
      placeholder: '{"Authorization": "Bearer xxx"}',
      description: 'JSON object of custom HTTP headers for outbound requests.',
      section: 'Outbound',
      helpMarkdown: `JSON object of custom HTTP headers sent with every outbound request. Example:

\`\`\`json
{
  "Authorization": "Bearer your-api-key",
  "X-Custom-Header": "value"
}
\`\`\`

Leave empty if no custom headers are needed.`,
    },
  ],
};

/**
 * Webhook adapter — bridges generic HTTP webhooks into the Relay subject hierarchy.
 *
 * The adapter does not open its own HTTP server. Instead, the Express route at
 * `POST /api/relay/webhooks/:adapterId` receives raw request bodies and calls
 * `handleInbound()` for HMAC verification and Relay publishing.
 *
 * Outbound delivery uses the Node.js built-in `fetch` API (available in Node 18+).
 *
 * @example
 * ```ts
 * const adapter = new WebhookAdapter('github', {
 *   inbound: { subject: 'relay.webhook.github', secret: 'webhook-secret-min-16-chars' },
 *   outbound: { url: 'https://myserver.com/relay-out', secret: 'outbound-secret-min-16' },
 * });
 *
 * await adapter.start(relay);
 *
 * // In Express route handler:
 * const result = await adapter.handleInbound(req.body, req.headers);
 * if (!result.ok) res.status(401).json({ error: result.error });
 * ```
 */
export class WebhookAdapter extends BaseRelayAdapter {
  private readonly config: WebhookAdapterConfig;
  /** Tracks nonces to prevent replay attacks. Maps `{adapterId}:{nonce}` -> expiresAt timestamp. */
  private readonly nonceMap = new Map<string, number>();
  private nonceInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Create a new WebhookAdapter instance.
   *
   * @param id - Unique adapter identifier (e.g., 'github', 'stripe')
   * @param config - Inbound/outbound webhook configuration including secrets
   * @param displayName - Human-readable name (defaults to `Webhook ({id})`)
   */
  constructor(id: string, config: WebhookAdapterConfig, displayName?: string) {
    // subjectPrefix is derived from the inbound subject so RelayCore can route to this adapter
    super(id, config.inbound.subject, displayName ?? `Webhook (${id})`);
    this.config = config;
  }

  /**
   * Connect hook — begin nonce pruning interval.
   *
   * This adapter has no external connection to establish; it relies on the
   * Express route calling `handleInbound()` for inbound messages. The nonce
   * pruning interval is started here to prevent unbounded memory growth.
   * The relay publisher reference is stored by {@link BaseRelayAdapter.start}.
   *
   * @param _relay - The RelayPublisher (stored by base class; unused here)
   */
  protected async _start(_relay: RelayPublisher): Promise<void> {
    // Prune expired nonces on a fixed interval to prevent memory growth
    this.nonceInterval = setInterval(() => {
      this.pruneExpiredNonces();
    }, NONCE_PRUNE_INTERVAL_MS);
  }

  /**
   * Disconnect hook — clear nonce state and pruning interval.
   */
  protected async _stop(): Promise<void> {
    if (this.nonceInterval !== null) {
      clearInterval(this.nonceInterval);
      this.nonceInterval = null;
    }
    this.nonceMap.clear();
  }

  /**
   * Handle an inbound webhook HTTP POST request.
   *
   * Verification pipeline:
   * 1. Timestamp window check — rejects requests older than ±300 seconds
   * 2. Nonce replay check — rejects previously seen nonces
   * 3. HMAC-SHA256 signature verification — tries current secret, then previous
   * 4. Nonce registration — stores nonce with 24h TTL
   * 5. Parse JSON body and publish to Relay
   *
   * @param rawBody - Raw request body buffer (must be unparsed for HMAC verification)
   * @param headers - Request headers object (Express `req.headers`)
   * @returns Object with `ok: true` on success, or `ok: false` with `error` message
   */
  async handleInbound(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.relay) return { ok: false, error: 'Adapter not started' };

    const signature = normalizeHeader(headers['x-signature']);
    const timestamp = normalizeHeader(headers['x-timestamp']);
    const nonce = normalizeHeader(headers['x-nonce']);

    // 1. Timestamp window — prevents replays from expired requests
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TIMESTAMP_WINDOW_SECS) {
      return { ok: false, error: 'Timestamp expired or invalid' };
    }

    // 2. Nonce replay check — prevents replays within the timestamp window
    const nonceKey = `${this.id}:${nonce}`;
    if (this.nonceMap.has(nonceKey)) {
      return { ok: false, error: 'Nonce already seen (replay)' };
    }

    // 3. HMAC-SHA256 verification (timing-safe, supports secret rotation)
    const valid = verifySignature(
      rawBody,
      timestamp,
      signature,
      this.config.inbound.secret,
      this.config.inbound.previousSecret,
    );
    if (!valid) {
      return { ok: false, error: 'Invalid signature' };
    }

    // 4. Register nonce with TTL
    this.nonceMap.set(nonceKey, Date.now() + NONCE_TTL_MS);

    // 5. Parse body and publish to Relay
    try {
      const body: unknown = JSON.parse(rawBody.toString());
      const payload = {
        type: 'webhook',
        data: body,
        metadata: { platform: 'webhook', adapterId: this.id, nonce },
        responseContext: { platform: 'webhook' },
      };

      await this.relay.publish(this.config.inbound.subject, payload, {
        from: `relay.webhook.${this.id}`,
      });

      this.trackInbound();
      return { ok: true };
    } catch (err) {
      this.recordError(err);
      return { ok: false, error: 'Publish failed' };
    }
  }

  /**
   * Deliver a Relay message to the configured outbound webhook URL.
   *
   * Signs the request with HMAC-SHA256 using the outbound secret.
   * Message format: `{timestamp}.{JSON.stringify(envelope.payload)}`
   *
   * @param _subject - The target subject (informational; URL is from config)
   * @param envelope - The relay envelope to deliver
   * @param _context - Optional adapter context (unused by this adapter)
   */
  async deliver(
    _subject: string,
    envelope: RelayEnvelope,
    _context?: AdapterContext,
  ): Promise<DeliveryResult> {
    const startTime = Date.now();
    const body = JSON.stringify(envelope.payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomUUID();
    const message = `${timestamp}.${body}`;

    const signature = crypto
      .createHmac('sha256', this.config.outbound.secret)
      .update(message)
      .digest('hex');

    try {
      const response = await fetch(this.config.outbound.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': signature,
          'X-Timestamp': timestamp,
          'X-Nonce': nonce,
          ...this.config.outbound.headers,
        },
        body,
      });

      if (!response.ok) {
        const error = `Outbound delivery failed: HTTP ${response.status}`;
        this.recordError(error);
        return { success: false, error, durationMs: Date.now() - startTime };
      }

      this.trackOutbound();
      return { success: true, durationMs: Date.now() - startTime };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.recordError(err);
      return { success: false, error, durationMs: Date.now() - startTime };
    }
  }

  /** Remove expired nonces from the in-memory map. */
  private pruneExpiredNonces(): void {
    const now = Date.now();
    for (const [nonce, expiresAt] of this.nonceMap) {
      if (now > expiresAt) {
        this.nonceMap.delete(nonce);
      }
    }
  }
}

/**
 * Verify an HMAC-SHA256 signature with timing-safe comparison.
 *
 * Uses the Stripe-style format: `{timestamp}.{rawBody}` as the signed message.
 * Supports dual-secret rotation — tries the current secret first, then the
 * previous secret if provided. This allows zero-downtime key rotation with a
 * 24-hour transition window.
 *
 * IMPORTANT: Always uses `crypto.timingSafeEqual` — never string equality — to
 * prevent timing-based signature oracle attacks.
 *
 * @param rawBody - The raw request body buffer
 * @param timestamp - The timestamp string from the X-Timestamp header
 * @param signature - The hex-encoded HMAC signature from the X-Signature header
 * @param secret - The current HMAC secret
 * @param previousSecret - Optional previous secret for rotation support
 * @returns `true` if the signature is valid, `false` otherwise
 */
export function verifySignature(
  rawBody: Buffer,
  timestamp: string,
  signature: string,
  secret: string,
  previousSecret?: string,
): boolean {
  const message = `${timestamp}.${rawBody.toString()}`;

  // Compare against current secret
  if (timingSafeCompare(message, signature, secret)) {
    return true;
  }

  // Fall through to previous secret for rotation window
  if (previousSecret) {
    return timingSafeCompare(message, signature, previousSecret);
  }

  return false;
}

/**
 * Compute expected HMAC and compare with received signature using timing-safe equality.
 *
 * Handles the Buffer length mismatch case: if lengths differ, we still run
 * timingSafeEqual against a dummy buffer of the correct length. This prevents
 * early-exit timing differences based on signature length.
 *
 * @param message - The signed message string
 * @param signature - The hex-encoded signature to verify
 * @param secret - The HMAC secret
 */
function timingSafeCompare(message: string, signature: string, secret: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(message).digest();
  const received = Buffer.from(signature, 'hex');

  // Buffers must be the same length for timingSafeEqual; HMAC-SHA256 is always 32 bytes
  if (received.length !== expected.length) {
    // Still perform a dummy comparison to avoid timing differences based on input length
    crypto.timingSafeEqual(expected, expected);
    return false;
  }

  return crypto.timingSafeEqual(received, expected);
}

/**
 * Normalize a potentially multi-value header to a single string.
 *
 * Express headers can be `string | string[] | undefined`. We always want a
 * single string — if the header is missing or an array, return `''`.
 *
 * @param header - The header value from `req.headers`
 */
function normalizeHeader(header: string | string[] | undefined): string {
  if (typeof header === 'string') return header;
  return '';
}
