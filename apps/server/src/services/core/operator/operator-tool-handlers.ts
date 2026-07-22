/**
 * Transport-neutral handlers for the self-service & observability MCP tools
 * (`update_agent`, `activity_list`, `config_get`, `config_patch`,
 * `check_update`, `agents_recent_activity`).
 *
 * Each handler is a thin wrapper over existing service logic — the agent-update
 * service, `ActivityService`, `ConfigManager` (via the shared config-patch
 * service), `update-checker`, and the recent-sessions fan-out — so no route
 * validation is duplicated. Handlers take plain args and return an MCP
 * text-content result, importing neither MCP SDK; the two servers own the
 * SDK-specific registration glue and share these handlers via
 * {@link module:services/core/operator/operator-tool-descriptors}.
 *
 * @module services/core/operator/operator-tool-handlers
 */
import { z } from 'zod';
import { ListActivityQuerySchema } from '@dorkos/shared/activity-schemas';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import { validateBoundaryOrDorkHome, BoundaryError } from '../../../lib/boundary.js';
import { SERVER_VERSION } from '../../../lib/version.js';
import { updateAgentManifest, AgentUpdateError } from './agent-updater.js';
import { applyConfigPatch } from './config-patch.js';
import { configManager } from '../config-manager.js';
import { getLatestVersion } from '../update-checker.js';
import { listRecentSessions } from '../../session/index.js';

/**
 * The MCP text-content result shape every operator handler returns. A
 * locally-defined structural type (not the MCP SDK's `CallToolResult`) so this
 * shared layer stays SDK-free; both servers' handler slots accept it because
 * their `CallToolResult` is a strict superset of this shape.
 */
export type OperatorToolResult = {
  /** One or more text blocks carrying the JSON-encoded tool payload. */
  content: { type: 'text'; text: string }[];
  /** Set on failure paths so MCP clients can distinguish errors from payloads. */
  isError?: boolean;
};

/** Build a single-block JSON tool result, flagging `isError` on failure paths. */
function jsonResult(data: unknown, isError = false): OperatorToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    ...(isError && { isError: true }),
  };
}

/**
 * Resolve an agent's project directory from either `agent_id` or `cwd` (exactly
 * one, mutually exclusive). Inlined here — rather than importing the runtime's
 * `resolveAgentCwd` — so this shared module never pulls the Claude Agent SDK
 * into the external MCP server's import graph.
 *
 * @param deps - Tool deps; `meshCore` is required to resolve an `agent_id`.
 * @param args - The `agent_id` or `cwd` selector.
 * @returns The resolved agent project directory (not yet boundary-validated).
 */
function resolveAgentPath(deps: McpToolDeps, args: { agent_id?: string; cwd?: string }): string {
  if (!args.agent_id && !args.cwd) {
    throw new Error('Either agent_id or cwd must be provided to identify the agent.');
  }
  if (args.agent_id && args.cwd) {
    throw new Error('Provide either agent_id or cwd, not both.');
  }
  if (args.cwd) return args.cwd;
  if (!deps.meshCore) {
    throw new Error('Mesh is not enabled. Cannot resolve agent_id without Mesh.');
  }
  const projectPath = deps.meshCore.getProjectPath(args.agent_id!);
  if (!projectPath) {
    throw new Error(`Agent not found: ${args.agent_id}`);
  }
  return projectPath;
}

/** Editable self-edit fields accepted by `update_agent`, beyond the agent selector. */
export interface UpdateAgentArgs {
  agent_id?: string;
  cwd?: string;
  displayName?: string;
  description?: string;
  persona?: string;
  personaEnabled?: boolean;
  traits?: Record<string, number>;
  conventions?: Record<string, unknown>;
  color?: string | null;
  icon?: string | null;
  soulContent?: string;
  nopeContent?: string;
}

/**
 * `update_agent` — apply a self-edit patch to an agent manifest, enforcing the
 * exact PATCH `/api/agents/current` guards (immutable slug, system-agent
 * identity protection) via the shared {@link updateAgentManifest} service.
 *
 * @param deps - Tool deps (`meshCore` for `agent_id` resolution + DB sync).
 * @returns The bound handler.
 */
export function createUpdateAgentHandler(deps: McpToolDeps) {
  return async (args: UpdateAgentArgs): Promise<OperatorToolResult> => {
    try {
      const { agent_id, cwd, ...patch } = args;
      const resolved = resolveAgentPath(deps, { agent_id, cwd });
      const agentPath = await validateBoundaryOrDorkHome(resolved);
      const updated = await updateAgentManifest({
        agentPath,
        body: patch,
        meshCore: deps.meshCore,
      });
      return jsonResult(updated);
    } catch (err) {
      if (err instanceof BoundaryError) {
        return jsonResult({ error: err.message, code: err.code }, true);
      }
      if (err instanceof AgentUpdateError) {
        return jsonResult(
          { error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) },
          true
        );
      }
      return jsonResult(
        { error: err instanceof Error ? err.message : 'Failed to update agent' },
        true
      );
    }
  };
}

