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
import { z } from 'zod';
import type { RelayEnvelope, AdapterManifest } from '@dorkos/shared/relay-schemas';
import type {
  AdapterContext,
  DeliveryResult,
  WebhookAdapterConfig,
  RelayPublisher,
} from '../../types.js';
import { BaseRelayAdapter } from '../../base-adapter.js';
import { DEFAULT_MAX_HOPS, DEFAULT_CALL_BUDGET, DEFAULT_TTL_MS } from '../../budget-enforcer.js';

/** Stripe-standard timestamp window for replay attack prevention (±5 minutes). */
const TIMESTAMP_WINDOW_SECS = 300;

/** How long a nonce is remembered to prevent replay attacks. */
const NONCE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** How often expired nonces are pruned from the in-memory map. */
const NONCE_PRUNE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Header carrying how many relay hops the message being sent out has taken. */
const HOP_COUNT_HEADER = 'X-Relay-Hop-Count';

/** Header carrying the hop ceiling that applies to it. */
const MAX_HOPS_HEADER = 'X-Relay-Max-Hops';

/** Header carrying how many turns the message being sent out may still buy. */
const CALL_BUDGET_HEADER = 'X-Relay-Call-Budget';

/** Header carrying the instant, epoch ms, after which the chain is dead. */
const EXPIRES_AT_HEADER = 'X-Relay-Expires-At';

/**
 * The budget an inbound request claims to be continuing.
 *
 * Coerced from header text, and only believed when it is a sane non-negative
 * integer; anything else is treated as no claim at all, which starts a fresh
 * budget exactly as before.
 *
 * `hopCount` is the only required field: it is the one every prior version of
 * this adapter sent, and a request echoing an older DorkOS's headers must keep
 * continuing the chain rather than falling back to a fresh budget.
 */
const InboundHopBudgetSchema = z.object({
  hopCount: z.coerce.number().int().min(0).max(1_000),
  maxHops: z.coerce.number().int().min(1).max(1_000).optional(),
  callBudgetRemaining: z.coerce.number().int().min(0).max(1_000_000).optional(),
  ttl: z.coerce.number().int().min(0).optional(),
});

// === Manifest ===

