/**
 * Zod schemas for the Mesh agent discovery and registry.
 *
 * Defines schemas for agent manifests, discovery candidates, hints,
 * and denial records. All schemas include `.openapi()` metadata
 * for OpenAPI generation.
 *
 * @module shared/mesh-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { AGENT_NAME_REGEX } from './validation.js';
import { EFFORT_LEVELS } from './constants.js';
import { SOUL_MAX_CHARS, NOPE_MAX_CHARS } from './convention-files.js';

extendZodWithOpenApi(z);

// === Enums ===

/**
 * The known agent harnesses. This enum serves a DUAL purpose — do not fork it:
 *
 * - **Discovery** (`detectedRuntime`): which harness created an agent directory
 *   on disk (e.g. a `.cursor/` folder marks a `cursor` agent). Most values here
 *   exist only for this use.
 * - **Execution**: which backend DorkOS runs the agent with. Only the values
 *   that have a registered `AgentRuntime` implementation ('claude-code',
 *   'codex', 'opencode') are valid execution runtimes.
 */
export const AgentRuntimeSchema = z
  .enum([
    'claude-code',
    'cursor',
    'codex',
    'opencode',
    'windsurf',
    'gemini',
    'cline',
    'roo-code',
    'copilot',
    'amazon-q',
    'continue',
    'augment',
    'jetbrains-ai',
    'kilo-code',
    'trae',
    'other',
  ])
  .openapi('AgentRuntime');

export type AgentRuntime = z.infer<typeof AgentRuntimeSchema>;

/** Health status enum — computed from last_seen_at timestamp, or explicitly set to 'unreachable'. */
export const AgentHealthStatusSchema = z
  .enum(['active', 'inactive', 'stale', 'unreachable'])
  .openapi('AgentHealthStatus');

export type AgentHealthStatus = z.infer<typeof AgentHealthStatusSchema>;

// === Agent Configuration ===

/**
 * When an agent answers without being asked directly.
 *
 * The single declaration of this enum. It reaches a second scope in
 * `room-schemas.ts`, where a room membership carries a per-room override and
 * this manifest value is only the default (ADR 260726-170125) — that module
 * imports this schema rather than re-declaring the values, so the two scopes
 * can never drift.
 *
 * Deliberately unnamed for OpenAPI: it stays inlined into
 * {@link AgentBehaviorSchema}'s generated component so extracting it changed no
 * byte of `docs/api/openapi.json`.
 *
 * The five values are the four turn-allocation rules of Sacks/Schegloff/Jefferson
 * 1974 plus "no participation", which is why there is no sixth:
 *
 * - `always` — rule 1(b), self-selection. Answers everything, and in a room with
 *   a participant that cannot lose the race for the floor that is dominance by
 *   construction rather than by accident.
 * - `engaged` — rule 1(c), the current speaker may continue, and the rules
 *   re-apply at each transition-relevance place. Answers when addressed, and for
 *   a bounded window afterwards; the window is a derived predicate over the room
 *   log (`services/rooms/engagement.ts`), never stored state.
 * - `direct-only` — `mention-only` plus "a direct message addresses everyone in
 *   it". A room-kind rule rather than a turn-allocation one.
 * - `mention-only` — rule 1(a), the current speaker selects the next.
 * - `silent` — no participation. A true off switch: the agent never runs.
 */
export const ResponseModeSchema = z.enum([
  'always',
  'engaged',
  'direct-only',
  'mention-only',
  'silent',
]);

export type ResponseMode = z.infer<typeof ResponseModeSchema>;

export const AgentBehaviorSchema = z
  .object({
    responseMode: ResponseModeSchema.default('always'),
    escalationThreshold: z.number().optional(),
  })
  .openapi('AgentBehavior');

export type AgentBehavior = z.infer<typeof AgentBehaviorSchema>;

// === Agent Tool Groups ===

/**
 * Per-domain MCP tool group overrides for an individual agent.
 *
 * `undefined` means "inherit global default". Explicit `true`/`false` overrides the global setting.
 *
 * Turning a group off leaves its tool block out of the agent's context, so the agent
 * is never told those tools exist. It does not remove them: the tools stay registered
 * on the session and an agent that names one anyway still gets the normal approval
 * prompt. This steers an agent rather than restricting it (DOR-519).
 *
 * Implicit grouping rules:
 * - `adapter: false` also turns off the chat-route tools
 * - `relay: false` also turns off the trace tools
 * - The core tools are never gated
 *
 * Which tools each of those covers is declared in `mcp-tool-groups.ts` and read
 * from there by both the server and the cockpit. It is deliberately not listed
 * again here: the copies of it that used to live in three other files all drifted
 * (DOR-499). Call `toolNamesForDomain` for the current answer.
 */
