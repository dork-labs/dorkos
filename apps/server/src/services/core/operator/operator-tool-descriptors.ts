/**
 * Transport-neutral descriptor table for the self-service & observability MCP
 * tools (DOR-430) — the single shared source of truth registered by both MCP
 * servers, mirroring the marketplace descriptor-table pattern (DOR-429).
 *
 * Each descriptor pairs a tool's identity (name, description, annotations, input
 * schema) with its dependency-injected handler factory. Both servers consume
 * this one table:
 *
 * - the external `/mcp` server (`registerOperatorTools`, `McpServer`), and
 * - the in-session `dorkos` server (`getOperatorTools`, Claude Agent SDK
 *   `tool()` helper).
 *
 * The handlers live in `operator-tool-handlers.ts` and are transport-neutral —
 * they take plain args and return an MCP text-content result, importing neither
 * MCP SDK. This module imports neither SDK either: the two servers own the
 * SDK-specific registration glue and share everything else from here.
 *
 * @module services/core/operator/operator-tool-descriptors
 */
import { z, type ZodRawShape } from 'zod';
import { ListActivityQuerySchema } from '@dorkos/shared/activity-schemas';
import { RecentSessionsQuerySchema } from '@dorkos/shared/schemas';
import { TraitsSchema, ConventionsSchema } from '@dorkos/shared/mesh-schemas';

import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import { ToolAnnotationPresets } from '../mcp-tool-metadata.js';
import {
  type OperatorToolResult,
  createUpdateAgentHandler,
  createActivityListHandler,
  createConfigGetHandler,
  createConfigPatchHandler,
  createCheckUpdateHandler,
  createAgentsRecentActivityHandler,
} from './operator-tool-handlers.js';

export type { OperatorToolResult } from './operator-tool-handlers.js';

const A = ToolAnnotationPresets;

/**
 * One of the four-hint annotation presets. Carried on each descriptor for the
 * external server (which advertises read/write/destructive/open-world hints);
 * the in-session SDK `tool()` helper has no annotations slot and ignores it.
 */
export type OperatorToolAnnotations =
  (typeof ToolAnnotationPresets)[keyof typeof ToolAnnotationPresets];

/**
 * A single operator tool, described independently of any MCP SDK. Schema and
 * handler-arg types are erased to the array-element boundary via
 * {@link defineOperatorTool}, which type-checks the pairing before erasing.
 */
export interface OperatorToolDescriptor {
  /** Registered tool name, e.g. `update_agent`. */
  name: string;
  /** Human-facing tool description shown to the model. */
  description: string;
  /** Read/write/destructive/open-world hints for the external server. */
  annotations: OperatorToolAnnotations;
  /** Zod field-map input schema (empty object for argument-less tools). */
  inputSchema: ZodRawShape;
  /** Build the dependency-bound handler for this tool. */
  createHandler: (
    deps: McpToolDeps
  ) => (args: Record<string, unknown>) => Promise<OperatorToolResult>;
}

/**
 * Build a descriptor, type-checking that the handler's argument type matches the
 * declared input schema before erasing both to the shared
 * {@link OperatorToolDescriptor} element type. The single `unknown` cast is
 * confined here so every call site stays fully type-checked.
 *
 * @template Schema - The tool's Zod field-map input schema.
 * @param spec - The tool's identity, schema, and handler factory.
 * @returns The type-erased descriptor for the shared table.
 */
function defineOperatorTool<Schema extends ZodRawShape>(spec: {
  name: string;
  description: string;
  annotations: OperatorToolAnnotations;
  inputSchema: Schema;
  createHandler: (
    deps: McpToolDeps
  ) => (args: z.infer<z.ZodObject<Schema>>) => Promise<OperatorToolResult>;
}): OperatorToolDescriptor {
  return spec as unknown as OperatorToolDescriptor;
}

/** Agent selector shared by tools that address one agent by id or directory. */
const agentSelectorSchema = {
  agent_id: z.string().optional().describe('Agent ULID to target (mutually exclusive with cwd)'),
  cwd: z
    .string()
    .optional()
    .describe('Agent project directory to target (mutually exclusive with agent_id)'),
};

