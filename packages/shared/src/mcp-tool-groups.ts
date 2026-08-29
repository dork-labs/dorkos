/**
 * Which tool-group toggle covers each hand-registered DorkOS MCP tool, written
 * down once (DOR-499).
 *
 * ## What a toggle actually controls (read this first)
 *
 * A toggle controls what an agent is TOLD ABOUT, not what it can DO. Turning a
 * group off leaves every tool in it registered and callable; all it does is make
 * `buildSystemPromptAppend` leave that group's documentation out of the agent's
 * context, so the agent is not told those tools exist
 * (`runtimes/claude-code/messaging/context-builder.ts`). An agent that names one
 * of those tools anyway still reaches it.
 *
 * No entry in THIS TABLE is a hard filter, and "gates" in the names below means
 * "is described by", nothing stronger. Until DOR-519 this file said otherwise,
 * because ADR-0070 built the feature on the premise that the SDK's `allowedTools`
 * option restricted a session's tool set. It does not; it auto-approves. See
 * ADR-260726-171347 for the current position and ADR-0070 for the full history.
 *
 * **One key beside these four now does block, and it is not in this table.**
 * `EnabledToolGroups.roomsManage` (`mesh-schemas.ts`) is a per-agent grant the
 * server's capability choke point reads on every call, so a capability that
 * declares that group is refused without it. It is deliberately absent here for
 * the same reason every registry-generated tool is (see the "Adding a tool" note
 * below): the capability declares its own group, and restating it here would be a
 * second copy of the fact this table exists to remove.
 *
 * What stops an agent from doing something consequential is the permission tier
 * on the tool, enforced in `apps/server/src/services/core/mcp-tool-gate.ts` below
 * every caller (DOR-468). Nothing in this file is a security boundary, and no
 * edit here can make one.
 *
 * ## Why this table exists
 *
 * A person can turn four groups of DorkOS tools on or off per agent —
 * Scheduling, Messaging, Agent Discovery, External Integrations
 * (`EnabledToolGroups` in `mesh-schemas.ts`). Answering "which tools does that
 * toggle actually cover?" used to require three hand-copied lists that all
 * claimed to be the same fact:
 *
 * - the server's seven `*_TOOLS` arrays in
 *   `runtimes/claude-code/tooling/tool-filter.ts`, which built the per-session
 *   tool list (deleted in DOR-519 along with the `allowedTools` wiring they fed),
 * - `TOOL_INVENTORY` in the cockpit's Settings tab, which shows the count and
 *   the names behind each toggle,
 * - a second copy of `TOOL_INVENTORY` pasted into the per-agent Tools tab,
 *   because Feature-Sliced Design forbids one cockpit feature importing
 *   another's files.
 *
 * They drifted, in both directions. The cockpit listed six always-on tools
 * where the server had nine, and seven tools the server registers were in none
 * of the arrays at all. Nothing failed; the screen just described a different
 * tool set than the one an agent was told about.
 *
 * So the grouping is keyed by TOOL NAME and lives here, in the one package both
 * the server and the cockpit already depend on. Everything else is derived. This
 * is the same shape, for the same reason, as the permission-tier table next door
 * in the server (`services/core/mcp-tool-tiers.ts`): one fact per tool, in one
 * place, and no list allowed to restate it.
 *
 * ## Groups are finer than toggles, on purpose
 *
 * There are four toggles but eleven groups, because two different questions get
 * asked of this table and they need different resolution:
 *
 * - "What does turning off Messaging stop the agent being told about?" —
 *   answered by the toggle a group maps to in {@link TOOL_GATE_GROUP_DOMAIN}.
 *   Two groups follow a toggle that is not named after them: `trace` follows
 *   Messaging and `binding` follows External Integrations (ADR-0071). That implicit
 *   parenting is recorded once here rather than re-explained at each list.
 * - "What is always described, no matter what?" — answered by the groups that
 *   map to `null`. Those are kept apart (`core`, `ui`, `devtools`, `agents`,
 *   `extensions`) rather than merged into one `core` bucket, because the cockpit
 *   and the server want to name different slices of them, and a single bucket
 *   forced one of them to keep a private copy.
 *
 * ## Adding a tool
 *
 * Add its entry here. A hand-registered tool with no entry fails the server's
 * typecheck, because the server asserts that this table's keys are exactly the
 * keys of its permission-tier table — see the two `_every*` assertions in
 * `apps/server/src/services/core/mcp-tool-tiers.ts`. Choose the group by asking which
 * toggle a person would expect to control the tool. If the honest answer is
 * "none of them", it belongs in one of the always-on groups, and it will then be
 * described to every agent regardless of their toggles.
 *
 * Choosing a group is a documentation decision, so get the tool's TIER right in
 * `mcp-tool-tiers.ts` as well: that is the entry that decides whether the tool
 * can run without a person saying yes.
 *
 * Registry-generated tools (the Capability Registry's operator, marketplace, and
 * self-description capabilities) are deliberately absent: the registry already
 * owns their names, and restating them here would be a new copy of the thing
 * this table exists to remove. See {@link TOOL_GATE_GROUP_DOMAIN} for what that
 * means for gating them.
 *
 * @module mcp-tool-groups
 */

