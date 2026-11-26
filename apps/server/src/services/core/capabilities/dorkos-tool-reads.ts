/**
 * Which of DorkOS's own tools hand the calling turn someone else's text (DOR-3969, spec §4.7), so
 * the turn is marked as one that read outside text when it calls them. Every tool an agent can
 * reach is named here once, by capability id or hand-registered tool name, and a census test fails
 * until a new one is (`__tests__/dorkos-tool-reads.test.ts`). A name this table does not know (an
 * extension's tool) marks: an unknown answer fails closed. That costs something lasting: a marked
 * turn leaves its chat recorded as one that held outside words, so class a new tool on purpose.
 *
 * Three kinds:
 *
 * - `outside`: what it returns may hold words from outside the team (a page, a package's README,
 *   another server's answer, a run's output, a transcript). Marks on every call that returns.
 * - `self`: the tool marks the turn itself, only when what it returned holds outside words: a room
 *   read that returned a stranger's or a mini app's post, a chat read of a chat that held outside
 *   words, a connected app's read (every one).
 * - a check on what came back, for a list that may name a third-party package: an agent or extension
 *   installed from a marketplace, or a package from anywhere but the person's own marketplace.
 * - `local`: it returns only what DorkOS, a person on this computer or the team wrote: settings,
 *   ids, labels, statuses, the agent's own files and notes, and what the team chose to keep (an
 *   agent it registered, a package or extension it installed). Labels a stranger could set (a chat's
 *   title, a bridged person's display name) are sanitized names, not text a model is asked to act
 *   on, so they stay here.
 *
 * Marked from what the server verified (`mark-caller-turn.ts`), never from a tool's arguments.
 *
 * @module services/core/capabilities/dorkos-tool-reads
 */
import { PERSONAL_MARKETPLACE_NAME } from '../../marketplace-mcp/personal-marketplace.js';
import { markCallerTurnOutsider, type CallerTurn } from './mark-caller-turn.js';

/**
 * A check on what a tool returned: whether it holds outside text. For a hand-registered tool, the
 * value is the JSON its result carries.
 */
export type ReturnsOutsideText = (returned: unknown) => boolean;

/** Whether a DorkOS tool can hand its caller outside text, and who marks the turn when it does. */
export type DorkosToolRead = 'outside' | 'self' | 'local' | ReturnsOutsideText;

/** Whether any entry in `list` under `key` came from a package someone outside the team published. */
const anyFromPackage =
  (key: string): ReturnsOutsideText =>
  (returned) => {
    const value = (returned as Record<string, unknown> | null)?.[key];
    const list = Array.isArray(value) ? value : [value];
    return list.some((entry) => (entry as { fromPackage?: unknown } | null)?.fromPackage === true);
  };

/**
 * Whether any source's last fetch carries a `reason`: git's or the remote's own words when a
 * fetch failed.
 */
const anySourceFetchReason: ReturnsOutsideText = (returned) => {
  const sources = (returned as { sources?: unknown } | null)?.sources;
  return (
    Array.isArray(sources) &&
    sources.some(
      (source) =>
        typeof (source as { lastFetch?: { reason?: unknown } } | null)?.lastFetch?.reason ===
        'string'
    )
  );
};

/** Whether any installed package under `key` came from somewhere but the person's own marketplace. */
const anyInstalledFromOutside =
  (key: string): ReturnsOutsideText =>
  (returned) => {
    const installed = (returned as Record<string, unknown> | null)?.[key];
    return (
      Array.isArray(installed) &&
      installed.some(
        (entry) =>
          (entry as { installedFrom?: unknown }).installedFrom !== PERSONAL_MARKETPLACE_NAME
      )
    );
  };