export const EnabledToolGroupsSchema = z
  .object({
    tasks: z.boolean().optional(),
    relay: z.boolean().optional(),
    mesh: z.boolean().optional(),
    adapter: z.boolean().optional(),
  })
  .default({})
  .openapi('EnabledToolGroups', {
    description:
      'Per-domain tool groups. undefined = inherit global default. Off means the agent ' +
      'is not told about the group, not that the tools are blocked. ' +
      'Binding tools follow adapter toggle. Trace tools follow relay toggle.',
  });

export type EnabledToolGroups = z.infer<typeof EnabledToolGroupsSchema>;

// === Managed MCP Servers ===

/**
 * Connection details for a managed MCP server, as a discriminated union over
 * `transport`. This is the on-manifest mirror of the runtime-neutral
 * `McpAppServerConnection` shape (`agent-runtime.ts`) — same three transports
 * (`stdio`/`http`/`sse`), same field names — so the claude-code adapter's
 * `toSdkMcpServerConfig` can convert an enabled entry directly, with no
 * remapping. `args`/`env`/`headers` default to empty so a converted entry is
 * always fully populated. **Server-only in practice**: a stdio `command`/`env`
 * must never reach the browser client (see `McpAppServerConnection`).
 */
/**
 * How a remote (http/sse) managed server authenticates. `'oauth2'` marks a
 * server whose tokens DorkOS obtains and refreshes for the operator (the
 * managed-MCP OAuth flow, DOR-938): the access token is injected as an
 * `Authorization: Bearer` header at session-injection time and never written to
 * the manifest. Absent means the server needs no DorkOS-held token (either open,
 * or authenticated by a static header the operator already set). Non-secret — it
 * is only a hint that a sign-in is expected, so it is safe on disk and on the
 * wire; the token itself lives in the encrypted `mcp-oauth` store.
 */
export const McpServerAuthKindSchema = z.literal('oauth2');

export type McpServerAuthKind = z.infer<typeof McpServerAuthKindSchema>;

export const McpServerTransportSchema = z.discriminatedUnion('transport', [
  z.object({
    transport: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
  }),
  z.object({
    transport: z.literal('http'),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).default({}),
    authKind: McpServerAuthKindSchema.optional(),
  }),
  z.object({
    transport: z.literal('sse'),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).default({}),
    authKind: McpServerAuthKindSchema.optional(),
  }),
]);

export type McpServerTransport = z.infer<typeof McpServerTransportSchema>;

/**
 * One DorkOS-managed MCP server declared on an agent's manifest.
 *
 * Introducing a server is a capability grant — a stdio entry runs an arbitrary
 * command in the agent's environment — so the security model (ADR 260803-233420)
 * anchors on two safe defaults here: `enabled` defaults to `false` (absence
 * withholds; injection fires only for `enabled === true`) and there is no
 * `.catch()` on the surrounding array, so a malformed entry fails the whole
 * manifest parse loudly rather than degrading a security-relevant list to `[]`.
 * `addedBy` records who approved it for audit.
 */
export const ManagedMcpServerSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9_-]+$/, 'Must be alphanumeric with dashes/underscores'),
    enabled: z.boolean().default(false),
    connection: McpServerTransportSchema,
    addedAt: z.string().datetime(),
    addedBy: z.string().min(1),
  })
  .openapi('ManagedMcpServer');

export type ManagedMcpServer = z.infer<typeof ManagedMcpServerSchema>;

/**
 * Whether a remote managed server currently has a usable DorkOS-held sign-in.
 *
 * `'connected'` means a live access token exists right now; `'needs-auth'` means
 * the server is known to want an OAuth sign-in and none is held. Absent means
 * DorkOS has no opinion (a local stdio server, or a remote one that has never
 * shown it wants a sign-in).
 */
export const McpServerAuthStatusSchema = z.enum(['connected', 'needs-auth']);

/** See {@link McpServerAuthStatusSchema}. */
export type McpServerAuthStatus = z.infer<typeof McpServerAuthStatusSchema>;

