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
import { McpAppResourceRequestSchema } from '@dorkos/shared/schemas';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import type { ApiEnv } from '../http/api-chain.js';
import { problem, readJsonBody, validationProblem } from '@dorkos/http-kit';
import type { ProblemCode } from '@dorkos/shared/problem';
import { parseSessionId } from '../lib/route-utils.js';
import { invalidSessionId, sessionNotFound } from './session-route-replies.js';
import { logger } from '../lib/logger.js';
import { getOrCreateProjector } from '../services/session/index.js';
import {
  resolveAppResource,
  McpAppResourceError,
  UI_SCHEME,
  type McpAppResourceErrorCode,
} from '../services/mcp-apps/index.js';

/** The problem each resource refusal answers with; a failed read has none of its own. */
const RESOURCE_ERROR_CODES: Partial<Record<McpAppResourceErrorCode, ProblemCode>> = {
  INVALID_SCHEME: 'invalid_request',
  UNSUPPORTED_MIME: 'unsupported_media_type',
  NOT_FOUND: 'not_found',
};

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
  if (!sessionId) return invalidSessionId(c);

  const parsed = McpAppResourceRequestSchema.safeParse(readJsonBody(c));
  if (!parsed.success) {
    return validationProblem(c, parsed.error);
  }
  const { serverName, uri } = parsed.data;

  // Cheap early reject before any runtime work — the service re-checks too.
  if (!uri.startsWith(UI_SCHEME)) {
    return problem(c, 'invalid_request', {
      detail: `Resource URI must use the ${UI_SCHEME} scheme`,
    });
  }

  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  if (!runtime.hasSession(sessionId)) {
    return sessionNotFound(c);
  }

  // Server-authoritative cwd: the projector tracks the directory the session's
  // turns ran in. A tool_result carrying a ui:// URI implies a turn ran, so
  // this is set; a session with no turn yet has no MCP context to fetch from.
  const cwd = getOrCreateProjector(sessionId).cwd;
  if (!cwd) {
    return problem(c, 'not_found', { detail: 'This chat has no MCP servers yet.' });
  }

  // Membership: the server must be in this cwd's live MCP set.
  const servers = runtime.getMcpStatus?.(cwd) ?? [];
  if (!servers.some((s) => s.name === serverName)) {
    return problem(c, 'not_found', {
      detail: `MCP server "${serverName}" not found for this chat`,
    });
  }

  const connection = runtime.getMcpServerConfig?.(cwd, serverName);
  if (!connection) {
    return problem(c, 'not_found', { detail: `No settings for the "${serverName}" tool server.` });
  }

  try {
    const resource = await resolveAppResource({ serverName, uri, connection });
    return c.json(resource, 200);
  } catch (err) {
    if (err instanceof McpAppResourceError) {
      const code = RESOURCE_ERROR_CODES[err.code];
      if (code === undefined) {
        logger.warn('[POST /mcp-app/resource] read failed', { sessionId, serverName, uri });
        // The MCP server's read failed: a bad answer from upstream, so 502.
        return problem(c, 'temporarily_unavailable', { detail: err.message, status: 502 });
      }
      return problem(c, code, { detail: err.message });
    }
    throw err;
  }
}