/** Every DorkOS tool an agent can reach, by capability id or hand-registered tool name. */
export const DORKOS_TOOL_READS: Readonly<Record<string, DorkosToolRead>> = {
  // ── Pages and browsers: whatever the page says ─────────────────────────────
  'ui.read_page': 'outside',
  'ui.read_console': 'outside',
  'ui.read_network': 'outside',
  'ui.screenshot': 'outside',
  'ui.wait_for': 'outside',
  'ui.click': 'outside',
  'ui.type': 'outside',
  'ui.press': 'outside',
  'ui.scroll': 'outside',
  'ui.record_stop': 'outside',
  'ui.read_canvas_document': 'outside',
  'local_browser.observe': 'outside',
  'local_browser.screenshot': 'outside',
  'local_browser.act': 'outside',
  // ── Text a third party wrote ───────────────────────────────────────────────
  'marketplace.search': 'outside',
  'marketplace.get': 'outside',
  'marketplace.recommend': 'outside',
  // A source's listing, a newer version's disclosure and a held-back package's effects are
  // the package's own text (DOR-4978).
  'marketplace.browse': 'outside',
  'marketplace.check_updates': 'outside',
  'marketplace.list_held_back': 'outside',
  'connector.list_toolkits': 'outside',
  'connector.recommend': 'outside',
  'connectors.list_granted_operations': 'outside',
  // What the app answered: an updated issue, a thread, an event, written by other people.
  'connectors.execute_write': 'outside',
  'connectors.execute_destructive': 'outside',
  'mcp.test': 'outside',
  // A server's own tool names and descriptions, which its publisher wrote.
  'mcp.check_global_tools': 'outside',
  // A person's Heartbeat page: each beat's summary can quote what the beat read (agents are refused).
  'heartbeat.view_page': 'outside',
  mesh_discover: 'outside',
  test_extension: 'outside',
  // ── What other turns read or said ──────────────────────────────────────────
  'audit.transcript_read': 'outside',
  // Event summaries can quote what a call was given, such as an email's subject.
  'audit.query': 'outside',
  'audit.get': 'outside',
  'audit.account_timeline': 'outside',
  'rooms.read_canvas': 'outside',
  tasks_get_run_history: 'outside',
  // The app's run reads (DOR-4978): a run's summary is its own words, which quote what it read.
  'tasks.view_runs': 'outside',
  'tasks.view_run': 'outside',
  relay_get_trace: 'outside',
  // ── Marks itself, when what it returned holds outside words ────────────────
  'rooms.read_history': 'self',
  'rooms.search_history': 'self',
  'rooms.search_member_rooms': 'self',
  // A room with a member on a bridged chat, whose name a stranger wrote.
  'rooms.list_member_rooms': 'self',
  'rooms.get_room': 'self',
  'rooms.find_room': 'self',
  'chat.read': 'self',
  // A listed chat that holds outside words, whose title may quote them.
  'audit.running_chats': 'self',
  // The same for an agent's chats, ended ones too (DOR-4970).
  'work-graph.agent_chats': 'self',
  // An opened note marks when a line of it was saved while reading outside words.
  'memory.read': 'self',
  // Every to-do tool marks when a to-do it hands back carries a stranger's words, never for the
  // team's own, through one check (DOR-4666, `todos/todo-word-marks.ts`). `todos.*` are behind
  // `DORKOS_TODOS_ENABLED`.
  'todos.add': 'self',
  'todos.update': 'self',
  'todos.list': 'self',
  'todo_promises.add': 'self',
  'todo_promises.update': 'self',
  'todo_promises.list': 'self',
  // The app's to-do and promise doors (DOR-4978) mark the same way.
  'todos.view_list': 'self',
  'todos.view_card': 'self',
  'todos.view_promises': 'self',
  'todos.add_promise_for_agent': 'self',
  'todos.add_as_person': 'self',
  'todos.change_as_person': 'self',
  'todos.change_promise': 'self',
  'todos.confirm_promise': 'self',
  'connectors.execute_read': 'self',
  // ── Marks when a listed entry came from a third-party package ──────────────
  'marketplace.list_installed': anyInstalledFromOutside('installed'),
  // The marketplace's reads on `/api/marketplace/*` (DOR-4978) mark the same way.
  'marketplace.list_installations': anyInstalledFromOutside('packages'),
  'marketplace.read_installed': anyInstalledFromOutside('installations'),
  // A failed fetch's `reason` can carry git's stderr or a remote's `remote:` lines.
  'marketplace.list_sources': anySourceFetchReason,
  'marketplace.list_marketplaces': anySourceFetchReason,
  mesh_list: anyFromPackage('agents'),
  mesh_inspect: anyFromPackage('agent'),
  // The registry's doors on `/api/mesh/*` (DOR-4978): an agent a package brought marks, as
  // `mesh_list` does. A scan reads folders anyone may have written.
  'mesh.list_agents': anyFromPackage('agents'),
  'mesh.discover': 'outside',
  list_extensions: anyFromPackage('extensions'),
  // ── Only what DorkOS, this computer or the team wrote ──────────────────────
  'operator.activity_list': 'local',
  'operator.config_get': 'local',
  'operator.check_update': 'local',
  'operator.agents_recent_activity': 'local',
  'operator.feedback_draft': 'local',
  'operator.update_agent': 'local',
  'operator.update_agent_boundaries': 'local',
  'operator.update_agent_execution': 'local',
  'operator.update_agent_config': 'local',
  'operator.config_patch': 'local',
  'operator.sidebar_add_to_group': 'local',
  'operator.sidebar_remove_from_group': 'local',
  'marketplace.install': 'local',
  'marketplace.update': 'local',
  'marketplace.uninstall': 'local',
  'marketplace.create_package': 'local',
  'marketplace.link': 'local',
  'marketplace.cache_status': 'local',
  'marketplace.list_dev_links': 'local',
  'connectors.list_granted_connections': 'local',
  'connectors.request_connection': 'local',
  'connectors.get_connection_request': 'local',
  'connectors.narrow_own_access': 'local',
  'connectors.narrow_agent_access': 'local',
  'connectors.approve_request': 'local',
  'connectors.undo_access_change': 'local',
  'connectors.list_access_changes': 'local',
  'connectors.cancel_held_action': 'local',
  'mcp.list': 'local',
  'mcp.add': 'local',
  'mcp.import': 'local',
  'mcp.update': 'local',
  'mcp.remove': 'local',
  'mcp.enable': 'local',
  'mcp.disable': 'local',
  'mcp.signin': 'local',
  'mcp.poll_signin': 'local',
  'mcp.set_client': 'local',
  'mcp.browser_preset': 'local',
  // A person's MCP servers for every agent: agents are refused, and all but the tool check
  // return what the person typed or the team's own settings.
  'mcp.check_global_args': 'local',
  'mcp.add_global_server': 'local',
  'mcp.replace_global_server': 'local',
  'mcp.remove_global_server': 'local',
  'mcp.undo_global_allow': 'local',
  'rooms.post': 'local',
  'rooms.react': 'local',
  'rooms.merge': 'local',
  'rooms.set_up_files': 'local',
  'rooms.repo_status': 'local',
  'rooms.create': 'local',
  'rooms.add_members': 'local',
  'rooms.remove_members': 'local',
  'rooms.update': 'local',
  'rooms.leave': 'local',
  'rooms.archive': 'local',
  'rooms.reseat_options': 'local',
  'rooms.reseat': 'local',
  'rooms.handoff_status': 'local',
  'session.compact': 'local',
  // A link's kind and ids only, never the thing's text (DOR-5046).
  'link.resolve': 'local',
  'chat.send': 'local',
  'chat.stop': 'local',
  'work-queue.add': 'local',
  'work-queue.remove': 'local',
  'work-queue.list': 'local',
  'work-queue.read_agent': 'local',
  'work-queue.configure': 'local',
  'work-queue.reorder': 'local',
  'work-queue.requeue': 'local',
  // A person's own queue doors: agents are refused, and the queue is the team's own words.
  'work-queue.view_queue': 'local',
  'work-queue.change_settings': 'local',
  'work-queue.stop_all': 'local',
  'work-queue.set_order': 'local',
  'work-queue.add_item': 'local',
  'work-queue.remove_item': 'local',
  'work-queue.requeue_item': 'local',
  'work-claims.claim': 'local',
  'work-claims.check': 'local',
  'work-claims.release': 'local',
  // Writes links between ids; it hands back only the refs it was sent.
  'work-graph.record-pr': 'local',
  'audit.verify': 'local',
  'agent.pause': 'local',
  'agent.resume': 'local',
  'agent.list_paused': 'local',
  // A person's move of an old persona into SOUL.md (DOR-4978).
  'agent.migrate_persona': 'local',
  // The agent a folder belongs to: the team's own agent files; another agent gets no instructions.
  'agent.current': 'local',
  // Chat from the web (DOR-4978): a status, browser labels and passkey labels. Only the status
  // reaches an agent, without the hub's address or the linked name.
  'session-relay.status': 'local',
  'session-relay.presence': 'local',
  'session-relay.devices': 'local',
  'session-relay.passkeys': 'local',
  'session-relay.pause': 'local',
  'session-relay.end_presence': 'local',
  'session-relay.unlink': 'local',
  'approvals.withdraw': 'local',
  'local_browser.state': 'local',
  'local_browser.ask_person': 'local',
  'memory.write': 'local',
  'ui.configure_doc_channel': 'local',
  'ui.approve_doc_route': 'local',
  'ui.revoke_doc_route': 'local',
  'ui.send_canvas_event': 'local',
  'ui.patch_canvas_state': 'local',
  'ui.control': 'local',
  'ui.state': 'local',
  'ui.record_start': 'local',
  'capabilities.list': 'local',
  'instructions.read': 'local',
  'permissions.request_access': 'local',
  'permissions.list': 'local',
  'permissions.change': 'local',
  // Settings, the same an agent reads on the permissions page (DOR-4978).
  'permissions.view_agent': 'local',
  'permissions.view_agent_level': 'local',
  'heartbeat.end_beat': 'local',
  'heartbeat.status': 'local',
  'heartbeat.wakers_off': 'local',
  'heartbeat.choose_triage_credits': 'local',
  // A chat's run records: statuses, ids, endings and fixed DorkOS lines. A
  // turn's words stay in its queue row and its runtime's transcript (§4.1).
  'runs.chat_runs': 'local',
  // The work graph's tree and work reads (DOR-4970): ids, states, relations, PR and ticket
  // references and dates, never a title or a chat's words.
  'work-graph.chat_tree': 'local',
  'work-graph.agent_work': 'local',
  'work-graph.chat_work': 'local',
  // A chat's runtime id and its stored settings: DorkOS's own values, never a chat's words (DOR-4978).
  'sessions.get_runtime_type': 'local',
  'sessions.get_settings': 'local',
  // The rest of the registry's doors: ids, health, counts, folders and a person's changes.
  'mesh.status': 'local',
  'mesh.topology': 'local',
  'mesh.list_denied': 'local',
  'mesh.register_agent': 'local',
  'mesh.remove_agent': 'local',
  'mesh.delete_agent_data': 'local',
  'mesh.deny_folder': 'local',
  'mesh.clear_denial': 'local',
  'mesh.set_access_rule': 'local',
  // Folder names, workspaces and the template catalog: what is on this
  // computer, written by the team.
  'directory.browse': 'local',
  'directory.default': 'local',
  // Any file's text inside a folder the caller names, a cloned repo's included.
  'diff.baseline': 'outside',
  'diff.advance_baseline': 'local',
  'diff.pending': 'local',
  'diff.revert': 'local',
  'workspaces.list': 'local',
  'workspaces.scan': 'local',
  'workspaces.pin': 'local',
  // The file browser (DOR-4978): a file's text can come from anywhere.
  'files.read_text': 'outside',
  'files.save': 'local',
  'files.create': 'local',
  'files.delete': 'local',
  'files.rename': 'local',
  'files.reveal': 'local',
  'templates.list': 'local',
  ping: 'local',
  get_server_info: 'local',
  get_session_count: 'local',
  get_agent: 'local',
  accounts_usage: 'local',
  accounts_probe: 'local',
  session_start: 'local',
  tasks_list: 'local',
  tasks_create: 'local',
  tasks_update: 'local',
  tasks_delete: 'local',
  'tasks.view_list': 'local',
  // The app's runtime setup reads (DOR-4978): settings, labels, folder names, key hints.
  'runtimes.account_usage': 'local',
  'runtimes.found_accounts': 'local',
  'runtimes.account_eligibility': 'local',
  'runtimes.key_status': 'local',
  'runtimes.opencode_key_setup': 'local',
  'runtimes.doe_model_setup': 'local',
  relay_list_endpoints: 'local',
  relay_notify_user: 'local',
  relay_list_adapters: 'local',
  relay_enable_adapter: 'local',
  relay_disable_adapter: 'local',
  relay_reload_adapters: 'local',
  relay_get_metrics: 'local',
  binding_list: 'local',
  binding_create: 'local',
  binding_delete: 'local',
  binding_list_sessions: 'local',
  mesh_register: 'local',
  mesh_deny: 'local',
  mesh_unregister: 'local',
  mesh_status: 'local',
  mesh_query_topology: 'local',
  create_agent: 'local',
  get_extension_api: 'local',
  get_extension_errors: 'local',
  create_extension: 'local',
  reload_extensions: 'local',
};

