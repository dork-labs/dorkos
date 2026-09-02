/**
 * The self-service & observability domain's capabilities (DOR-430, migrated onto
 * the Capability Registry in spec `capability-registry`, task 2.2).
 *
 * This module replaces `operator-tool-descriptors.ts`: every entry becomes a
 * {@link CapabilityDefinition} with the same tool name, model-facing
 * description, Zod input schema, and MCP annotation semantics. The transport-
 * neutral handlers in `operator-tool-handlers.ts` are unchanged — each
 * capability's `invoke` calls one and {@link unwrapMcpEnvelope}s its MCP text
 * envelope down to the plain payload the registry contract requires (the two
 * MCP adapters re-wrap it). Redaction stays inside the handlers, on every
 * surface, per ADR 260723-013236 (superseded by 260725-152018).
 *
 * The four read-only observability capabilities carry `readOnlyCarveOut: true`;
 * the two mutations (`operator.update_agent`, `operator.config_patch`) do not —
 * they require the local token on the login-off external `/mcp` surface.
 *
 * @module services/core/operator/operator-capabilities
 */
import { z } from 'zod';
import { ListActivityQuerySchema } from '@dorkos/shared/activity-schemas';
import { RecentSessionsQuerySchema } from '@dorkos/shared/schemas';
import { TraitsSchema, ConventionsSchema } from '@dorkos/shared/mesh-schemas';

import { defineCapability, type CapabilityDomain } from '../capabilities/index.js';
import type { CapabilityDeps } from '../capabilities/index.js';
import { unwrapMcpEnvelope } from '../capabilities/mcp-envelope.js';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import {
  createUpdateAgentHandler,
  createActivityListHandler,
  createConfigGetHandler,
  createConfigPatchHandler,
  createCheckUpdateHandler,
  createAgentsRecentActivityHandler,
  type UpdateAgentArgs,
} from './operator-tool-handlers.js';

/**
 * Extend the shared dependency bag with the operator domain's service handles.
 * The bag is the {@link McpToolDeps} the phase-1 operator handlers already
 * consume (mesh, runtime registry, activity service). Optional so a registry
 * composed from other domains alone need not supply it; every operator
 * `invoke` asserts its presence via {@link requireOperatorDeps}.
 */
declare module '../capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** Operator service handles consumed by the self-service/observability capabilities. */
    operatorDeps?: McpToolDeps;
  }
}

/**
 * Narrow the shared bag to the operator service handles, throwing if a registry
 * that owns operator capabilities was composed without them (a wiring bug).
 *
 * @param deps - The registry's shared dependency bag.
 * @returns The operator service handles.
 */
function requireOperatorDeps(deps: CapabilityDeps): McpToolDeps {
  if (!deps.operatorDeps) {
    throw new Error('Operator capability invoked without operatorDeps in the registry bag.');
  }
  return deps.operatorDeps;
}

/** Agent selector shared by capabilities that address one agent by id or directory. */
const agentSelectorSchema = {
  agent_id: z.string().optional().describe('Agent ULID to target (mutually exclusive with cwd)'),
  cwd: z
    .string()
    .optional()
    .describe('Agent project directory to target (mutually exclusive with agent_id)'),
};

/**
 * The self-service & observability domain: read-only observability capabilities
 * first, then the two config/agent mutations. This is the registration order on
 * both MCP servers.
 */