/**
 * Where the OAuth client identity DorkOS signs in with came from (DOR-982).
 *
 * `'dcr'` — DorkOS registered itself with the provider automatically (RFC 7591
 * dynamic client registration), which is what happens for most servers.
 * `'manual'` — the operator pasted app credentials they got from the provider,
 * because that provider does not allow automatic registration.
 *
 * It is reported so a card can say WHICH of the two is in play; it changes
 * nothing about how the sign-in itself works.
 */
export const McpClientOriginSchema = z.enum(['dcr', 'manual']);

/** See {@link McpClientOriginSchema}. */
export type McpClientOrigin = z.infer<typeof McpClientOriginSchema>;

/**
 * A managed server as the LISTING reports it: the stored entry plus
 * {@link McpServerAuthStatusSchema}, derived per request from the live token
 * cache and the entry's `authKind` hint.
 *
 * `authStatus` is response-layer decoration and is deliberately absent from
 * {@link ManagedMcpServerSchema}: it describes a moment (is a token live?), not
 * configuration, so it is never written to `.dork/agent.json`. It exists so a
 * freshly-started server can tell an operator that a server needs signing in
 * without waiting for an agent turn to populate the runtime's status cache.
 *
 * `authClientOrigin` is decoration for the same reason: it is read from the
 * encrypted OAuth store, never from the manifest, and it names only WHICH client
 * identity DorkOS holds — never the credential itself.
 */
export const ManagedMcpServerViewSchema = ManagedMcpServerSchema.extend({
  authStatus: McpServerAuthStatusSchema.optional(),
  authClientOrigin: McpClientOriginSchema.optional(),
}).openapi('ManagedMcpServerView');

/** See {@link ManagedMcpServerViewSchema}. */
export type ManagedMcpServerView = z.infer<typeof ManagedMcpServerViewSchema>;

// === Agent Personality ===

/** Personality trait levels (1-5 scale, default 3 = Balanced) */
export const TraitsSchema = z
  .object({
    verbosity: z.number().int().min(1).max(5).default(3),
    autonomy: z.number().int().min(1).max(5).default(3),
    chaos: z.number().int().min(1).max(5).default(3),
    creativity: z.number().int().min(1).max(5).default(3),
    humor: z.number().int().min(1).max(5).default(3),
    spice: z.number().int().min(1).max(5).default(3),
  })
  .openapi('Traits');

export type Traits = z.infer<typeof TraitsSchema>;

/** Convention file injection toggles */
export const ConventionsSchema = z
  .object({
    soul: z.boolean().default(true),
    nope: z.boolean().default(true),
    dorkosKnowledge: z.boolean().default(true),
  })
  .openapi('Conventions');

export type Conventions = z.infer<typeof ConventionsSchema>;

// === Agent Manifest ===

/**
 * The model this agent's new sessions start on, or absent to inherit the
 * server's default for whichever runtime it uses.
 *
 * Read inside the agent's own `runtime` — a model id only means something to the
 * runtime that offers it (`opus` to Claude Code, `gpt-5.3-codex` to Codex,
 * `provider/model` to OpenCode), which is why the server's defaults are
 * per-runtime and an agent's is not: the agent already names its runtime.
 *
 * **Deliberately unvalidated against any catalog.** Catalogs are remote and move
 * under us, and an agent can be edited while its runtime is disconnected. A value
 * the runtime cannot honor is accepted at write and surfaced afterwards as a
 * warning (design `execution-defaults` §3.4) — never a refused save, which would
 * make a settings screen fail for reasons a person cannot see or fix.
 */
const AgentModelSchema = z.string().min(1).optional().openapi({
  description:
    "Model new sessions for this agent start on, in its own runtime's id space. Absent = inherit the server default.",
  example: 'opus',
});

/**
 * The reasoning effort this agent's new sessions start at, or absent to inherit
 * the server's per-runtime default.
 *
 * The shared {@link EFFORT_LEVELS} ladder, never a per-runtime fork. An effort
 * set on an agent whose runtime or model cannot honor it (OpenCode accepts no
 * effort at all) is kept and reported, on the same accepted-at-write rule as
 * {@link AgentModelSchema}.
 */
const AgentEffortSchema = z.enum(EFFORT_LEVELS).optional().openapi({
  description:
    'Reasoning effort new sessions for this agent start at. Absent = inherit the server default.',
  example: 'high',
});