/** A tool-group toggle a person can set per agent, or globally as the default. */
export type ToolDomainKey = 'tasks' | 'relay' | 'mesh' | 'adapter';

/**
 * A per-agent grant the server ENFORCES — the other kind of key in
 * `EnabledToolGroups` (DOR-1611, ADR 260828-123331).
 *
 * Deliberately a separate union from {@link ToolDomainKey} rather than a wider
 * one, because the two answer different questions and widening would invite a
 * caller to treat them alike. A `ToolDomainKey` decides what an agent is TOLD
 * about and has a global default; one of these decides whether the call RUNS,
 * has no global default, and cannot be set by the agent it governs.
 *
 * Which capabilities sit behind a grant is NOT listed here, and must not be:
 * each capability declares its own `toolGroup`, and the catalog is where the
 * cockpit and the docs read it. A list here would be the fourth copy of the fact
 * this module exists to keep in one place.
 */
export type CapabilityToolGroupKey = 'roomsManage';

/**
 * A named slice of the hand-registered tool surface.
 *
 * Finer-grained than {@link ToolDomainKey} — see the module TSDoc for why.
 */
export type ToolGateGroup =
  | 'core'
  | 'ui'
  | 'devtools'
  | 'agents'
  | 'extensions'
  | 'tasks'
  | 'relay'
  | 'trace'
  | 'mesh'
  | 'adapter'
  | 'binding';

/**
 * The toggle that covers each group, or `null` when no toggle names it.
 *
 * `null` means "always described": no toggle hides these tools, so every agent is
 * told about them. `trace` and `binding` map to a toggle not named after them,
 * which is the implicit parenting from ADR-0071.
 *
 * Every tool is callable by every agent whichever way this maps, toggles included
 * — see the module TSDoc. This decides documentation only.
 *
 * Registry-generated tools are not in {@link MCP_TOOL_GATE_GROUPS} and therefore
 * have no group here. They follow the same rule the `null` groups follow: no
 * toggle names them, so no toggle omits their documentation.
 */
const TOOL_GATE_GROUP_DOMAIN: Readonly<Record<ToolGateGroup, ToolDomainKey | null>> = {
  core: null,
  ui: null,
  devtools: null,
  agents: null,
  extensions: null,
  tasks: 'tasks',
  relay: 'relay',
  // Trace reads follow the Messaging toggle: they describe message flow, so they
  // are meaningless with messaging off.
  trace: 'relay',
  mesh: 'mesh',
  adapter: 'adapter',
  // Chat routes follow the External Integrations toggle: a route with no
  // integration to route to has nothing to do.
  binding: 'adapter',
};

/**
 * Every hand-registered DorkOS MCP tool, and the group that gates it.
 *
 * Declaration order is the order the derived lists come out in, and it matches
 * the order the two registration files register these tools, so this table can
 * be read side by side with them.
 */
