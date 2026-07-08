/**
 * MCP Apps (SEP-1865) resource fetch — the DorkOS server's own short-lived MCP
 * client for reading `ui://` App resources (ADR `260708-141143`).
 *
 * DorkOS diverges from the reference MCP-Apps host: the agent runtime owns the
 * MCP connection and the SDK exposes no `resources/read`, so the browser client
 * cannot read the resource and the runtime will not. This service opens its own
 * ephemeral MCP client to the *same* server (using the connection config the
 * runtime already resolved, captured server-side — never exposed to the client)
 * and reads the resource as structured data. That structured read is what
 * recovers the mime type, CSP, and declared permissions that the runtime's
 * text-flattening discarded (see spec `mcp-apps-host` §0).
 *
 * @module services/mcp-apps/mcp-app-resource-service
 */
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpAppServerConnection } from '@dorkos/shared/agent-runtime';
import {
  McpAppPermissionSchema,
  type McpAppPermission,
  type McpAppResourceResponse,
} from '@dorkos/shared/schemas';
import { logger } from '../../lib/logger.js';

/** The `ui://` scheme every MCP App resource must use (SEP-1865). */
export const UI_SCHEME = 'ui://';

/** Mime-type prefix an App resource must carry — anything else is not renderable HTML. */
const HTML_MIME_PREFIX = 'text/html';

/** How long a fetched resource stays cached, keyed by `(connection, serverName, uri)`. */
const RESOURCE_TTL_MS = 30_000;

/** Wall-clock cap on the connect+read+close round trip before we give up. */
const FETCH_TIMEOUT_MS = 10_000;

/** Typed failure codes so the route can map to precise HTTP statuses. */
export type McpAppResourceErrorCode =
  | 'INVALID_SCHEME'
  | 'UNSUPPORTED_MIME'
  | 'NOT_FOUND'
  | 'READ_FAILED';

/** Error thrown by {@link resolveAppResource}; `code` drives the HTTP status. */
export class McpAppResourceError extends Error {
  constructor(
    readonly code: McpAppResourceErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'McpAppResourceError';
  }
}

interface CacheEntry {
  value: McpAppResourceResponse;
  expiresAt: number;
}

/** Process-wide TTL cache. Keyed by connection identity + server + uri. */
const resourceCache = new Map<string, CacheEntry>();

/**
 * Stable digest of a resolved connection config — the cache's identity for the
 * actual target server. Two projects can configure same-named MCP servers with
 * different commands/urls; without the config in the key, one project's cached
 * iframe HTML would cross-serve the other's within the TTL. JSON of the
 * discriminated union is deterministic enough here: the runtime hands us the
 * same object shape for the same resolved config.
 */
function connectionDigest(connection: McpAppServerConnection): string {
  return createHash('sha256').update(JSON.stringify(connection)).digest('hex');
}

/** Newline-delimited cache key — a newline cannot appear in any component. */
function cacheKey(connection: McpAppServerConnection, serverName: string, uri: string): string {
  return `${connectionDigest(connection)}\n${serverName}\n${uri}`;
}

/** Build the MCP client transport for a runtime-neutral connection descriptor. */
function createTransport(connection: McpAppServerConnection): Transport {
  if (connection.transport === 'stdio') {
    return new StdioClientTransport({
      command: connection.command,
      args: connection.args,
      env: connection.env,
    });
  }
  if (connection.transport === 'http') {
    return new StreamableHTTPClientTransport(new URL(connection.url), {
      requestInit: connection.headers ? { headers: connection.headers } : undefined,
    });
  }
  return new SSEClientTransport(new URL(connection.url), {
    requestInit: connection.headers ? { headers: connection.headers } : undefined,
  });
}

/** Read `_meta['ui/csp']` as a string, if present and well-typed. */
function extractCsp(meta: Record<string, unknown> | undefined): string | undefined {
  const csp = meta?.['ui/csp'];
  return typeof csp === 'string' && csp.length > 0 ? csp : undefined;
}