/** Static adapter manifest for the Webhook built-in adapter. */
export const WEBHOOK_MANIFEST: AdapterManifest = {
  type: 'webhook',
  displayName: 'Webhook',
  description: 'Send and receive messages via HMAC-signed HTTP webhooks.',
  iconId: 'webhook',
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
      // Declared `password`, not `textarea`. This field is where an
      // `Authorization: Bearer …` goes, and every secret-handling rule in the
      // server keys off this one word: masking in the API response, preserving
      // the stored value when the form sends back the mask, and moving the
      // value into the encrypted credential store instead of leaving it in
      // `adapters.json`. Declared as text, an API key pasted here sat on disk
      // in the clear and was echoed back on every read.
      type: 'password',
      valueShape: 'json-object',
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
    this.logger.info('webhook adapter ready', { subject: this.config.inbound.subject });

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
   * 1. Nonce presence check — a missing `X-Nonce` is a malformed request (400)
   * 2. Timestamp window check — rejects requests older than ±300 seconds
   * 3. Nonce replay check — rejects previously seen nonces
   * 4. HMAC-SHA256 signature verification — tries current secret, then previous
   * 5. Nonce registration — stores nonce with 24h TTL
   * 6. Parse JSON body and publish to Relay
   *
   * @param rawBody - Raw request body buffer (must be unparsed for HMAC verification)
   * @param headers - Request headers object (Express `req.headers`)
   * @returns `{ ok: true }` on success, or `{ ok: false, error, status? }` on
   *   failure. `status` is the HTTP code the caller should return (defaults to
   *   401 when absent).
   */
  async handleInbound(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>
  ): Promise<{ ok: boolean; error?: string; status?: number }> {
    if (!this.relay) return { ok: false, error: 'Adapter not started' };

    const signature = normalizeHeader(headers['x-signature']);
    const timestamp = normalizeHeader(headers['x-timestamp']);
    const nonce = normalizeHeader(headers['x-nonce']);

    // 1. Nonce presence — an absent X-Nonce normalizes to '' and would register
    // the empty-string key, letting the first request through and then rejecting
    // every subsequent nonce-less request as a "replay" for 24h. Reject it up
    // front as a bad request so the misconfiguration is obvious immediately.
    if (!nonce) {
      return { ok: false, error: 'Missing X-Nonce header', status: 400 };
    }

    // 2. Timestamp window — prevents replays from expired requests
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TIMESTAMP_WINDOW_SECS) {
      return { ok: false, error: 'Timestamp expired or invalid' };
    }

    // 3. Nonce replay check — prevents replays within the timestamp window
    const nonceKey = `${this.id}:${nonce}`;
    if (this.nonceMap.has(nonceKey)) {
      return { ok: false, error: 'Nonce already seen (replay)' };
    }

    // 4. HMAC-SHA256 verification (timing-safe, supports secret rotation)
    const valid = verifySignature(
      rawBody,
      timestamp,
      signature,
      this.config.inbound.secret,
      this.config.inbound.previousSecret
    );
    if (!valid) {
      return { ok: false, error: 'Invalid signature' };
    }

    // 5. Register nonce with TTL
    this.nonceMap.set(nonceKey, Date.now() + NONCE_TTL_MS);

    // 6. Parse body and publish to Relay
    try {
      const body: unknown = JSON.parse(rawBody.toString());
      const payload = {
        type: 'webhook',
        data: body,
        metadata: { platform: 'webhook', adapterId: this.id, nonce },
        responseContext: { platform: 'webhook' },
      };

      const result = await this.relay.publish(this.config.inbound.subject, payload, {
        from: `relay.webhook.${this.id}`,
        ...(this.continuedBudget(headers) ?? {}),
      });

      // Check for rejected publishes (e.g. rate-limited)
      if (result.deliveredTo === 0 && result.rejected?.length) {
        const reason = result.rejected[0]?.reason ?? 'unknown';
        this.recordError(new Error(`Publish rejected: ${reason}`));
        return { ok: false, error: `Publish rejected: ${reason}` };
      }

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
    _context?: AdapterContext
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
          // State the hop budget this message is travelling on, so a service
          // that answers back through our inbound endpoint continues the chain
          // rather than resetting it (see `continuedBudget`).
          [HOP_COUNT_HEADER]: String(envelope.budget.hopCount),
          [MAX_HOPS_HEADER]: String(envelope.budget.maxHops),
          // The other two halves of the same budget. Sending only the hop
          // counter meant a service that answered every message got a fresh call
          // budget and a fresh hour on every lap — the hop guard stopped the
          // chain, but nothing bounded what it cost to get there, and nothing
          // bounded a chain that stayed under the hop limit forever.
          [CALL_BUDGET_HEADER]: String(envelope.budget.callBudgetRemaining),
          [EXPIRES_AT_HEADER]: String(envelope.budget.ttl),
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

  /**
   * Read the hop budget an inbound request is continuing, if it declares one.
   *
   * A webhook can be pointed back at DorkOS — directly, or through a service
   * that answers every message with one of its own. Each lap used to arrive as
   * a brand-new message with a brand-new budget, so the hop counter reset to
   * zero every time and the loop guard, which exists precisely to stop this,
   * never fired: the conversation ran until somebody noticed.
   *
   * {@link deliver} therefore states the budget it is sending on
   * ({@link HOP_COUNT_HEADER}), and a request that echoes it back continues the
   * chain instead of restarting it. One more hop is counted here, the same way
   * every other adapter's reply does it.
   *
   * A caller could of course send a smaller number — but only a caller holding
   * the inbound secret gets this far at all, and one who does could simply omit
   * the header. This closes the accidental loop, which is the one that happens;
   * it is not a defence against the holder of your own signing key.
   *
   * **The declared ceiling is clamped, not trusted.** `hopCount` can only ever
   * shorten a chain, so a wrong value there is self-limiting; `maxHops` is the
   * opposite — a caller declaring `1000` would hand itself a thousand laps.
   * It is therefore taken as `Math.min(declared, DEFAULT_MAX_HOPS)`: a request
   * may lower its own ceiling, never raise it. The comparison is against the
   * package default rather than this relay's configured value because an
   * adapter is not given the relay's options; the effect of a
   * higher-than-default configured ceiling is that an echoed budget is
   * shortened, which errs toward stopping sooner.
   *
   * **The whole budget continues, not just the hop counter (DOR-791).** Sending
   * hops alone left the other two dimensions resetting every lap: the call
   * budget went back to ten and the TTL back to a full hour, so a loop that
   * stayed under the hop ceiling was unbounded in both cost and time. The call
   * budget is clamped, then decremented for the lap that just happened; the
   * deadline is clamped to at most a fresh hour and otherwise carried, so a
   * chain cannot buy itself more life by going round again.
   *
   * @param headers - The inbound request headers.
   * @returns Publish options carrying the continued budget, or `undefined`.
   */
  private continuedBudget(headers: Record<string, string | string[] | undefined>):
    | {
        budget: {
          hopCount: number;
          maxHops?: number;
          callBudgetRemaining?: number;
          ttl?: number;
        };
      }
    | undefined {
    const declared = normalizeHeader(headers[HOP_COUNT_HEADER.toLowerCase()]);
    if (!declared) return undefined;

    const parsed = InboundHopBudgetSchema.safeParse({
      hopCount: declared,
      maxHops: normalizeHeader(headers[MAX_HOPS_HEADER.toLowerCase()]) || undefined,
      callBudgetRemaining: normalizeHeader(headers[CALL_BUDGET_HEADER.toLowerCase()]) || undefined,
      ttl: normalizeHeader(headers[EXPIRES_AT_HEADER.toLowerCase()]) || undefined,
    });
    if (!parsed.success) {
      this.logger.debug?.(
        `ignoring an unreadable ${HOP_COUNT_HEADER} on an inbound webhook for '${this.id}'`
      );
      return undefined;
    }

    return {
      budget: {
        hopCount: parsed.data.hopCount + 1,
        ...(parsed.data.maxHops !== undefined
          ? { maxHops: Math.min(parsed.data.maxHops, DEFAULT_MAX_HOPS) }
          : {}),
        // Clamped and then SPENT, exactly like the hop counter one line above:
        // the lap that just happened cost a turn, so the republish carries one
        // less. Floored at zero rather than allowed negative, because zero is
        // what the publish gate reads as exhausted, and a chain that has spent
        // its budget is refused there instead of continuing on a negative
        // number nothing checks.
        ...(parsed.data.callBudgetRemaining !== undefined
          ? {
              callBudgetRemaining: Math.max(
                0,
                Math.min(parsed.data.callBudgetRemaining, DEFAULT_CALL_BUDGET) - 1
              ),
            }
          : {}),
        // The deadline is carried, not restarted — clamped to at most a fresh
        // hour so an echoed value from a wrong clock (or a caller that fancied
        // a longer life) cannot extend the chain past what a new one would get.
        ...(parsed.data.ttl !== undefined
          ? { ttl: Math.min(parsed.data.ttl, Date.now() + DEFAULT_TTL_MS) }
          : {}),
      },
    };
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
  previousSecret?: string
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
