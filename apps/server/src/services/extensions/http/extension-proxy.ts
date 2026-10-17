/**
 * The proxy DorkOS runs for an extension's declarative `dataProxy`.
 *
 * Forwards requests from /api/ext/{id}/proxy/* to the configured upstream API,
 * injecting auth credentials from the extension's encrypted secret store.
 *
 * Two layers: {@link createProxyForwarder} decides and makes one upstream call
 * from a framework-free {@link ProxyCall}, and {@link createProxyHandler}
 * puts it behind the extension's mount on the Hono `/api` chain, with its
 * rate limit in front.
 *
 * @module services/extensions/http/extension-proxy
 */
import type { IncomingHttpHeaders } from 'node:http';
import type { DataProxyConfig } from '@dorkos/extension-api';
import { ExtensionSecretStore } from '@dorkos/shared/extension-secrets';
import { logger } from '../../../lib/logger.js';
import { honoRequestFacts } from '../../../http/request-facts.js';
import {
  buildExtensionProxyRateLimiter,
  EXTENSION_PROXY_RATE_LIMITED_BODY,
} from '../../../middleware/extension-proxy-rate-limit.js';
import type { ExtensionHttpHandler } from './extension-http.js';
import { OUTBOUND_FORCED } from './reply-headers.js';
import { currentServerRole } from '../../../lib/server-role.js';

/**
 * Headers that must not be forwarded to the upstream API.
 *
 * Two kinds. The hop-by-hop ones describe this connection and mean nothing on
 * the next one. The rest are how the CALLER proved who they are to DorkOS —
 * the session cookie, an API key, an agent token. The upstream is a third
 * party; it has no business seeing any of them, and the proxy authenticates
 * itself with the extension's own stored secret anyway. Forwarding
 * `authorization` was also silently corrupting the injected credential when the
 * extension's `authHeader` is `Authorization`: both spellings survive into one
 * `Headers` object and get joined with a comma.
 *
 * Exported so a drift test can assert the real `AGENT_IDENTITY_HEADER` is in
 * here rather than trusting the copy below to survive a rename.
 */
export const STRIPPED_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'connection',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'proxy-connection',
  'proxy-authorization',
  'cookie',
  'authorization',
  // `AGENT_IDENTITY_HEADER` from `middleware/agent-identity.ts`, spelled out
  // rather than imported so this file does not pull in the identity service.
  // A test imports the real constant and asserts it is in this set, so a rename
  // there cannot silently start leaking the token again.
  'x-dorkos-agent',
  // The body is re-serialized below (`JSON.stringify(call.body ?? {})`), so the
  // caller's length describes bytes that are not the ones being sent. undici
  // rejects the mismatch outright ("Request body length does not match
  // content-length header"), which turned every pretty-printed JSON POST into a
  // 502 and every empty POST into an upstream hang. `fetch` sets the correct
  // length itself.
  'content-length',
]);

/** Filter request headers, removing hop-by-hop and caller-credential headers. */
function filterHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!STRIPPED_HEADERS.has(key.toLowerCase()) && value !== undefined) {
      filtered[key] = Array.isArray(value) ? value.join(', ') : value;
    }
  }
  return filtered;
}

/** Format the auth header value based on the configured auth type. */
function formatAuthValue(authType: DataProxyConfig['authType'], secret: string): string {
  return authType === 'Custom' ? secret : `${authType} ${secret}`;
}

/**
 * Decide whether a built target URL is still the upstream the manifest named.
 *
 * The caller owns the whole sub-path, and dot segments are normalized by the
 * URL parser inside `fetch` — after the credential has been attached. So
 * `/proxy/../../admin` (or `..%2f..%2f`, which {@link proxySegments} hands over
 * already decoded, or `%2e%2e`, which the URL parser treats as `..`) reaches endpoints
 * ABOVE the configured base path with the extension's secret on them. Comparing
 * the parsed URL against the parsed base is the only reliable check, because it
 * is the same normalization `fetch` will do.
 *
 * A query or fragment is refused too: the caller cannot be allowed to graft
 * `?admin=1` onto the upstream call through a percent-encoded `?` in the path,
 * and the proxy appends the real query string itself.
 *
 * @param target - The URL built from the base plus the caller's sub-path.
 * @param base - The extension manifest's `baseUrl`.
 */