/**
 * The shared operator tool catalog. Order is the registration order on both
 * servers: read-only observability tools first, then the two config/agent
 * mutations. The two mutating tools (`update_agent`, `config_patch`) are
 * deliberately NOT in `READ_ONLY_MCP_TOOL_NAMES` — they require the local token
 * on the login-off external surface.
 */
export const OPERATOR_TOOL_DESCRIPTORS: readonly OperatorToolDescriptor[] = [
  // ── Read-only observability ─────────────────────────────────────────────
  defineOperatorTool({
    name: 'activity_list',
    description:
      'List DorkOS activity-feed events (agent, tasks, relay, config, system). ' +
      'Filter by categories (comma-separated), actorType, actorId, and a time window ' +
      '(before/since ISO timestamps); paginate with limit and the returned nextCursor.',
    annotations: A.readOnlyLocal,
    inputSchema: ListActivityQuerySchema.shape,
    createHandler: createActivityListHandler,
  }),
  defineOperatorTool({
    name: 'config_get',
    description:
      'Get the full DorkOS user configuration snapshot (the stored config.json object): ' +
      'sidebar/status-bar prefs, scheduler, logging, mesh, telemetry, agents, and more.',
    annotations: A.readOnlyLocal,
    inputSchema: {},
    createHandler: () => createConfigGetHandler(),
  }),
  defineOperatorTool({
    name: 'check_update',
    description:
      'Check for a DorkOS update: returns the running server version and the latest ' +
      'version published to npm. latestVersion is null in dev builds or if the registry is unreachable.',
    annotations: A.readOnlyOpenWorld,
    inputSchema: {},
    createHandler: () => createCheckUpdateHandler(),
  }),
  defineOperatorTool({
    name: 'agents_recent_activity',
    description:
      'Show which agents were active recently. Returns each agent joined with the timestamp of ' +
      'its most-recent session, newest first — the same per-agent latest-activity map the cockpit uses.',
    annotations: A.readOnlyLocal,
    inputSchema: RecentSessionsQuerySchema.shape,
    createHandler: createAgentsRecentActivityHandler,
  }),

  // ── Mutations (NOT in the read-only carve-out) ──────────────────────────
  defineOperatorTool({
    name: 'update_agent',
    description:
      "Edit an agent's manifest and personality: displayName, description, persona, personaEnabled, " +
      'traits, conventions, color, icon, and SOUL.md (soulContent) / NOPE.md (nopeContent) content. ' +
      'Target the agent by agent_id or cwd. The slug (name) is immutable, and system agents (e.g. DorkBot) ' +
      'reject identity changes. Editing your OWN agent is fine; before editing a DIFFERENT agent, confirm with the user first.',
    annotations: A.mutateUpdateLocal,
    inputSchema: {
      ...agentSelectorSchema,
      displayName: z.string().optional().describe('Human-facing display name'),
      description: z.string().optional().describe('Short agent description'),
      persona: z
        .string()
        .optional()
        .describe('Legacy persona prose (prefer SOUL.md via soulContent)'),
      personaEnabled: z.boolean().optional().describe('Whether the persona/SOUL block is injected'),
      traits: TraitsSchema.optional().describe('Personality trait scores'),
      conventions: ConventionsSchema.optional().describe('Working conventions'),
      color: z.string().nullable().optional().describe('Accent color (null clears it)'),
      icon: z.string().nullable().optional().describe('Icon name (null clears it)'),
      soulContent: z.string().max(4000).optional().describe('Full SOUL.md content'),
      nopeContent: z.string().max(2000).optional().describe('Full NOPE.md content'),
    },
    createHandler: createUpdateAgentHandler,
  }),
  defineOperatorTool({
    name: 'config_patch',
    description:
      'Update DorkOS user settings by deep-merging a partial config object (the same validated path as the ' +
      "settings UI). Use for status-bar/sidebar prefs, scheduler, logging, etc. This mutates the user's own " +
      'settings — only do it when the user has asked for the change. Arrays replace (not merge); invalid values are rejected.',
    annotations: A.mutateUpdateLocal,
    inputSchema: {
      patch: z
        .record(z.string(), z.unknown())
        .describe(
          'Partial config to deep-merge, e.g. { "ui": { "sidebar": { "collapsed": true } } }'
        ),
    },
    createHandler: () => createConfigPatchHandler(),
  }),
];