/**
 * `activity_list` — query the append-only activity feed through
 * {@link ActivityService}, validating args with the same
 * {@link ListActivityQuerySchema} the HTTP route uses.
 *
 * @param deps - Tool deps (`activityService`).
 * @returns The bound handler.
 */
export function createActivityListHandler(deps: McpToolDeps) {
  return async (args: Record<string, unknown>): Promise<OperatorToolResult> => {
    if (!deps.activityService) {
      return jsonResult({ error: 'Activity feed is not available in this instance.' }, true);
    }
    const parsed = ListActivityQuerySchema.safeParse(args);
    if (!parsed.success) {
      return jsonResult(
        { error: 'Validation failed', details: z.flattenError(parsed.error) },
        true
      );
    }
    try {
      const result = await deps.activityService.list(parsed.data);
      return jsonResult(result);
    } catch (err) {
      return jsonResult(
        { error: err instanceof Error ? err.message : 'Failed to fetch activity events' },
        true
      );
    }
  };
}

/**
 * `config_get` — return the full user config snapshot (`ConfigManager.getAll()`),
 * the same stored object `PATCH /api/config` writes to.
 *
 * @returns The bound handler (no deps; reads the config singleton).
 */
export function createConfigGetHandler() {
  return async (): Promise<OperatorToolResult> => {
    try {
      return jsonResult(configManager.getAll());
    } catch (err) {
      return jsonResult(
        { error: err instanceof Error ? err.message : 'Failed to read config' },
        true
      );
    }
  };
}

/**
 * `config_patch` — deep-merge a partial config and persist it through the shared
 * {@link applyConfigPatch} service (the same Zod-validated path as
 * `PATCH /api/config`). A user-settings mutation: the tool description flags
 * that it requires explicit user intent.
 *
 * @returns The bound handler (no deps; writes via the config singleton).
 */
export function createConfigPatchHandler() {
  return async (args: { patch?: Record<string, unknown> }): Promise<OperatorToolResult> => {
    const result = applyConfigPatch(args.patch);
    if (!result.ok) {
      return jsonResult(
        { error: result.error, ...(result.details ? { details: result.details } : {}) },
        true
      );
    }
    return jsonResult({
      success: true,
      config: result.config,
      ...(result.warnings.length > 0 && { warnings: result.warnings }),
    });
  };
}

/**
 * `check_update` — report the running server version and the latest published
 * version from the npm registry (via the cached {@link getLatestVersion}).
 * `latestVersion` is `null` in dev builds or when the registry is unreachable.
 *
 * @returns The bound handler (no deps).
 */
export function createCheckUpdateHandler() {
  return async (): Promise<OperatorToolResult> => {
    const latestVersion = await getLatestVersion();
    return jsonResult({ version: SERVER_VERSION, latestVersion });
  };
}

/**
 * `agents_recent_activity` — the per-agent latest-activity map behind
 * `GET /api/sessions/recent`. Fans out {@link listRecentSessions} across every
 * registered agent's project directory and returns each agent joined with its
 * most-recent session `updatedAt`, plus the raw `agentActivity` map and any
 * per-runtime `warnings`.
 *
 * @param deps - Tool deps (`runtimeRegistry` for the fan-out; `meshCore` for the
 *   agent roster).
 * @returns The bound handler.
 */
export function createAgentsRecentActivityHandler(deps: McpToolDeps) {
  return async (args: { limit?: number }): Promise<OperatorToolResult> => {
    if (!deps.runtimeRegistry) {
      return jsonResult({ error: 'Runtime registry is not available in this instance.' }, true);
    }
    const limit = args.limit ?? 10;
    const roster = deps.meshCore ? deps.meshCore.listWithPaths() : [];
    const runtimes = deps.runtimeRegistry.listRuntimes();
    const { agentActivity, warnings } = await listRecentSessions({
      runtimes,
      agentPaths: roster.map((a) => a.projectPath),
      limit,
    });
    // Join the roster with its latest activity for a legible, agent-keyed view;
    // keep the raw path→timestamp map too (the route's `agentActivity` field).
    const agents = roster
      .map((a) => ({
        id: a.id,
        name: a.name,
        displayName: a.displayName ?? null,
        projectPath: a.projectPath,
        lastActivity: agentActivity[a.projectPath] ?? null,
      }))
      .filter((a) => a.lastActivity !== null)
      .sort((x, y) => Date.parse(y.lastActivity!) - Date.parse(x.lastActivity!));
    return jsonResult({ agents, agentActivity, warnings });
  };
}