export const AgentManifestSchema = z
  .object({
    id: z.string().min(1).describe('ULID assigned at registration'),
    name: z.string().min(1),
    displayName: z.string().max(100).optional().openapi({
      description: 'Human-readable display name. Falls back to name (slug) when absent.',
      example: 'My Cool Agent',
    }),
    description: z.string().default(''),
    runtime: AgentRuntimeSchema,
    capabilities: z.array(z.string()).default([]),
    behavior: AgentBehaviorSchema.default({ responseMode: 'always' }),
    namespace: z.string().max(64).optional(),
    registeredAt: z.string().datetime(),
    registeredBy: z.string().min(1),
    persona: z.string().max(4000).optional().openapi({
      description: 'System prompt persona text injected into Claude sessions',
      example: 'You are backend-bot, an expert in REST API design...',
    }),
    personaEnabled: z.boolean().default(true).openapi({
      description: 'Whether persona text is injected into system prompt',
    }),
    traits: TraitsSchema.optional(),
    conventions: ConventionsSchema.optional(),
    color: z.string().optional().openapi({
      description: 'CSS color override for visual identity (e.g., "#6366f1")',
      example: '#6366f1',
    }),
    icon: z.string().optional().openapi({
      description: 'Emoji override for visual identity',
      example: '🤖',
    }),
    isSystem: z.boolean().default(false).optional().openapi({
      description: 'System agents are auto-managed and cannot be deleted',
    }),
    // The `.openapi(...)` metadata is repeated on the OUTSIDE of `.catch()` and
    // that is load-bearing, not duplication: the generator cannot see through a
    // `ZodCatch` and throws "Unknown zod object type" for the whole document,
    // which takes `/api/docs` and every consumer of `openapi.json` with it.
    //
    // `.catch(undefined)` on the manifest copies ONLY: a hand-edited
    // `agent.json` with `"effort": "ludicrous"` degrades that one field to
    // "inherit" instead of failing the whole parse, which would make
    // `readManifest` return null and the agent vanish from the fleet over a
    // typo in a setting. The write surfaces below stay strict — an API caller
    // sending a bad rung is told so, because there is somebody there to tell.
    // Same reasoning as the stored-effort parse in `agent-registry.ts`.
    model: AgentModelSchema.catch(undefined).openapi({
      type: 'string',
      description:
        "Model new sessions for this agent start on, in its own runtime's id space. Absent = inherit the server default.",
      example: 'opus',
    }),
    effort: AgentEffortSchema.catch(undefined).openapi({
      type: 'string',
      enum: [...EFFORT_LEVELS],
      description:
        'Reasoning effort new sessions for this agent start at. Absent = inherit the server default.',
      example: 'high',
    }),
    enabledToolGroups: EnabledToolGroupsSchema,
    // DorkOS-managed MCP servers for this agent. Deliberately NOT `.catch([])`
    // (unlike `model`/`effort` above): a malformed entry must fail the manifest
    // parse loudly rather than silently degrade a security-relevant list to
    // empty — a dropped server is invisible, a failed parse is not. Defaults to
    // `[]` (absence withholds); each entry's `enabled` defaults to `false`.
    // Mutated only through the gated `mcp.*` capabilities, never the agent
    // PATCH surface — which is why it is absent from `AgentManifestUpdate`.
    mcpServers: z.array(ManagedMcpServerSchema).default([]),
  })
  .openapi('AgentManifest');

export type AgentManifest = z.infer<typeof AgentManifestSchema>;

/**
 * What a manifest PATCH may carry.
 *
 * Every manifest field is optional, and `model`/`effort` additionally accept
 * `null` — which is not "unset the field" in the vague sense but a named
 * outcome: go back to inheriting the server's default. `undefined` cannot say
 * that, because JSON strips it, so the wire needs a value for the absence and
 * `null` is it ({@link UpdateAgentRequestSchema} accepts exactly this). Typed
 * here rather than at each caller so the chip's one action — "use server
 * default" — is expressible without a cast.
 */
// `mcpServers` is deliberately excluded: managed MCP servers are mutated ONLY
// through the gated `mcp.*` capabilities (add/update are destructive, with a
// command-diff approval), never a blanket manifest PATCH. The runtime gate is
// `UpdateAgentRequestSchema`'s `.pick()` allowlist, which omits it; the type
// must say the same so a future caller cannot trust it as a legal write path
// (ADR 260803-233420, guarantee 2).
export type AgentManifestUpdate = Omit<
  Partial<AgentManifest>,
  'model' | 'effort' | 'mcpServers'