/**
 * How a DorkOS tool is classed. A name the table does not know marks, so a tool nobody classed
 * fails closed.
 *
 * @param name - The capability id or hand-registered tool name.
 */
export function dorkosToolReadOf(name: string): DorkosToolRead {
  return Object.hasOwn(DORKOS_TOOL_READS, name) ? DORKOS_TOOL_READS[name]! : 'outside';
}

/**
 * Mark the caller's turn after a DorkOS tool returned, when that tool hands its caller outside text
 * on every call, or its check finds some in what came back. A `self` tool has already decided, and a
 * `local` one never marks. A check that throws marks.
 *
 * @param name - The capability id or hand-registered tool name.
 * @param caller - The verified call.
 * @param returned - What the tool returned.
 */
export function markAfterDorkosTool(name: string, caller: CallerTurn, returned?: unknown): void {
  const read = dorkosToolReadOf(name);
  if (read === 'outside' || (typeof read === 'function' && holdsOutside(read, returned))) {
    markCallerTurnOutsider(caller, { kind: 'dorkos-tool' });
  }
}

/** Run a check on a tool's result, reading a hand-registered tool's JSON text; a throw marks. */
function holdsOutside(check: ReturnsOutsideText, returned: unknown): boolean {
  try {
    const content = (returned as { content?: { type?: string; text?: string }[] } | null)?.content;
    const text = content?.[0]?.type === 'text' ? content[0].text : undefined;
    return check(text !== undefined ? JSON.parse(text) : returned);
  } catch {
    return true;
  }
}
