/**
 * Registers the `dorkos://sessions` and `dorkos://sessions/{id}` MCP
 * resources against a live `McpServer` instance. Split out of
 * `mcp-server.ts` — see `core-tools.ts` in this directory for why.
 *
 * Mirrors `GET /api/sessions` (ADR-0310): sessions are aggregated across
 * every registered runtime via `aggregateSessionList`, degrading per
 * runtime instead of failing the whole read. Both resources are scoped to
 * `deps.defaultCwd` — the external MCP server has no per-request `cwd`
 * parameter to key on, so it reads the server's own default project the
 * same way `get_session_count`/`get_agent` do when called without an
 * explicit scope. Session content is metadata only (id, title, runtime,
 * cwd, updatedAt) — transcripts and message bodies are never included; a
 * client that needs those still calls `GET /api/sessions/:id/messages`.
 *
 * @module services/core/external-mcp/session-resources
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SessionSchema } from '@dorkos/shared/schemas';
import type { RuntimeRegistry } from '../runtime-registry.js';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import { aggregateSessionList } from '../../session/aggregate-session-list.js';
import { jsonResourceContents, resourceNotFound, resourceUnavailable } from './resource-helpers.js';

/** Cheap, non-transcript per-session metadata — the `dorkos://sessions/{id}` shape. */
const SessionResourceSchema = SessionSchema.pick({
  id: true,
  title: true,
  runtime: true,
  cwd: true,
  updatedAt: true,
});

/** `dorkos://sessions` list payload — the full aggregate shape `GET /api/sessions` returns. */
const SessionListResourceSchema = z.object({
  sessions: z.array(SessionSchema),
  warnings: z
    .array(z.object({ runtime: z.string(), message: z.string() }))
    .optional()
    .describe('Present only when one or more runtimes failed or timed out during aggregation'),
});

/** Resolve the URI template's `id` variable to a single string (never an array for this template). */
function firstVar(value: string | string[]): string {
  return Array.isArray(value) ? value[0]! : value;
}

/** Guard that returns the injected registry or throws a clear "not available" error. */
function requireRuntimeRegistry(deps: McpToolDeps): RuntimeRegistry {
  if (!deps.runtimeRegistry) {
    resourceUnavailable('Runtime registry is not available.');
  }
  return deps.runtimeRegistry;
}

/**
 * Register `dorkos://sessions` and `dorkos://sessions/{id}` against `server`.
 *
 * @param server - The external `McpServer` instance to register resources against.
 * @param deps - Shared MCP tool dependencies.
 */
export function registerSessionResources(server: McpServer, deps: McpToolDeps): void {
  server.registerResource(
    'sessions',
    'dorkos://sessions',
    {
      title: 'Sessions',
      description:
        'Sessions across every registered runtime (claude-code, codex, opencode), scoped to the ' +
        "server's default working directory. Degrades per runtime — a backend that fails or times " +
        'out contributes a warning instead of failing the whole read. Metadata only, no transcript ' +
        'or message content.',
      mimeType: 'application/json',
    },
    async () => {
      const registry = requireRuntimeRegistry(deps);
      const { sessions, warnings } = await aggregateSessionList({
        runtimes: registry.listRuntimes(),
        projectDir: deps.defaultCwd,
      });
      return jsonResourceContents(
        'dorkos://sessions',
        SessionListResourceSchema.parse({
          sessions,
          ...(warnings.length > 0 && { warnings }),
        })
      );
    }
  );

  server.registerResource(
    'session',
    // `list: undefined` — `dorkos://sessions` above already enumerates every
    // valid id; re-enumerating them as individual template entries in
    // `resources/list` would be redundant. The template is reachable by any
    // client that already knows a session id.
    new ResourceTemplate('dorkos://sessions/{id}', { list: undefined }),
    {
      title: 'Session',
      description:
        'Metadata for a single session by id (id, title, runtime, cwd, updatedAt) — not the ' +
        "transcript or message content. Resolved against the server's default working directory.",
      mimeType: 'application/json',
    },
    async (uri, { id }) => {
      const registry = requireRuntimeRegistry(deps);
      const sessionId = firstVar(id);

      let session;
      try {
        const runtime = await registry.resolveForSession(sessionId);
        const internalId = runtime.getInternalSessionId(sessionId) ?? sessionId;
        session = await runtime.getSession(deps.defaultCwd, internalId);
        if (session && !session.runtime) session.runtime = runtime.type;
      } catch {
        // Unregistered/unresolvable runtime for this id — treat the same as
        // "not found" rather than leaking the routing error.
        session = null;
      }
      if (!session) resourceNotFound(`Session not found: ${sessionId}`);

      return jsonResourceContents(uri.toString(), SessionResourceSchema.parse(session));
    }
  );
}