> & {
  model?: string | null;
  effort?: (typeof EFFORT_LEVELS)[number] | null;
};

// === Lightweight Path Entry ===

/** Minimal agent data with projectPath for onboarding/scheduling. */
export const AgentPathEntrySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    displayName: z.string().optional(),
    projectPath: z.string(),
    icon: z.string().optional(),
    color: z.string().optional(),
  })
  .openapi('AgentPathEntry');

export type AgentPathEntry = z.infer<typeof AgentPathEntrySchema>;

// === Discovery ===

export const AgentHintsSchema = z
  .object({
    suggestedName: z.string(),
    detectedRuntime: AgentRuntimeSchema,
    inferredCapabilities: z.array(z.string()).optional(),
    description: z.string().optional(),
  })
  .openapi('AgentHints');

export type AgentHints = z.infer<typeof AgentHintsSchema>;

export const DiscoveryCandidateSchema = z
  .object({
    path: z.string().min(1),
    strategy: z.string().min(1),
    hints: AgentHintsSchema,
    discoveredAt: z.string().datetime(),
  })
  .openapi('DiscoveryCandidate');

export type DiscoveryCandidate = z.infer<typeof DiscoveryCandidateSchema>;

// === Denial ===

export const DenialRecordSchema = z
  .object({
    path: z.string().min(1),
    reason: z.string().optional(),
    deniedBy: z.string().min(1),
    deniedAt: z.string().datetime(),
  })
  .openapi('DenialRecord');

export type DenialRecord = z.infer<typeof DenialRecordSchema>;

// === Topology ===

/** Agent manifest enriched with runtime health and relay context for topology views. */
export const TopologyAgentSchema = AgentManifestSchema.extend({
  projectPath: z.string().optional(),
  healthStatus: AgentHealthStatusSchema.default('stale'),
  relayAdapters: z.array(z.string()).default([]),
  relaySubject: z.string().nullable().default(null),
  taskCount: z.number().int().default(0),
  lastSeenAt: z.string().nullable().default(null),
  lastSeenEvent: z.string().nullable().default(null),
}).openapi('TopologyAgent');

export type TopologyAgent = z.infer<typeof TopologyAgentSchema>;

export const NamespaceInfoSchema = z
  .object({
    namespace: z.string(),
    agentCount: z.number().int(),
    agents: z.array(TopologyAgentSchema),
  })
  .openapi('NamespaceInfo');

export type NamespaceInfo = z.infer<typeof NamespaceInfoSchema>;

/**
 * The wildcard namespace. On BOTH sides of a cross-namespace access rule it is
 * the mesh-wide "Let all my agents talk to each other" switch; as a rule's
 * `targetNamespace` alone it is also the sentinel the bridge-written catch-all
 * deny uses for "every namespace". A user-writable rule may never use it on one
 * side only — see {@link UpdateAccessRuleRequestSchema}.
 */
export const OPEN_MESH_NAMESPACE = '*';

export const CrossNamespaceRuleSchema = z
  .object({
    sourceNamespace: z.string(),
    targetNamespace: z.string(),
    action: z.enum(['allow', 'deny']),
    /**
     * Where the rule came from: a user-configured grant via `PUT /topology/access`
     * ('explicit'), or a rule the Relay bridge writes automatically for every
     * namespace with a registered agent ('default' — same-namespace allow, and a
     * catch-all cross-namespace deny using the `targetNamespace: '*'` sentinel).
     * Defaults appear so the topology view reflects the rules actually enforced,
     * not just the ones a user added on top of them.
     *
     * One explicit rule uses `'*'` on BOTH sides: the mesh-wide switch (see
     * {@link TopologyViewSchema}'s `openMesh`).
     */
    origin: z.enum(['default', 'explicit']).default('explicit'),
  })
  .openapi('CrossNamespaceRule');

export type CrossNamespaceRule = z.infer<typeof CrossNamespaceRuleSchema>;