export const MCP_TOOL_GATE_GROUPS = {
  // ── Always available ────────────────────────────────────────────────────
  ping: 'core',
  get_server_info: 'core',
  get_session_count: 'core',
  get_agent: 'core',
  // Drive the cockpit's own screen. They change what a person is looking at,
  // never the system underneath.
  control_ui: 'ui',
  get_ui_state: 'ui',
  // Views of the session's own preview pane, never the system (DOR-213).
  browser_read_console: 'devtools',
  browser_read_network: 'devtools',
  browser_screenshot: 'devtools',
  create_agent: 'agents',
  get_extension_api: 'extensions',
  list_extensions: 'extensions',
  get_extension_errors: 'extensions',
  create_extension: 'extensions',
  reload_extensions: 'extensions',
  test_extension: 'extensions',

  // ── Scheduling ──────────────────────────────────────────────────────────
  tasks_list: 'tasks',
  tasks_create: 'tasks',
  tasks_update: 'tasks',
  tasks_delete: 'tasks',
  tasks_get_run_history: 'tasks',

  // ── Messaging ───────────────────────────────────────────────────────────
  relay_send: 'relay',
  relay_inbox: 'relay',
  relay_list_endpoints: 'relay',
  relay_register_endpoint: 'relay',
  relay_send_and_wait: 'relay',
  relay_send_async: 'relay',
  relay_unregister_endpoint: 'relay',
  relay_get_trace: 'trace',
  relay_get_metrics: 'trace',

  // ── Agent Discovery ─────────────────────────────────────────────────────
  mesh_discover: 'mesh',
  mesh_register: 'mesh',
  mesh_list: 'mesh',
  mesh_deny: 'mesh',
  mesh_unregister: 'mesh',
  mesh_status: 'mesh',
  mesh_inspect: 'mesh',
  mesh_query_topology: 'mesh',

  // ── External Integrations ───────────────────────────────────────────────
  relay_list_adapters: 'adapter',
  relay_enable_adapter: 'adapter',
  relay_disable_adapter: 'adapter',
  relay_reload_adapters: 'adapter',
  binding_list: 'binding',
  binding_create: 'binding',
  binding_delete: 'binding',
  binding_list_sessions: 'binding',
  relay_notify_user: 'binding',
} as const satisfies Record<string, ToolGateGroup>;

/** The name of a hand-registered DorkOS MCP tool. */
export type McpToolGroupName = keyof typeof MCP_TOOL_GATE_GROUPS;

/**
 * The tools one toggle covers, including the groups that implicitly follow it.
 *
 * Turning that toggle off leaves exactly these out of the agent's context. It
 * removes nothing: they stay registered and callable (see the module TSDoc).
 *
 * @param domain - The toggle to resolve.
 * @returns The bare tool names (no `mcp__dorkos__` prefix), in declaration order.
 */
export function toolNamesForDomain(domain: ToolDomainKey): McpToolGroupName[] {
  return (Object.keys(MCP_TOOL_GATE_GROUPS) as McpToolGroupName[]).filter(
    (name) => TOOL_GATE_GROUP_DOMAIN[MCP_TOOL_GATE_GROUPS[name]] === domain
  );
}

/**
 * The tool groups no toggle names.
 *
 * Server identity and agent lookup (`core`), the tools that drive the cockpit's
 * own screen rather than the system underneath (`ui`), and the reads of the
 * session's own preview pane (`devtools`, DOR-213). The cockpit's "always enabled"
 * row reads this constant, so the screen cannot drift from the table above it.
 *
 * It is narrower than the full set of groups that map to `null`: `agents` and
 * `extensions` do too and are not listed here. That gap dates from when this
 * constant fed the SDK's `allowedTools`, where every name added widened an approval
 * bypass, so the list was kept as short as it could be. Nothing feeds `allowedTools`
 * any more (DOR-519), so the only thing the omission costs today is that the cockpit
 * does not show those two groups in its always-enabled row. Widening it is a display
 * change — safe, but visible to the person using it, so it is deliberately not
 * bundled with the security fix.
 */
export const SESSION_CORE_TOOL_GROUPS: readonly ToolGateGroup[] = ['core', 'ui', 'devtools'];

/** The tools in {@link SESSION_CORE_TOOL_GROUPS}, in declaration order. */
export const SESSION_CORE_TOOL_NAMES: readonly McpToolGroupName[] = (
  Object.keys(MCP_TOOL_GATE_GROUPS) as McpToolGroupName[]
).filter((name) => SESSION_CORE_TOOL_GROUPS.includes(MCP_TOOL_GATE_GROUPS[name]));