export const operatorDomain: CapabilityDomain = {
  name: 'operator',
  assertDeps: requireOperatorDeps,
  capabilities: [
    // ── Read-only observability ─────────────────────────────────────────────
    defineCapability({
      id: 'operator.activity_list',
      title: 'List activity',
      description:
        'List DorkOS activity-feed events (agent, tasks, relay, config, system). ' +
        'Filter by categories (comma-separated), actorType, actorId, and a time window ' +
        '(before/since ISO timestamps); paginate with limit and the returned nextCursor.',
      tier: 'observe',
      input: z.object(ListActivityQuerySchema.shape),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'activity_list',
          servers: ['in-session', 'external'],
          readOnlyCarveOut: true,
          annotations: { idempotentHint: true },
        },
        // The capability's input IS `ListActivityQuerySchema`, which the real
        // `GET /api/activity` route parses verbatim from its query string — so
        // this http surface projects into OpenAPI honestly (task 2.5). The other
        // operator routes do not line up so cleanly and stay hand-registerable
        // for the domain-by-domain migration follow-up (see `openapi-registry.ts`).
        http: { method: 'get', path: '/api/activity' },
      },
      invoke: async (deps, input) =>
        unwrapMcpEnvelope(await createActivityListHandler(requireOperatorDeps(deps))(input)),
    }),
    defineCapability({
      id: 'operator.config_get',
      title: 'Get configuration',
      description:
        'Get the DorkOS user configuration snapshot (an allowlisted view of the stored config.json): ' +
        'sidebar/status-bar prefs, scheduler, logging, mesh scan roots, telemetry choices, runtimes, ' +
        'workspace and server paths, and more. Left out: every secret (tunnel auth token, tunnel auth, ' +
        'MCP api key, cloud instance token), every credential reference (the providers map and the Codex ' +
        'credentialRef), and the linked account label. In their place you get boolean ...Configured flags ' +
        'plus providersConfigured (the provider ids that have a credential), so you can see what is set up ' +
        'without seeing where the material lives.',
      tier: 'observe',
      input: z.object({}),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'config_get',
          servers: ['in-session', 'external'],
          readOnlyCarveOut: true,
          annotations: { idempotentHint: true },
        },
      },
      invoke: async () => unwrapMcpEnvelope(await createConfigGetHandler()()),
    }),
    defineCapability({
      id: 'operator.check_update',
      title: 'Check for update',
      description:
        'Check for a DorkOS update: returns the running server version and the latest ' +
        'version published to npm. latestVersion is null in dev builds or if the registry is unreachable.',
      tier: 'observe',
      input: z.object({}),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'check_update',
          servers: ['in-session', 'external'],
          readOnlyCarveOut: true,
          annotations: { idempotentHint: true, openWorldHint: true },
        },
      },
      invoke: async () => unwrapMcpEnvelope(await createCheckUpdateHandler()()),
    }),
    defineCapability({
      id: 'operator.agents_recent_activity',
      title: 'Recent agent activity',
      description:
        'Show which agents were active recently. Returns each agent joined with the timestamp of ' +
        'its most-recent session, newest first — the same per-agent latest-activity map the app uses.',
      tier: 'observe',
      input: z.object(RecentSessionsQuerySchema.shape),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'agents_recent_activity',
          servers: ['in-session', 'external'],
          readOnlyCarveOut: true,
          annotations: { idempotentHint: true },
        },
      },
      invoke: async (deps, input) =>
        unwrapMcpEnvelope(
          await createAgentsRecentActivityHandler(requireOperatorDeps(deps))(input)
        ),
    }),

    // ── Mutations (NOT in the read-only carve-out) ──────────────────────────
    defineCapability({
      id: 'operator.update_agent',
      title: 'Update agent',
      description:
        "Edit an agent's manifest and personality: displayName, description, persona, personaEnabled, " +
        'traits, conventions, color, icon, and SOUL.md (soulContent) / NOPE.md (nopeContent) content. ' +
        'Target the agent by agent_id or cwd. The slug (name) is immutable, and system agents (e.g. DorkBot) ' +
        'reject identity changes. Editing your OWN agent is fine; before editing a DIFFERENT agent, confirm with the user first.',
      tier: 'act',
      input: z.object({
        ...agentSelectorSchema,
        displayName: z.string().optional().describe('Human-facing display name'),
        description: z.string().optional().describe('Short agent description'),
        persona: z
          .string()
          .optional()
          .describe('Legacy persona prose (prefer SOUL.md via soulContent)'),
        personaEnabled: z
          .boolean()
          .optional()
          .describe('Whether the persona/SOUL block is injected'),
        traits: TraitsSchema.optional().describe('Personality trait scores'),
        conventions: ConventionsSchema.optional().describe('Working conventions'),
        color: z.string().nullable().optional().describe('Accent color (null clears it)'),
        icon: z.string().nullable().optional().describe('Icon name (null clears it)'),
        soulContent: z.string().max(4000).optional().describe('Full SOUL.md content'),
        nopeContent: z.string().max(2000).optional().describe('Full NOPE.md content'),
      }),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'update_agent',
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: true },
        },
      },
      invoke: async (deps, input) =>
        unwrapMcpEnvelope(
          await createUpdateAgentHandler(requireOperatorDeps(deps))(input as UpdateAgentArgs)
        ),
    }),
    defineCapability({
      id: 'operator.config_patch',
      title: 'Update configuration',
      description:
        'Update DorkOS user settings by deep-merging a partial config object (the same validated path as the ' +
        "settings UI). Use for status-bar/sidebar prefs, scheduler, logging, etc. This mutates the user's own " +
        'settings — only do it when the user has asked for the change. Arrays replace (not merge); invalid values are rejected. ' +
        'Some settings only a person can change, and a patch touching any of them is refused whole: login (auth), ' +
        'public exposure (tunnel), the MCP endpoint and its key, telemetry consent, credentials (providers, ' +
        'credentialRef, cloud), extensions, the runtime binary paths and the OpenCode provider and baseURL, and the ' +
        'directories DorkOS reads and writes (server.boundary, workspace.rootPath, relay.dataDir, ' +
        'agents.defaultDirectory, mesh.scanRoots). Ask the person to change those in Settings themselves.',
      tier: 'act',
      input: z.object({
        patch: z.record(z.string(), z.unknown()).describe(
          // Keep this example a field that actually exists. It has drifted twice
          // already: `ui.sidebar` never had a `collapsed` key, `ui.statusBar` is
          // a `pins` list rather than per-item booleans (DOR-452), and the
          // per-section collapse flags this used to name were retired by the
          // sidebar redesign. `ui.theme` is the least likely to move.
          'Partial config to deep-merge, e.g. { "ui": { "theme": "dark" } }'
        ),
      }),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'config_patch',
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: true },
        },
      },
      // The only operator capability that reads `context`, and it reads exactly
      // one field: which agent is asking, so a display name this patch sets
      // carries a receipt naming its author (DOR-1022). Nothing about the write
      // itself branches on it — an unresolved identity writes the same config
      // and simply cannot be named.
      invoke: async (_deps, input, context) =>
        unwrapMcpEnvelope(
          await createConfigPatchHandler(context.identity)(
            input as { patch?: Record<string, unknown> }
          )
        ),
    }),
  ],
};