export const TopologyViewSchema = z
  .object({
    callerNamespace: z.string(),
    namespaces: z.array(NamespaceInfoSchema),
    accessRules: z.array(CrossNamespaceRuleSchema),
    /**
     * Whether the mesh-wide `* -> *` allow rule is on — the "Let all my agents
     * talk to each other" switch. True means every agent may message every
     * other agent on this machine regardless of namespace; false means the
     * default applies (same namespace allowed, cross-namespace denied unless a
     * pair rule allows it).
     */
    openMesh: z.boolean().default(false),
  })
  .openapi('TopologyView');

export type TopologyView = z.infer<typeof TopologyViewSchema>;

// === HTTP Request/Response Schemas ===

/** Request body for POST /api/mesh/discover */
export const DiscoverRequestSchema = z
  .object({
    roots: z.array(z.string().min(1)).min(1),
    maxDepth: z.number().int().min(1).optional(),
  })
  .openapi('DiscoverRequest');

export type DiscoverRequest = z.infer<typeof DiscoverRequestSchema>;

/** Request body for POST /api/mesh/agents */
export const RegisterAgentRequestSchema = z
  .object({
    path: z.string().min(1),
    overrides: AgentManifestSchema.partial().optional(),
    approver: z.string().optional(),
    /**
     * Scan root the agent was discovered under. Its first path segment relative
     * to this root becomes the agent's namespace (ADR-0032). Must be an ancestor
     * of `path` and inside the server boundary — validated server-side. When
     * omitted, the server falls back to its default scan root (homedir), so the
     * namespace collapses to the first directory under `$HOME`.
     *
     * Ignored for an agent under the managed agents home dir
     * (`{dorkHome}/agents`): those always take their namespace from that
     * directory, so it stays the same when the reconciler next walks it
     * (DOR-1342).
     */
    scanRoot: z.string().min(1).optional(),
  })
  .openapi('RegisterAgentRequest');

export type RegisterAgentRequest = z.infer<typeof RegisterAgentRequestSchema>;

/** Request body for POST /api/mesh/deny */
export const DenyRequestSchema = z
  .object({
    path: z.string().min(1),
    reason: z.string().optional(),
    denier: z.string().optional(),
  })
  .openapi('DenyRequest');

export type DenyRequest = z.infer<typeof DenyRequestSchema>;

/** Request body for PATCH /api/mesh/agents/:id — derived from AgentManifestSchema for single source of truth. */
export const UpdateAgentRequestSchema = AgentManifestSchema.pick({
  name: true,
  displayName: true,
  description: true,
  runtime: true,
  capabilities: true,
  behavior: true,
  namespace: true,
  persona: true,
  personaEnabled: true,
  traits: true,
  conventions: true,
  color: true,
  icon: true,
  model: true,
  effort: true,
  enabledToolGroups: true,
})
  .partial()
  .extend({
    // Null signals "clear this field" — needed because undefined is stripped from JSON
    color: z.string().nullable().optional(),
    icon: z.string().nullable().optional(),
    // For model and effort, "clear" has a name: go back to inheriting the
    // server's default. That is what the chip's one action does (design §3.1),
    // so the wire needs a way to say it — `null`, on the same convention.
    model: z.string().min(1).nullable().optional(),
    effort: z.enum(EFFORT_LEVELS).nullable().optional(),
  })
  .openapi('UpdateAgentRequest');

export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;

/**
 * Request body for PATCH /api/mesh/agents/:id/conventions — update convention
 * file content and personality toggles.
 *
 * The budgets are {@link SOUL_MAX_CHARS} and {@link NOPE_MAX_CHARS} rather than
 * literals, because this schema is what ENFORCES them and three other places
 * describe them: the editor's counter, the Save gate, and the sentence the
 * server refuses with. A literal here let those drift from the rule.
 */
export const UpdateAgentConventionsSchema = z
  .object({
    soulContent: z.string().max(SOUL_MAX_CHARS).optional(),
    nopeContent: z.string().max(NOPE_MAX_CHARS).optional(),
    traits: TraitsSchema.optional(),
    conventions: ConventionsSchema.optional(),
  })
  .openapi('UpdateAgentConventions');

export type UpdateAgentConventions = z.infer<typeof UpdateAgentConventionsSchema>;

/** Message for a rule with the `'*'` wildcard on only one side. */
export const WILDCARD_NAMESPACE_BOTH_SIDES_MESSAGE =
  'Use "*" on both sides (the mesh-wide switch) or on neither (a namespace pair).';