/**
 * Read `_meta['ui/permissions']` and keep only recognized feature-policy
 * directives — an unknown permission is dropped rather than trusted.
 */
function extractPermissions(meta: Record<string, unknown> | undefined): McpAppPermission[] {
  const raw = meta?.['ui/permissions'];
  if (!Array.isArray(raw)) return [];
  const valid: McpAppPermission[] = [];
  for (const entry of raw) {
    const parsed = McpAppPermissionSchema.safeParse(entry);
    if (parsed.success) valid.push(parsed.data);
  }
  return valid;
}

/**
 * Read a `ui://` MCP App resource by opening a short-lived MCP client to the
 * server, validating the scheme and mime type, and caching the result.
 *
 * The caller (route) is responsible for authorizing the request — confirming
 * the server belongs to the session's MCP set and resolving `connection` from
 * the server-only config cache. This function trusts `connection` and focuses
 * on the fetch + validation.
 *
 * @param params - `serverName`, the `ui://` `uri`, and the resolved `connection`.
 * @returns The resource body plus its sandbox metadata (mime, CSP, permissions).
 * @throws {McpAppResourceError} On non-`ui://` scheme, non-HTML mime, missing
 *   resource, or connection/read failure.
 */
export async function resolveAppResource(params: {
  serverName: string;
  uri: string;
  connection: McpAppServerConnection;
}): Promise<McpAppResourceResponse> {
  const { serverName, uri, connection } = params;

  if (!uri.startsWith(UI_SCHEME)) {
    throw new McpAppResourceError(
      'INVALID_SCHEME',
      `Resource URI must use the ${UI_SCHEME} scheme`
    );
  }

  const key = cacheKey(connection, serverName, uri);
  const cached = resourceCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const client = new Client(
    { name: 'dorkos-mcp-app-host', version: '1.0.0' },
    { capabilities: {} }
  );
  const transport = createTransport(connection);

  try {
    const result = await withTimeout(
      (async () => {
        await client.connect(transport);
        return client.readResource({ uri });
      })(),
      FETCH_TIMEOUT_MS
    );

    const content = result.contents[0];
    if (!content) {
      throw new McpAppResourceError('NOT_FOUND', `Resource ${uri} returned no contents`);
    }

    const mimeType = typeof content.mimeType === 'string' ? content.mimeType : '';
    if (!mimeType.startsWith(HTML_MIME_PREFIX)) {
      // Only HTML apps are renderable; reject e.g. application/json or images so
      // a non-App resource can never be framed as one.
      throw new McpAppResourceError(
        'UNSUPPORTED_MIME',
        `Resource ${uri} has mime "${mimeType || 'unknown'}"; expected ${HTML_MIME_PREFIX}`
      );
    }

    const meta = content._meta as Record<string, unknown> | undefined;
    const value: McpAppResourceResponse = {
      mimeType,
      ...('text' in content ? { text: content.text } : {}),
      ...('blob' in content ? { blob: content.blob } : {}),
      ...(extractCsp(meta) ? { csp: extractCsp(meta) } : {}),
      permissions: extractPermissions(meta),
    };

    resourceCache.set(key, { value, expiresAt: Date.now() + RESOURCE_TTL_MS });
    return value;
  } catch (err) {
    if (err instanceof McpAppResourceError) throw err;
    logger.warn('[mcp-apps] resource read failed', {
      serverName,
      uri,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new McpAppResourceError('READ_FAILED', `Failed to read ${uri} from ${serverName}`);
  } finally {
    await client.close().catch(() => {});
  }
}

/** Reject a promise if it does not settle within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new McpAppResourceError('READ_FAILED', 'MCP App fetch timed out')),
        ms
      )
    ),
  ]);
}

/**
 * Clear the resource cache.
 *
 * @internal Test hook only — lets suites start from an empty cache.
 */
export function __clearMcpAppResourceCache(): void {
  resourceCache.clear();
}
