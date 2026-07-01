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

/** Headers that should not be forwarded to the upstream API. */
const STRIPPED_HEADERS = new Set([
  'host',
  'connection',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'proxy-connection',
  'proxy-authorization',
]);

/** Filter request headers, removing hop-by-hop and sensitive headers. */
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

  router.all('/proxy/{*splat}', async (req: Request, res: Response) => {
    // Express 5 named wildcard: req.params.splat is the matched sub-path as a
    // segment array (was req.params[0], a single string, on Express 4). The
    // braces make it optional so proxying the upstream root (/proxy/) still
    // matches, with splat undefined -> empty targetPath.
    const targetPath = (req.params.splat as string[] | undefined)?.join('/') ?? '';
    let targetUrl = `${config.baseUrl.replace(/\/+$/, '')}/${targetPath}`;

    // Apply path rewrites if configured
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
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
      });

      // Forward upstream status code
      res.status(upstreamRes.status);

      // Forward content-type header
      const contentType = upstreamRes.headers.get('content-type');
      if (contentType) res.setHeader('Content-Type', contentType);

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