function staysWithinBase(target: URL, base: URL): boolean {
  if (target.origin !== base.origin) return false;
  if (target.search !== '' || target.hash !== '') return false;
  const prefix = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  return target.pathname === base.pathname || target.pathname.startsWith(prefix);
}

/** One request for the upstream, as {@link createProxyForwarder} reads it. */
export interface ProxyCall {
  /** The request method, forwarded as is. */
  readonly method: string;
  /** The path below `/proxy/`, decoded segment by segment ({@link proxySegments}). */
  readonly segments: readonly string[];
  /** The request below the extension's mount, as sent: for its query string and the log. */
  readonly url: string;
  /** The caller's headers; {@link STRIPPED_HEADERS} never leave. */
  readonly headers: IncomingHttpHeaders;
  /** The JSON body the chain parsed, or `undefined` for none. */
  readonly body: unknown;
}

/** What the proxy answers one {@link ProxyCall} with. */
export interface ProxyAnswer {
  /** The status. */
  readonly status: number;
  /** Headers to set. */
  readonly headers: Readonly<Record<string, string>>;
  /** A JSON body DorkOS wrote (a refusal or a failure). */
  readonly json?: unknown;
  /** The upstream's body, as text. */
  readonly text?: string;
}

/**
 * The path below `/proxy`, one decoded segment each, or `null` when the
 * request is not for the proxy at all.
 *
 * Matches the way the Express route `/proxy/{*splat}` did: `/proxy` in any
 * case, with or without a trailing slash and anything below it, each segment
 * percent-decoded on its own (so `..%2f..` arrives as one segment holding
 * separators, which the confinement check then refuses).
 *
 * @param subPath - The path below the extension's mount, still percent-encoded.
 */
export function proxySegments(subPath: string): string[] | null {
  const match = /^\/proxy(?:\/(.*))?$/i.exec(subPath);
  if (!match) return null;
  const rest = match[1] ?? '';
  if (rest === '') return [];
  return rest.split('/').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}

/**
 * Create the forwarder for an extension's dataProxy configuration.
 *
 * Answers 400 when the target would leave `baseUrl` (before any secret is
 * read), 503 if the required secret is not configured, and 502 on upstream
 * network failure; otherwise the upstream's own status and body.
 *
 * @param extensionId - Extension identifier for logging and secret lookup
 * @param config - DataProxy configuration from the extension manifest
 * @param dorkHome - Resolved DorkOS data directory for secret store access
 * @returns The forwarder for one call
 */