/**
 * Request body for PUT /api/mesh/topology/access.
 *
 * `'*'` on BOTH sides is the mesh-wide "Let all my agents talk to each other"
 * switch (`allow` turns it on, `deny` turns it off). Any other pair is a
 * directional grant between two concrete namespaces. A wildcard on one side
 * only is rejected — it would open far more traffic than the caller asked for.
 */
export const UpdateAccessRuleRequestSchema = z
  .object({
    sourceNamespace: z.string().min(1),
    targetNamespace: z.string().min(1),
    action: z.enum(['allow', 'deny']),
  })
  .refine(
    (r) =>
      (r.sourceNamespace === OPEN_MESH_NAMESPACE) === (r.targetNamespace === OPEN_MESH_NAMESPACE),
    {
      message: WILDCARD_NAMESPACE_BOTH_SIDES_MESSAGE,
      path: ['targetNamespace'],
    }
  )
  .openapi('UpdateAccessRuleRequest');

export type UpdateAccessRuleRequest = z.infer<typeof UpdateAccessRuleRequestSchema>;

/** Request body for POST /api/mesh/agents/resolve */
export const ResolveAgentsRequestSchema = z
  .object({
    paths: z.array(z.string().min(1)).min(1).max(100),
  })
  .openapi('ResolveAgentsRequest');

export type ResolveAgentsRequest = z.infer<typeof ResolveAgentsRequestSchema>;

/** Response body for POST /api/mesh/agents/resolve */
export const ResolveAgentsResponseSchema = z
  .object({
    agents: z.record(z.string(), AgentManifestSchema.nullable()),
  })
  .openapi('ResolveAgentsResponse');

export type ResolveAgentsResponse = z.infer<typeof ResolveAgentsResponseSchema>;

/** Options for programmatic agent creation — used by CLI, client, and server creation pipeline. */
export const CreateAgentOptionsSchema = z
  .object({
    name: z.string().regex(AGENT_NAME_REGEX, 'Kebab-case required'),
    displayName: z.string().max(100).optional(),
    directory: z.string().optional(),
    template: z.string().optional(),
    description: z.string().optional(),
    runtime: AgentRuntimeSchema.optional(),
    /**
     * Seed prose written into the agent's `SOUL.md` at creation (its custom
     * section, below the auto-generated traits — same convention the legacy
     * persona→SOUL.md migration uses). Bounded to match the manifest's persona
     * limit (`SOUL_MAX_CHARS`, 4000). Omitted → the default SOUL template.
     */
    persona: z.string().max(4000).optional(),
    /**
     * Capability namespaces recorded on the agent manifest. Passed straight
     * through to `agent.json`; omitted → an empty list. Bounded to keep the
     * creation payload sane.
     */
    capabilities: z.array(z.string().min(1).max(200)).max(64).optional(),
    /**
     * Emoji face for the agent's visual identity, recorded on the manifest
     * `icon` field. A single emoji chosen in the naming step (M3), or seeded
     * from a template's icon. Omitted → no icon (UIs fall back to a
     * letter/color avatar).
     */
    icon: z.string().max(64).optional(),
    traits: TraitsSchema.optional(),
    conventions: ConventionsSchema.optional(),
    /**
     * Model and effort the agent's sessions start with, recorded on the manifest.
     * Omitted → the agent inherits the server's per-runtime defaults, which is
     * what every agent created before these fields existed keeps doing.
     */
    model: AgentModelSchema,
    effort: AgentEffortSchema,
    /**
     * Internal flag for the marketplace install pipeline. When true, the
     * agent-creator skips its own directory creation and template download
     * steps and treats `directory` as an existing, pre-populated workspace
     * that only needs the `.dork/agent.json` + SOUL.md + NOPE.md scaffold.
     * Not part of the public CLI/API surface — set only by the marketplace
     * install flow after copying a package onto disk.
     */
    skipTemplateDownload: z.boolean().optional(),
  })
  .openapi('CreateAgentOptions');

export type CreateAgentOptions = z.infer<typeof CreateAgentOptionsSchema>;

/** Request body for POST /api/mesh/agents/create */
export const CreateAgentRequestSchema = z
  .object({
    path: z.string().min(1),
    name: z.string().min(1).optional(),
    displayName: z.string().max(100).optional(),
    description: z.string().optional(),
    runtime: AgentRuntimeSchema.optional().default('claude-code'),
  })
  .openapi('CreateAgentRequest');

