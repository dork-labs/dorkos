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
 * the five mutations (`operator.update_agent`,
 * `operator.update_agent_boundaries`, `operator.config_patch`,
 * `operator.sidebar_add_to_group`, `operator.sidebar_remove_from_group`) do not
 * — they require the local token on the login-off external `/mcp` surface.
 *
 * @module services/core/operator/operator-capabilities
 */
import { z } from 'zod';
import { ListActivityQuerySchema } from '@dorkos/shared/activity-schemas';
import { RecentSessionsQuerySchema } from '@dorkos/shared/schemas';
import { TraitsSchema } from '@dorkos/shared/mesh-schemas';
import { NOPE_MAX_CHARS, SOUL_MAX_CHARS } from '@dorkos/shared/convention-files';
import { CAPABILITY_TIERS } from '@dorkos/shared/capabilities';

import { defineCapability, type CapabilityDomain } from '../capabilities/index.js';
import type { CapabilityDeps } from '../capabilities/index.js';
import { unwrapMcpEnvelope } from '../capabilities/mcp-envelope.js';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import {
  createUpdateAgentHandler,
  createUpdateAgentBoundariesHandler,
  createActivityListHandler,
  createConfigGetHandler,
  createConfigPatchHandler,
  createCheckUpdateHandler,
  createAgentsRecentActivityHandler,
  createSidebarAddToGroupHandler,
  createSidebarRemoveFromGroupHandler,
  type UpdateAgentArgs,
  type UpdateAgentBoundariesArgs,
  type SidebarAddToGroupArgs,
  type SidebarRemoveFromGroupArgs,
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

/**
 * How a caller names one agent or one room (DOR-2055).
 *
 * **Deliberately not `SidebarItemRefSchema`**, which is the STORED shape. That
 * one carries an agent as its `projectPath`, and a model usually cannot get
 * hold of one: `AgentManifest` does not carry a path, so neither `mesh_list` nor
 * `mesh_inspect` returns it, and the one tool that does drops every agent with
 * no recent session. Accepting only the stored shape would make the capability
 * unusable for the agent somebody has just registered — which is the case it
 * exists for. So three identifiers are accepted here and every one of them is
 * resolved against the live roster, with the canonical ref stored; see
 * `sidebar-item-refs.ts` for why a reference is never stored as sent.
 *
 * Every field is optional so a reference naming nothing reaches the handler and
 * gets a sentence about what to send, rather than a raw Zod error from the
 * registry's own parse — the same trade, for the same reason, that
 * `update_agent_boundaries` documents on its empty-patch guard.
 */
const sidebarItemRefInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('agent'),
    path: z
      .string()
      .min(1)
      .optional()
      .describe("The agent's project directory, exactly as DorkOS registered it"),
    agentId: z.string().min(1).optional().describe("The agent's ULID"),
    name: z
      .string()
      .min(1)
      .optional()
      .describe("The agent's short name, or its display name (either, without regard to case)"),
  }),
  z.object({
    kind: z.literal('room'),
    roomId: z.string().min(1).optional().describe("The room's id"),
    name: z
      .string()
      .min(1)
      .optional()
      .describe("A channel's name, or a room's title (without regard to case)"),
  }),
]);

/**
 * Selector shared by the two capabilities that edit one sidebar section's
 * membership (DOR-2055).
 *
 * The field is `group` because that is what the schema, the config path and
 * every identifier in this repo call it; the prose a model reads says "sidebar
 * section", which is what a person calls it (AGENTS.md).
 *
 * `items` is NOT shared: the two verbs describe the same shape as opposite acts,
 * and one `.describe()` saying "to move" was being served verbatim to the verb
 * that takes things out.
 */
const sidebarGroupSelectorSchema = {
  group: z
    .string()
    .min(1)
    .describe(
      'The sidebar section to change: its id, or its name (matched without regard to case). ' +
        'An id always wins over a name.'
    ),
};

/**
 * The `items` field, worded for the verb it belongs to.
 *
 * @param what - What this verb does with them, as a phrase.
 * @returns The `items` schema for that verb.
 */
