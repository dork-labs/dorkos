/**
 * The one way a DorkOS rate limiter decides "who is this" (DOR-1711).
 *
 * Every limiter in the server — sign-in, `/mcp`, the two A2A ones, each
 * extension's data proxy, the admin routes and the relay binding probe — used to
 * take `express-rate-limit`'s default key, `req.ip`. That looks like a
 * network fact and is not one: `app.ts` sets `trust proxy, 1` so a reverse proxy
 * can report the real scheme, and Express then derives `req.ip` from
 * `X-Forwarded-For`. On a direct connection the "first proxy" IS the caller, so
 * a client that sends a different `X-Forwarded-For` on every request lands in a
 * different bucket every time and is never limited at all. The limiter that
 * matters most, the 10-attempts-per-15-minutes brake on password guessing,
 * counted nothing.
 *
 * So the trust is stated instead of inherited. By default the key is the TCP
 * peer address, which no header can move. `DORKOS_TRUST_PROXY=true` says a
 * proxy really is in front, and only then does the forwarded chain decide.
 *
 * @module middleware/rate-limit-key
 */
import type { Request } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import { env } from '../env.js';

/**
 * The key when no address can be read at all — a socket already torn down.
 *
 * One shared bucket rather than a pass, because "unknown" is not a client and a
 * limiter that opens up when it cannot identify anyone is a limiter with an
 * off switch.
 */
const UNKNOWN_CLIENT_KEY = 'unknown';

/**
 * Whether `X-Forwarded-For` may name the client for rate-limiting purposes.
 *
 * Read per call, not captured at mount time, so the answer is the operator's
 * current one wherever a limiter is built.
 */
export function forwardedForIsTrusted(): boolean {
  return env.DORKOS_TRUST_PROXY === true;
}

/**
 * The rate-limit bucket key for one request.
 *
 * ## What the default costs, and why it is still the default
 *
 * Untrusted (the default), the key is `req.socket.remoteAddress`. DorkOS's own
 * ngrok tunnel runs IN this process and forwards to the local port, so every
 * request that arrives through it has a loopback peer and they all share one
 * bucket. That is the STRICT direction — a remote caller through the tunnel can
 * no longer spread itself across unlimited buckets by rotating a header — and
 * for a single-operator system whose remote clients are that operator's own
 * phone and agents, one bucket at 60/minute is not a ceiling anybody meets. An
 * operator who genuinely needs per-client buckets behind a proxy they control
 * sets `DORKOS_TRUST_PROXY=true` and accepts what that means: whoever can reach
 * the proxy's upstream can write the key.
 *
 * The address is normalized through `express-rate-limit`'s own
 * {@link ipKeyGenerator}, which folds the `::ffff:127.0.0.1` form a dual-stack
 * listener reports back to `127.0.0.1` (so one client is one bucket whichever
 * shape Node hands us) and masks a real IPv6 address to its /56 network — an
 * IPv6 client is routinely handed far more than one address, and keying on the
 * full address would let it rotate through them the same way a forged header
 * once did.
 *
 * @param req - The request being counted.
 * @returns The bucket key.
 */
export function rateLimitKey(req: Request): string {
  const address = forwardedForIsTrusted() ? req.ip : req.socket.remoteAddress;
  if (!address) return UNKNOWN_CLIENT_KEY;
  // A `%zone` suffix (link-local IPv6) is part of the route, not the identity,
  // and `ipKeyGenerator` cannot parse it.
  const zone = address.indexOf('%');
  return ipKeyGenerator(zone === -1 ? address : address.slice(0, zone));
}