export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

/** Query params for GET /api/mesh/agents */
export const AgentListQuerySchema = z
  .object({
    runtime: AgentRuntimeSchema.optional(),
    capability: z.string().optional(),
    callerNamespace: z.string().optional(),
  })
  .openapi('AgentListQuery');

export type AgentListQuery = z.infer<typeof AgentListQuerySchema>;

// === Health & Observability Schemas ===

/** Agent health detail — extends manifest with health tracking fields. */
export const AgentHealthSchema = z
  .object({
    agentId: z.string(),
    name: z.string(),
    status: AgentHealthStatusSchema,
    lastSeenAt: z.string().nullable(),
    lastSeenEvent: z.string().nullable(),
    registeredAt: z.string(),
    runtime: AgentRuntimeSchema,
    capabilities: z.array(z.string()),
  })
  .openapi('AgentHealth');

export type AgentHealth = z.infer<typeof AgentHealthSchema>;

/** Aggregate mesh status — counts by health status plus groupings. */
export const MeshStatusSchema = z
  .object({
    totalAgents: z.number(),
    activeCount: z.number(),
    inactiveCount: z.number(),
    staleCount: z.number(),
    unreachableCount: z.number(),
    byRuntime: z.record(z.string(), z.number()),
    byProject: z.record(z.string(), z.number()),
  })
  .openapi('MeshStatus');

export type MeshStatus = z.infer<typeof MeshStatusSchema>;

/** Detailed agent inspection — full manifest + health + relay info. */
export const MeshInspectSchema = z
  .object({
    agent: AgentManifestSchema,
    health: AgentHealthSchema,
    relaySubject: z.string().nullable(),
  })
  .openapi('MeshInspect');

export type MeshInspect = z.infer<typeof MeshInspectSchema>;

/** Lifecycle event — emitted as Relay signals on registration, unregistration, health change. */
export const MeshLifecycleEventSchema = z
  .object({
    agentId: z.string(),
    agentName: z.string(),
    event: z.enum(['registered', 'unregistered', 'health_changed']),
    previousStatus: AgentHealthStatusSchema.optional(),
    currentStatus: AgentHealthStatusSchema.optional(),
    timestamp: z.string(),
  })
  .openapi('MeshLifecycleEvent');

export type MeshLifecycleEvent = z.infer<typeof MeshLifecycleEventSchema>;

/** Request body for POST /api/mesh/agents/:id/heartbeat */
export const HeartbeatRequestSchema = z
  .object({
    event: z.string().optional().default('heartbeat'),
  })
  .openapi('HeartbeatRequest');

export type HeartbeatRequest = z.infer<typeof HeartbeatRequestSchema>;

// === Transport-Level Discovery Types ===

/**
 * Progress counters emitted during a discovery scan.
 * Shared between the server-side scanner and transport-level events.
 */
export const ScanProgressSchema = z
  .object({
    scannedDirs: z.number().int().min(0),
    foundAgents: z.number().int().min(0),
  })
  .openapi('ScanProgress');

export type ScanProgress = z.infer<typeof ScanProgressSchema>;

/**
 * Lightweight representation of an agent that was auto-imported from an
 * existing `.dork/agent.json` during a discovery scan. Sent to the client
 * so the onboarding flow can show already-configured agents.
 */
export interface ExistingAgent {
  /** Absolute path to the agent's project directory. */
  path: string;
  /** Agent name from the manifest. */
  name: string;
  /** Agent runtime from the manifest. */
  runtime: AgentRuntime;
  /** Agent description from the manifest (may be empty). */
  description: string;
}

/**
 * Transport-level discovery scan event — discriminated union of all event types
 * surfaced to the client.
 */
export type TransportScanEvent =
  | { type: 'candidate'; data: DiscoveryCandidate }
  | { type: 'existing-agent'; data: ExistingAgent }
  | { type: 'progress'; data: ScanProgress }
  | { type: 'complete'; data: ScanProgress & { timedOut: boolean } }
  | { type: 'error'; data: { error: string } };

/** Options for a discovery scan request. */
export interface TransportScanOptions {
  /** Root directories to scan. Empty array defaults to boundary (home dir) on the server. */
  roots: string[];
  /** Maximum BFS depth (default: 5). */
  maxDepth?: number;
  /** Scan timeout in ms (default: 30000). */
  timeout?: number;
}