function sidebarItemsSchema(what: string) {
  return z
    .array(sidebarItemRefInputSchema)
    .min(1)
    .describe(
      `The agents and rooms to ${what}. An agent is {"kind":"agent"} plus ONE of name, agentId ` +
        'or path; a room is {"kind":"room"} plus roomId or name. Every one is looked up before ' +
        'anything is written, and a name DorkOS does not know refuses the whole call.'
    );
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
        'credentialRef), and the linked account label. In their place you get boolean *Configured flags ' +
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
        'traits, conventions, color, icon, and SOUL.md (soulContent) content. ' +
        'It also carries tierCeiling, the most an agent may ever do — you can LOWER your own, ' +
        'and only a person can raise one. ' +
        // The other tool is named as a searchable ENDING, never bare: this same
        // string is served to the external `/mcp` server, where a person's
        // harness chooses the prefix, so a bare name is uncallable on
        // claude-code and unreliable everywhere else (DOR-1292). The form is
        // enforced by `messaging/__tests__/context-tool-names.test.ts`.
        "NOPE.md (the agent's safety boundaries) is NOT edited here, and neither is the switch that " +
        'decides whether the agent is given it. Both live on the boundaries tool, whose name ends in ' +
        '`update_agent_boundaries`; it asks a person first. ' +
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
        // Spelled out rather than reusing `ConventionsSchema`, for two reasons
        // that both matter here (DOR-1698).
        //
        // 1. Every key of that schema carries a Zod `.default(true)`, so a parse
        //    of `{soul: false}` hands the handler all four flags and "did the
        //    caller name `nope`" becomes unanswerable — the guard below would
        //    have to refuse every conventions write or none.
        // 2. `nope` is `z.unknown()` so the guard sees it whatever it holds. A
        //    `z.boolean()` would turn `{nope: null}` into a ZodError about types
        //    that never mentions where the switch actually lives.
        conventions: z
          .object({
            soul: z.boolean().optional().describe('Whether SOUL.md is injected'),
            memory: z
              .boolean()
              .optional()
              .describe("Whether the agent's own MEMORY.md is injected"),
            dorkosKnowledge: z
              .boolean()
              .optional()
              .describe('Whether the DorkOS knowledge block is injected'),
            nope: z
              .unknown()
              .optional()
              .describe(
                'Refused here. Whether NOPE.md is injected is changed with the boundaries tool, ' +
                  'whose name ends in `update_agent_boundaries`; it asks a person first.'
              ),
          })
          .optional()
          .describe('Which convention files are injected'),
        color: z.string().nullable().optional().describe('Accent color (null clears it)'),
        icon: z.string().nullable().optional().describe('Icon name (null clears it)'),
        // Says what DorkOS does with it, because the honest answer is not "we
        // store this". The personality block at the top of SOUL.md is rendered
        // from `traits` and fenced by markers the turn regenerates in place; a
        // file saved without them has no block to regenerate, so the six dials
        // stop reaching the agent entirely. The server composes the file around
        // that block either way (`agent-updater.ts`), and this sentence is what
        // keeps a caller from spending its budget reproducing a block it does
        // not own. Found by the `agent-self-edit` eval, 2026-09-12.
        soulContent: z
          .string()
          .max(SOUL_MAX_CHARS)
          .optional()
          .describe(
            'SOUL.md: who this agent is, in prose. Send the prose only — DorkOS keeps the ' +
              'personality block at the top of the file and writes it from `traits`. That block ' +
              `spends several hundred of the ${SOUL_MAX_CHARS.toLocaleString('en-US')}-character ` +
              'file budget, so your text has a few hundred less than that; a refusal names the ' +
              'exact number for this agent.'
          ),
        // Declared so an agent can TIGHTEN its own ceiling — and, just as much,
        // so an attempt to widen one is answered instead of dropped. `z.object`
        // strips what it does not declare, so leaving this out would let an
        // agent report a limit change that never happened (the DOR-1253 shape).
        // `.nullable()` for the same reason: clearing the limit is a real thing
        // to try, and it deserves the guard's sentence rather than a type error.
        // The direction guard lives in `agent-updater.ts` (DOR-486).
        tierCeiling: z
          .enum(CAPABILITY_TIERS)
          .nullable()
          .optional()
          .describe(
            "The most this agent may ever do: 'observe' reads only, 'act' changes things it can " +
              "undo, 'destructive' has no extra limit. You may LOWER your own ceiling; raising " +
              'one (or clearing it with null) is refused and has to be done by a person.'
          ),
        // Declared only so it can be REFUSED, and the declaration is what makes
        // the refusal possible: `registry.invoke` parses the input before the
        // handler runs, and `z.object` strips what it does not declare — so a
        // field simply deleted here would be dropped in silence, and an agent
        // that sent it would report a boundary edit that never happened
        // (the DOR-1253 shape, on the one file that says what it must not do).
        //
        // `z.unknown()` for the same reason `conventions.nope` is: the answer to
        // `{nopeContent: null}` has to be the pointer to the gated capability,
        // not a type error that never mentions it.
        nopeContent: z
          .unknown()
          .optional()
          .describe(
            'Refused here. Change NOPE.md with the boundaries tool, whose name ends in ' +
              '`update_agent_boundaries`; it asks a person first.'
          ),
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
    // NOPE.md gets its own capability because a tier is per-capability, not
    // per-field (DOR-1698). It rode `update_agent` at tier `act`, so an agent
    // could rewrite the file that is fed to its own runtime as
    // `safetyBoundaries` every turn, silently, on the sanctioned surface. The
    // operator's ruling was to gate it rather than refuse it outright: a
    // deliberate boundary edit is a real thing to want, and a person should see
    // it and grant it. Everything else `update_agent` writes stays at `act`.
    defineCapability({
      id: 'operator.update_agent_boundaries',
      title: "Change an agent's safety boundaries",
      description:
        "Change an agent's NOPE.md, the safety boundaries its runtime is given every turn as the " +
        'list of things it must not do. Two changes ride this one tool because they have the same ' +
        'effect: nopeContent replaces the whole file (not an append, so read what is there now and ' +
        'send the complete new text), and enabled: false stops the file being given to the agent at ' +
        'all while leaving it on disk. Send either or both. Target the agent by agent_id or cwd. ' +
        'A person approves every call, your own boundaries included, so say plainly what you want to ' +
        'change and why before you ask.',
      tier: 'destructive',
      input: z.object({
        ...agentSelectorSchema,
        nopeContent: z
          .string()
          .max(NOPE_MAX_CHARS)
          .optional()
          .describe('Full NOPE.md content, replacing whatever is there now'),
        // The mute, on the same gate as the rewrite because it is the STRONGER
        // of the two: the file survives, and the agent is simply never given it
        // (`runtimes/shared/agent-context.ts` skips the whole
        // `<agent_safety_boundaries>` block on `conventions.nope !== true`).
        // Leaving it on `update_agent` at tier `act` would have left a quieter
        // door to the same outcome, which is the defect this split exists to
        // close (DOR-1698).
        enabled: z
          .boolean()
          .optional()
          .describe(
            'Whether the agent is given NOPE.md at all. false mutes the boundaries without ' +
              'deleting them; true puts them back.'
          ),
      }),
      output: z.unknown(),
      // The selector and the mute go on the card's SENTENCE; the boundary text
      // itself goes in `approvalDetailField` below, because a card sentence caps
      // every value at 80 characters and the whole point of this approval is
      // reading the text.
      approvalDisplayFields: ['enabled', 'agent_id', 'cwd'],
      // The one field a person has to read in full before answering. Review
      // reproduced the attack this closes: 2000 characters of NOPE.md whose
      // first 80 are the current boundaries verbatim, with the part that undoes
      // them past the clamp. The operator approved text they could not see.
      approvalDetailField: 'nopeContent',
      surfaces: {
        mcp: {
          toolName: 'update_agent_boundaries',
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: true },
        },
      },
      invoke: async (deps, input) =>
        unwrapMcpEnvelope(
          await createUpdateAgentBoundariesHandler(requireOperatorDeps(deps))(
            input as UpdateAgentBoundariesArgs
          )
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
        // Not `z.record()`: a record anywhere in an in-session tool's schema
        // crashes the whole `tools/list` answer on claude-agent-sdk 0.3.257+ with
        // zod 4.5.3+, and the model is handed no DorkOS tools at all. `catchall`
        // accepts the same values. Full story in
        // `runtimes/claude-code/mcp-tools/tool-exposure.ts`.
        patch: z.object({}).catchall(z.unknown()).describe(
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
    // The two sidebar capabilities are `act` and live beside `config_patch`
    // rather than inside it, because the problem is the SHAPE of the write and
    // not the permission to make it (DOR-2055). `ui.sidebar.groups` is an array,
    // every general-purpose config write replaces an array wholesale, and so the
    // only way to add one agent to one section through the settings door is to
    // re-send every section. That is a read-modify-write across a turn boundary
    // with a model holding the copy: a drag the person makes in between is
    // overwritten with no error anywhere, and one mistyped section deletes all
    // the others. Reproduced on the operator's own install on 2026-09-15.
    //
    // Both write through the same guarded step `config_patch` does, so the
    // person-only policy, the audit line and the schema validation are the same
    // ones. What they do NOT have is a caller-supplied path: the patch is built
    // in the handler from a config read at call time, so it can never carry a
    // setting other than `ui.sidebar`.
    defineCapability({
      id: 'operator.sidebar_add_to_group',
      title: 'Add to a sidebar section',
      description:
        'Put agents and rooms into ONE section of the sidebar. Name the section in `group` by ' +
        'its id or its name, and list what to file there in `items` — an agent by its name, its ' +
        'id or its directory, a room by its id or its name. Everything is looked up before ' +
        'anything is written, so a name DorkOS does not know refuses the whole call and tells ' +
        'you which agents it does have. You can only file rooms you can see: a room you are ' +
        'not in answers exactly like a room that does not exist, so do not read a refusal as ' +
        'evidence either way. An item lives in one ' +
        'section at a time, so this MOVES it if it is already in another section: the section ' +
        'it came out of is named in `movedFrom`, and no other section is touched. Anything ' +
        'already in the section you named is left alone, so calling twice adds nothing twice. ' +
        'Set createIfMissing to true to make the section when nothing ' +
        'answers to the name you sent; without it you get a refusal that names the sections ' +
        'that do exist. Prefer this over sending `ui.sidebar.groups` to the settings tool whose ' +
        // Named as a searchable ENDING, never bare: this same string is served to
        // the external `/mcp` server, where a person's harness chooses the
        // prefix, so a bare name is uncallable on claude-code and unreliable
        // everywhere else (DOR-1292). Enforced by
        // `messaging/__tests__/context-tool-names.test.ts`.
        'name ends in `config_patch` — that array replaces wholesale, so a copy taken a moment ' +
        'ago silently drops whatever the person changed since. To take something out again, use ' +
        'the tool whose name ends in `sidebar_remove_from_group`. This rearranges the ' +
        "user's own sidebar, so only do it when they have asked for it.",
      tier: 'act',
      input: z.object({
        ...sidebarGroupSelectorSchema,
        items: sidebarItemsSchema('file there'),
        createIfMissing: z
          .boolean()
          .optional()
          .describe(
            'Make a new hand-sorted section with this name when no section answers to `group`. ' +
              'Ignored when one does.'
          ),
      }),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'sidebar_add_to_group',
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: true },
        },
      },
      invoke: async (deps, input, context) =>
        unwrapMcpEnvelope(
          await createSidebarAddToGroupHandler(
            requireOperatorDeps(deps),
            context
          )(input as SidebarAddToGroupArgs)
        ),
    }),
    defineCapability({
      id: 'operator.sidebar_remove_from_group',
      title: 'Remove from a sidebar section',
      description:
        'Take agents and rooms out of ONE section of the sidebar, leaving every other section ' +
        'exactly as it is. Name the section in `group` by its id or its name, and list what to ' +
        'take out in `items` — an agent by its name, its id or its directory, a room by its id ' +
        'or its name, looked up the same way the filing verb looks them up — including that you ' +
        'can only name rooms you can see. Anything that was ' +
        'not in that section is reported back and ' +
        'nothing else happens to it. Taking the last member out leaves the section there and ' +
        'empty; only a person removes a section. To file something instead, use the tool whose ' +
        "name ends in `sidebar_add_to_group`. This rearranges the user's own sidebar, so only " +
        'do it when they have asked for it.',
      tier: 'act',
      input: z.object({
        ...sidebarGroupSelectorSchema,
        items: sidebarItemsSchema('take out'),
      }),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'sidebar_remove_from_group',
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: true },
        },
      },
      invoke: async (deps, input, context) =>
        unwrapMcpEnvelope(
          await createSidebarRemoveFromGroupHandler(
            requireOperatorDeps(deps),
            context
          )(input as SidebarRemoveFromGroupArgs)
        ),
    }),
  ],
};
