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
import type { Request, Response } from 'express';
import { McpAppResourceRequestSchema } from '@dorkos/shared/schemas';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { parseSessionId, sendError } from '../lib/route-utils.js';
import { logger } from '../lib/logger.js';
import { getOrCreateProjector } from '../services/session/index.js';
import { resolveAppResource, McpAppResourceError, UI_SCHEME } from '../services/mcp-apps/index.js';

/**
 * Express handler for `POST /api/sessions/:id/mcp-app/resource`. Mounted by
 * `sessions.ts` under `asyncHandler`. Returns 200 with the resource + sandbox
 * metadata, or 400 (bad scheme/body) / 404 (unknown session or server) / 502
 * (upstream MCP read failed).
 *
 * @param req - Express request (`:id` param + `McpAppResourceRequest` body).
 * @param res - Express response.
 */
export async function sessionMcpAppResourceHandler(req: Request, res: Response): Promise<void> {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = McpAppResourceRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }
  const { serverName, uri } = parsed.data;

  // Cheap early reject before any runtime work — the service re-checks too.
  if (!uri.startsWith(UI_SCHEME)) {
    return sendError(res, 400, `Resource URI must use the ${UI_SCHEME} scheme`, 'INVALID_URI');
  }

  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  if (!runtime.hasSession(sessionId)) {
    return sendError(res, 404, 'Session not found', 'SESSION_NOT_FOUND');
  }

  // Server-authoritative cwd: the projector tracks the directory the session's
  // turns ran in. A tool_result carrying a ui:// URI implies a turn ran, so
  // this is set; a session with no turn yet has no MCP context to fetch from.
  const cwd = getOrCreateProjector(sessionId).cwd;
  if (!cwd) {
    return sendError(res, 404, 'No MCP context for session', 'NO_MCP_CONTEXT');
  }

  // Membership: the server must be in this cwd's live MCP set.
  const servers = runtime.getMcpStatus?.(cwd) ?? [];
  if (!servers.some((s) => s.name === serverName)) {
    return sendError(
      res,
      404,
      `MCP server "${serverName}" not found for session`,
      'SERVER_NOT_FOUND'
    );
  }

  const connection = runtime.getMcpServerConfig?.(cwd, serverName);
  if (!connection) {
    return sendError(
      res,
      404,
      `No connection config captured for "${serverName}"`,
      'SERVER_CONFIG_UNAVAILABLE'
    );
  }

  try {
    const resource = await resolveAppResource({ serverName, uri, connection });
    res.status(200).json(resource);
  } catch (err) {
    if (err instanceof McpAppResourceError) {
      if (err.code === 'INVALID_SCHEME') return sendError(res, 400, err.message, err.code);
      if (err.code === 'UNSUPPORTED_MIME') return sendError(res, 415, err.message, err.code);
      if (err.code === 'NOT_FOUND') return sendError(res, 404, err.message, err.code);
      logger.warn('[POST /mcp-app/resource] read failed', { sessionId, serverName, uri });
      return sendError(res, 502, err.message, err.code);
    }
    throw err;
  }
}
