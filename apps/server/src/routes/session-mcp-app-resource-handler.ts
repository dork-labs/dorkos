/**
 * Handler for `POST /api/sessions/:id/mcp-app/resource` — reads a `ui://` MCP
 * App resource (SEP-1865) for the client to render (ADR `260708-141143`, spec
 * `mcp-apps-host` §2.1). Extracted from `sessions.ts` to keep that file under
 * the file-size rule, mirroring `session-ui-action-handler.ts`.
 *
 * The browser never sees the MCP connection config: the client sends only
 * `{ serverName, uri }`, and the server resolves the resolved stdio/http config
 * from its own server-only cache. Authorization is enforced here — the URI must
 * use the `ui://` scheme and the server must be in the session's live MCP set —
 * before the {@link resolveAppResource} service opens its short-lived client.
 *
 * @module routes/session-mcp-app-resource-handler
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { McpAppResourceRequestSchema } from '@dorkos/shared/schemas';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { errorBody, parseSessionId } from '../lib/route-utils.js';
import { logger } from '../lib/logger.js';
import { getOrCreateProjector } from '../services/session/index.js';
import { resolveAppResource, McpAppResourceError, UI_SCHEME } from '../services/mcp-apps/index.js';

/**
 * Handler for `POST /api/sessions/:id/mcp-app/resource`, mounted by
 * `sessions.ts`. Returns 200 with the resource + sandbox metadata, or 400 (bad
 * scheme/body) / 404 (unknown session or server) / 502 (upstream MCP read
 * failed).
 *
 * @param c - The request context (`:id` param + `McpAppResourceRequest` body).
 */
export async function sessionMcpAppResourceHandler(c: Context<ApiEnv>): Promise<Response> {
  const sessionId = parseSessionId(c.req.param('id'));
  if (!sessionId) return c.json(errorBody('Invalid session ID', 'INVALID_SESSION_ID'), 400);

  const parsed = McpAppResourceRequestSchema.safeParse(readJsonBody(c));
  if (!parsed.success) {
    return c.json(errorBody('Invalid request', 'VALIDATION_ERROR'), 400);
  }
  const { serverName, uri } = parsed.data;

  // Cheap early reject before any runtime work — the service re-checks too.
  if (!uri.startsWith(UI_SCHEME)) {
    return c.json(errorBody(`Resource URI must use the ${UI_SCHEME} scheme`, 'INVALID_URI'), 400);
  }

  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  if (!runtime.hasSession(sessionId)) {
    return c.json(errorBody('Session not found', 'SESSION_NOT_FOUND'), 404);
  }

  // Server-authoritative cwd: the projector tracks the directory the session's
  // turns ran in. A tool_result carrying a ui:// URI implies a turn ran, so
  // this is set; a session with no turn yet has no MCP context to fetch from.
  const cwd = getOrCreateProjector(sessionId).cwd;
  if (!cwd) {
    return c.json(errorBody('No MCP context for session', 'NO_MCP_CONTEXT'), 404);
  }

  // Membership: the server must be in this cwd's live MCP set.
  const servers = runtime.getMcpStatus?.(cwd) ?? [];
  if (!servers.some((s) => s.name === serverName)) {
    return c.json(
      errorBody(`MCP server "${serverName}" not found for session`, 'SERVER_NOT_FOUND'),
      404
    );
  }

  const connection = runtime.getMcpServerConfig?.(cwd, serverName);
  if (!connection) {
    return c.json(
      errorBody(`No connection config captured for "${serverName}"`, 'SERVER_CONFIG_UNAVAILABLE'),
      404
    );
  }

  try {
    const resource = await resolveAppResource({ serverName, uri, connection });
    return c.json(resource, 200);
  } catch (err) {
    if (err instanceof McpAppResourceError) {
      const status: ContentfulStatusCode =
        err.code === 'INVALID_SCHEME'
          ? 400
          : err.code === 'UNSUPPORTED_MIME'
            ? 415
            : err.code === 'NOT_FOUND'
              ? 404
              : 502;
      if (status === 502) {
        logger.warn('[POST /mcp-app/resource] read failed', { sessionId, serverName, uri });
      }
      return c.json(errorBody(err.message, err.code), status);
    }
    throw err;
  }
}