export function createProxyForwarder(
  extensionId: string,
  config: DataProxyConfig,
  dorkHome: string
): (call: ProxyCall) => Promise<ProxyAnswer> {
  const secrets = new ExtensionSecretStore(extensionId, dorkHome);
  // Parsed once: `DataProxySchema.baseUrl` is `z.string().url()`, so a manifest
  // that got this far cannot fail here.
  const base = new URL(config.baseUrl);
  // A `baseUrl` carrying a query or fragment cannot mean anything to a proxy
  // that appends a path and the caller's own query to it — and left in place it
  // made every single request fail the confinement check with a message about
  // the caller's path, which is not where the problem was. Drop them once, here,
  // and say so where the extension author will see it.
  if (base.search !== '' || base.hash !== '') {
    logger.warn(
      `[ext:${extensionId}] dataProxy.baseUrl carries a query or fragment (${base.search}${base.hash}); ignoring it. Put those on the request instead.`
    );
    base.search = '';
    base.hash = '';
  }
  // What every target URL is built from: the base with any trailing slash
  // dropped, so a sub-path can be appended with exactly one separator.
  const baseForJoin = `${base.origin}${base.pathname}`.replace(/\/+$/, '');

  return async (call) => {
    let targetUrl = `${baseForJoin}/${call.segments.join('/')}`;

    /**
     * The refusal for a target that is no longer the upstream the manifest
     * named, or `null` when it still is.
     *
     * @param stage - Which build step produced the URL, for the log line.
     */
    const outsideBase = (stage: 'path' | 'pathRewrite'): ProxyAnswer | null => {
      let parsed: URL;
      try {
        parsed = new URL(targetUrl);
      } catch {
        // Unparseable is refused, not passed on: `about:blank` has an opaque
        // origin, so the comparison below fails the way it should.
        parsed = new URL('about:blank');
      }
      if (staysWithinBase(parsed, base)) return null;
      logger.warn(
        `[ext:${extensionId}] Refused a proxy target outside ${base.origin}${base.pathname} (after ${stage}): ${call.method} ${call.url}`
      );
      return {
        status: 400,
        headers: {},
        json: {
          error: 'Proxy path is outside the extension upstream',
          code: 'PROXY_PATH_NOT_ALLOWED',
        },
      };
    };

    // Confine the caller's sub-path to the upstream the manifest named, BEFORE
    // any credential is read or attached.
    const escaped = outsideBase('path');
    if (escaped) return escaped;

    // Apply path rewrites if configured.
    //
    // `from` is a pattern an extension author wrote in their manifest, compiled to
    // a RegExp and run against a caller-supplied path — a catastrophic-backtracking
    // surface on paper. It stays as-is because of where it sits: this proxy is
    // only ever mounted for an extension a person approved to run its code inside
    // DorkOS (`extension-load-policy.ts`), and an extension that may run code in
    // this process can hang it far more directly than by writing a slow regex. A
    // linear-time engine here would buy nothing against an adversary already past
    // that gate, and would silently change what authors' patterns mean.
    if (config.pathRewrite) {
      for (const [from, to] of Object.entries(config.pathRewrite)) {
        targetUrl = targetUrl.replace(new RegExp(from), to);
      }
      // Re-checked, because the rewrite runs on the RAW string while the check
      // above ran on the normalized URL — so the two together escape what
      // neither can escape alone. With base `/v1` and the ordinary
      // prefix-stripping rule `{"/v1/legacy/": "/v1/"}`, the caller path
      // `legacy/../admin` normalizes to `/v1/admin` and passes, then the rewrite
      // deletes the `legacy/` the `..` was cancelling and leaves `/v1/../admin`
      // for `fetch` to normalize into `/admin`. An author rule that genuinely
      // needs to leave the base is out of contract: this field rewrites paths,
      // and `baseUrl` is what the approval was given for.
      const rewritten = outsideBase('pathRewrite');
      if (rewritten) return rewritten;
    }

    // Forward query string if present
    const queryString = new URL(call.url, 'http://localhost').search;
    if (queryString) {
      targetUrl += queryString;
    }

    // Retrieve auth secret
    const secret = await secrets.get(config.authSecret);
    if (!secret) {
      return {
        status: 503,
        headers: {},
        json: {
          error: `Secret '${config.authSecret}' not configured for extension '${extensionId}'`,
          hint: `Set the secret via PUT /api/extensions/${extensionId}/secrets/${config.authSecret}`,
        },
      };
    }

    const authValue = formatAuthValue(config.authType, secret);

    try {
      const upstreamRes = await fetch(targetUrl, {
        method: call.method,
        headers: {
          ...filterHeaders(call.headers),
          [config.authHeader]: authValue,
          'Content-Type': call.headers['content-type'] ?? 'application/json',
        },
        // body ?? {}: a POST with no body is left undefined by the body parser,
        // so forward "{}" (matching the always-JSON Content-Type above and
        // Express 4 behavior) rather than dropping the body entirely.
        body: ['GET', 'HEAD'].includes(call.method) ? undefined : JSON.stringify(call.body ?? {}),
        // Hand a redirect back to the caller instead of chasing it. `fetch`
        // follows redirects by default and undici strips only `cookie`,
        // `authorization` and `host` when the hop crosses origins — a custom
        // `authHeader` such as `X-Api-Key` rides along, so an upstream (or an
        // open redirect on it) could bounce the operator's credential to
        // 169.254.169.254 or any internal host. Re-validating a `Location` and
        // following it ourselves would mean reimplementing redirect handling,
        // including its own loop and credential rules; refusing to follow needs
        // no such machinery and keeps the caller in charge, which is what a
        // data proxy for an API client should do anyway.
        redirect: 'manual',
      });

      const headers: Record<string, string> = {};
      // Forward content-type header
      const contentType = upstreamRes.headers.get('content-type');
      if (contentType) headers['Content-Type'] = contentType;
      // Forward `Location` so a caller that got a 3xx above can see where the
      // upstream pointed and decide for itself.
      // Never on a hub (DOR-2937): there a `Location` to another site would
      // make the hub's own address a redirect anywhere.
      const location = upstreamRes.headers.get('location');
      if (location && currentServerRole() !== 'hub') headers.Location = location;

      return { status: upstreamRes.status, headers, text: await upstreamRes.text() };
    } catch (err) {
      logger.error(`[ext:${extensionId}] Proxy error for ${call.method} ${targetUrl}:`, err);
      return {
        status: 502,
        headers: {},
        json: {
          error: 'Proxy request failed',
          details: err instanceof Error ? err.message : String(err),
        },
      };
    }
  };
}

