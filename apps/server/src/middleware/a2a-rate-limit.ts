import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';

/** Default requests per minute per IP for the A2A JSON-RPC endpoints. */
const RPC_DEFAULT_PER_MINUTE = 60;

/** Default requests per minute per IP for the A2A card (discovery) endpoints. */
const CARD_DEFAULT_PER_MINUTE = 300;

/** Rate-limit window: one minute. */
const WINDOW_MS = 60_000;

/** Options for {@link buildA2aRateLimiters}. Omitted values use the defaults. */
export interface A2aRateLimitOptions {
  /** Max JSON-RPC requests per minute per IP (default 60). */
  rpcMaxPerMinute?: number;
  /** Max card requests per minute per IP (default 300). */
  cardMaxPerMinute?: number;
}

/**
 * Build one limiter with the JSON-RPC error body A2A clients expect.
 *
 * SECURITY: the per-IP buckets hold only behind a single trusted proxy.
 * `app.ts` sets `trust proxy, 1`, so the client IP is read from
 * `X-Forwarded-For` — correct behind the intended single-hop tunnel (ngrok)
 * or one reverse proxy, but on a DIRECT public bind a client can rotate
 * spoofed XFF values to spread requests across unlimited buckets. There is
 * no clean mount-time switch to the socket address: the tunnel can start
 * after boot, and socket keying behind a tunnel would collapse every client
 * into localhost's one bucket. So treat the limiter as a throttle, not a
 * security boundary — on a direct public bind, rely on auth (which the A2A
 * exposure guard requires there anyway). Documented in
 * contributing/api-reference.md § A2A Gateway → Deployment security.
 */
function buildLimiter(maxPerMinute: number): RateLimitRequestHandler {
  return rateLimit({
    windowMs: WINDOW_MS,
    max: maxPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      jsonrpc: '2.0',
      error: { code: -32029, message: 'Rate limit exceeded. Try again shortly.' },
      id: null,
    },
  });
}

/**
 * Build the rate limiters for the external A2A surface.
 *
 * Called once at server startup in index.ts; the JSON-RPC endpoints get the
 * tighter `rpc` limiter (each request may trigger a full agent turn) and the
 * card discovery endpoints get the lighter `card` limiter. Overrides come
 * from `DORKOS_A2A_RPC_RATE_LIMIT` / `DORKOS_A2A_CARD_RATE_LIMIT`.
 *
 * @param options - Per-minute overrides (defaults: 60 RPC, 300 card)
 */
export function buildA2aRateLimiters(options: A2aRateLimitOptions = {}): {
  rpc: RateLimitRequestHandler;
  card: RateLimitRequestHandler;
} {
  return {
    rpc: buildLimiter(options.rpcMaxPerMinute ?? RPC_DEFAULT_PER_MINUTE),
    card: buildLimiter(options.cardMaxPerMinute ?? CARD_DEFAULT_PER_MINUTE),
  };
}
