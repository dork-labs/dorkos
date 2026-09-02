/**
 * Auto-generated proxy middleware for extensions using declarative `dataProxy` config.
 *
 * Forwards requests from /api/ext/{id}/proxy/* to the configured upstream API,
 * injecting auth credentials from the extension's encrypted secret store.
 *
 * @module services/extensions/extension-proxy
 */
import { Router, type Request, type Response } from 'express';
import type { DataProxyConfig } from '@dorkos/extension-api';
import { ExtensionSecretStore } from '@dorkos/shared/extension-secrets';
import { logger } from '../../lib/logger.js';
import { buildExtensionProxyRateLimiter } from '../../middleware/extension-proxy-rate-limit.js';

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
 */
const STRIPPED_HEADERS = new Set([
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
  'x-dorkos-agent',
]);

/** Filter request headers, removing hop-by-hop and caller-credential headers. */
function filterHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
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
 * `/proxy/../../admin` (or `..%2f..%2f`, which Express hands over already
 * decoded, or `%2e%2e`, which the URL parser treats as `..`) reaches endpoints
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

/**
 * Create a proxy router for an extension's dataProxy configuration.
 *
 * Routes: ALL /proxy/* -> upstream baseUrl with auth header injected.
 * Returns 503 if the required secret is not configured.
 * Returns 502 on upstream network failure.
 *
 * @param extensionId - Extension identifier for logging and secret lookup
 * @param config - DataProxy configuration from the extension manifest
 * @param dorkHome - Resolved DorkOS data directory for secret store access
 * @returns Express Router handling proxy requests
 */
export function createProxyRouter(
  extensionId: string,
  config: DataProxyConfig,
  dorkHome: string
): Router {
  const router = Router();
  const secrets = new ExtensionSecretStore(extensionId, dorkHome);
  const rateLimiter = buildExtensionProxyRateLimiter();
  // Parsed once: `DataProxySchema.baseUrl` is `z.string().url()`, so a manifest
  // that got this far cannot fail here.
  const base = new URL(config.baseUrl);

  router.all('/proxy/{*splat}', rateLimiter, async (req: Request, res: Response) => {
    // Express 5 named wildcard: req.params.splat is the matched sub-path as a
    // segment array (was req.params[0], a single string, on Express 4). The
    // braces make it optional so proxying the upstream root (/proxy/) still
    // matches, with splat undefined -> empty targetPath.
    const targetPath = (req.params.splat as string[] | undefined)?.join('/') ?? '';
    let targetUrl = `${config.baseUrl.replace(/\/+$/, '')}/${targetPath}`;

    // Confine the caller's sub-path to the upstream the manifest named, BEFORE
    // any credential is read or attached. Checked here rather than after the
    // rewrites below because `pathRewrite` is the extension author's own rule,
    // trusted at exactly the level `baseUrl` is; the sub-path is the caller's.
    let joined: URL;
    try {
      joined = new URL(targetUrl);
    } catch {
      res.status(400).json({ error: 'Invalid proxy path', code: 'PROXY_PATH_NOT_ALLOWED' });
      return;
    }
    if (!staysWithinBase(joined, base)) {
      logger.warn(
        `[ext:${extensionId}] Refused a proxy path outside ${base.origin}${base.pathname}: ${req.method} ${req.url}`
      );
      res.status(400).json({
        error: 'Proxy path is outside the extension upstream',
        code: 'PROXY_PATH_NOT_ALLOWED',
      });
      return;
    }

    // Apply path rewrites if configured.
    //
    // `from` is a pattern an extension author wrote in their manifest, compiled to
    // a RegExp and run against a caller-supplied path — a catastrophic-backtracking
    // surface on paper. It stays as-is because of where it sits: this router is
    // only ever mounted for an extension a person approved to run its code inside
    // DorkOS (`extension-load-policy.ts`), and an extension that may run code in
    // this process can hang it far more directly than by writing a slow regex. A
    // linear-time engine here would buy nothing against an adversary already past
    // that gate, and would silently change what authors' patterns mean.
    if (config.pathRewrite) {
      for (const [from, to] of Object.entries(config.pathRewrite)) {
        targetUrl = targetUrl.replace(new RegExp(from), to);
      }
    }

    // Forward query string if present
    const queryString = new URL(req.url, 'http://localhost').search;
    if (queryString) {
      targetUrl += queryString;
    }

    // Retrieve auth secret
    const secret = await secrets.get(config.authSecret);
    if (!secret) {
      res.status(503).json({
        error: `Secret '${config.authSecret}' not configured for extension '${extensionId}'`,
        hint: `Set the secret via PUT /api/extensions/${extensionId}/secrets/${config.authSecret}`,
      });
      return;
    }

    const authValue = formatAuthValue(config.authType, secret);

    try {
      const upstreamRes = await fetch(targetUrl, {
        method: req.method,
        headers: {
          ...filterHeaders(req.headers as Record<string, string | string[] | undefined>),
          [config.authHeader]: authValue,
          'Content-Type': req.headers['content-type'] ?? 'application/json',
        },
        // req.body ?? {}: Express 5 leaves req.body undefined on an empty-body
        // POST, so forward "{}" (matching the always-JSON Content-Type above and
        // Express 4 behavior) rather than dropping the body entirely.
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body ?? {}),
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

      // Forward upstream status code
      res.status(upstreamRes.status);

      // Forward content-type header
      const contentType = upstreamRes.headers.get('content-type');
      if (contentType) res.setHeader('Content-Type', contentType);

      // Forward `Location` so a caller that got a 3xx above can see where the
      // upstream pointed and decide for itself.
      const location = upstreamRes.headers.get('location');
      if (location) res.setHeader('Location', location);

      const body = await upstreamRes.text();
      res.send(body);
    } catch (err) {
      logger.error(`[ext:${extensionId}] Proxy error for ${req.method} ${targetUrl}:`, err);
      res.status(502).json({
        error: 'Proxy request failed',
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
