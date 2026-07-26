/**
 * Which tool-group toggle gates each hand-registered DorkOS MCP tool, written
 * down once (DOR-499).
 *
 * ## Why this table exists
 *
 * A person can turn four groups of DorkOS tools on or off per agent —
 * Scheduling, Messaging, Agent Discovery, External Channels
 * (`EnabledToolGroups` in `mesh-schemas.ts`). Answering "which tools does that
 * toggle actually cover?" used to require three hand-copied lists that all
 * claimed to be the same fact:
 *
 * - the server's seven `*_TOOLS` arrays in
 *   `runtimes/claude-code/tooling/tool-filter.ts`, which build the per-session
 *   tool list,
 * - `TOOL_INVENTORY` in the cockpit's Settings tab, which shows the count and
 *   the names behind each toggle,
 * - a second copy of `TOOL_INVENTORY` pasted into the per-agent Tools tab,
 *   because Feature-Sliced Design forbids one cockpit feature importing
 *   another's files.
 *
 * They drifted, in both directions. The cockpit listed six always-on tools
 * where the server had nine, and seven tools the server registers were in none
 * of the arrays at all. Nothing failed; agents just quietly had a different tool
 * set than the screen said.
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
 * - "What does turning off Messaging remove?" — answered by the toggle a group
 *   maps to in {@link TOOL_GATE_GROUP_DOMAIN}. Two groups are gated by a toggle
 *   that is not named after them: `trace` follows Messaging and `binding`
 *   follows External Channels (ADR-0071). That implicit parenting is recorded
 *   once here rather than re-explained at each list.
 * - "What is always on, no matter what?" — answered by the groups that map to
 *   `null`. Those are kept apart (`core`, `ui`, `devtools`, `agents`,
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
 * available to every agent regardless of their toggles.
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
 * The toggle that gates each group, or `null` when nothing gates it.
 *
 * `null` means "always available": no toggle removes these tools, so every agent
 * has them. `trace` and `binding` map to a toggle not named after them, which is
 * the implicit parenting from ADR-0071.
 *
 * Registry-generated tools are not in {@link MCP_TOOL_GATE_GROUPS} and therefore
 * have no group here. They are ungated by the same rule the `null` groups follow:
 * no toggle names them, so no toggle may remove them.
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
  // Chat routes follow the External Channels toggle: a route with no channel to
  // route to has nothing to do.
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

  // ── External Channels ───────────────────────────────────────────────────
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
 * The tools in one group, in declaration order.
 *
 * @param group - The group to list.
 * @returns The bare tool names (no `mcp__dorkos__` prefix).
 */
export function toolNamesInGroup(group: ToolGateGroup): McpToolGroupName[] {
  return (Object.keys(MCP_TOOL_GATE_GROUPS) as McpToolGroupName[]).filter(
    (name) => MCP_TOOL_GATE_GROUPS[name] === group
  );
}

/**
 * The tools one toggle controls, including the groups that implicitly follow it.
 *
 * Turning that toggle off removes exactly these.
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
 * The groups the per-session tool list always includes, whatever the toggles say.
 *
 * Server identity and agent lookup (`core`), the tools that drive the cockpit's
 * own screen rather than the system underneath (`ui`), and the reads of the
 * session's own preview pane (`devtools`, DOR-213).
 *
 * This is narrower than "every group no toggle gates" — `agents` and `extensions`
 * also map to `null` but are not here. That is deliberate and the reason is in the
 * TSDoc of `buildAllowedTools`'s module
 * (`services/runtimes/claude-code/tooling/tool-filter.ts`): the list this feeds is
 * an approval bypass rather than an availability filter, so adding names to it
 * grants rather than restores. Both the server's session list and the cockpit's
 * "always enabled" row read this one constant, so they cannot disagree about it.
 */
export const SESSION_CORE_TOOL_GROUPS: readonly ToolGateGroup[] = ['core', 'ui', 'devtools'];

/** The tools in {@link SESSION_CORE_TOOL_GROUPS}, in declaration order. */
export const SESSION_CORE_TOOL_NAMES: readonly McpToolGroupName[] = (
  Object.keys(MCP_TOOL_GATE_GROUPS) as McpToolGroupName[]
).filter((name) => SESSION_CORE_TOOL_GROUPS.includes(MCP_TOOL_GATE_GROUPS[name]));