/** Statuses whose response may not carry a body. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * The response Express's `res.json` and `res.send` wrote for an answer: JSON
 * as `application/json; charset=utf-8`, and text with `charset=utf-8` set on
 * whatever type it carries (`text/html` when it carries none). Every answer
 * also carries {@link OUTBOUND_FORCED}, as a fetch handler's does, so an
 * upstream's HTML opened as a page runs nothing on DorkOS's origin.
 *
 * @param answer - What the forwarder answered.
 * @param extra - Headers to add (the rate limit's).
 */
export function proxyResponse(answer: ProxyAnswer, extra: Record<string, string> = {}): Response {
  const headers = new Headers({ ...extra, ...answer.headers, ...OUTBOUND_FORCED });
  let body: string;
  if (answer.json !== undefined) {
    body = JSON.stringify(answer.json);
    headers.set('Content-Type', 'application/json; charset=utf-8');
  } else {
    body = answer.text ?? '';
    const type = headers.get('Content-Type') ?? 'text/html';
    headers.set('Content-Type', `${type.replace(/;\s*charset=[^;]*/i, '')}; charset=utf-8`);
  }
  if (NULL_BODY_STATUSES.has(answer.status)) {
    headers.delete('Content-Type');
    return new Response(null, { status: answer.status, headers });
  }
  return new Response(body, { status: answer.status, headers });
}

/**
 * The proxy behind an extension's mount: answers `/proxy` and anything below
 * it (any method), and passes every other path on.
 *
 * Each handler has its own per-minute budget
 * (`middleware/extension-proxy-rate-limit.ts`), checked before anything else,
 * so a refusal costs no secret read and no upstream request.
 *
 * @param extensionId - Extension identifier for logging and secret lookup
 * @param config - DataProxy configuration from the extension manifest
 * @param dorkHome - Resolved DorkOS data directory for secret store access
 */
export function createProxyHandler(
  extensionId: string,
  config: DataProxyConfig,
  dorkHome: string
): ExtensionHttpHandler {
  const forward = createProxyForwarder(extensionId, config, dorkHome);
  const limit = buildExtensionProxyRateLimiter();
  return async ({ c, subPath }) => {
    const segments = proxySegments(subPath);
    if (!segments) return null;
    const verdict = limit(honoRequestFacts(c));
    if (!verdict.allowed) {
      return proxyResponse(
        { status: 429, headers: {}, json: EXTENSION_PROXY_RATE_LIMITED_BODY },
        verdict.headers
      );
    }
    const query = new URL(c.req.url).search;
    const answer = await forward({
      method: c.req.method,
      segments,
      url: `${subPath}${query}`,
      headers: c.env.incoming.headers,
      body: c.get('body'),
    });
    return proxyResponse(answer, verdict.headers);
  };
}
