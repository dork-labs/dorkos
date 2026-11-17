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

/** Whether any installed package came from somewhere but the person's own marketplace. */
const anyInstalledFromOutside: ReturnsOutsideText = (returned) => {
  const installed = (returned as { installed?: unknown } | null)?.installed;
  return (
    Array.isArray(installed) &&
    installed.some(
      (entry) => (entry as { installedFrom?: unknown }).installedFrom !== PERSONAL_MARKETPLACE_NAME
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
  'connector.list_toolkits': 'outside',
  'connector.recommend': 'outside',
  'connectors.list_granted_operations': 'outside',
  // What the app answered: an updated issue, a thread, an event, written by other people.
  'connectors.execute_write': 'outside',
  'connectors.execute_destructive': 'outside',
  'mcp.test': 'outside',
  mesh_discover: 'outside',
  test_extension: 'outside',
  // ── What other turns read or said ──────────────────────────────────────────
  'audit.transcript_read': 'outside',
  'rooms.read_canvas': 'outside',
  tasks_get_run_history: 'outside',
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
  // An opened note marks when a line of it was saved while reading outside words.
  'memory.read': 'self',
  'connectors.execute_read': 'self',
  // ── Marks when a listed entry came from a third-party package ──────────────
  'marketplace.list_installed': anyInstalledFromOutside,
  mesh_list: anyFromPackage('agents'),
  mesh_inspect: anyFromPackage('agent'),
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
  'marketplace.list_marketplaces': 'local',
  'marketplace.install': 'local',
  'marketplace.update': 'local',
  'marketplace.uninstall': 'local',
  'marketplace.create_package': 'local',
  'marketplace.link': 'local',
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
  'chat.send': 'local',
  'chat.stop': 'local',
  'todo_promises.add': 'local',
  'todo_promises.update': 'local',
  'todo_promises.list': 'local',
  'work-queue.add': 'local',
  'work-queue.remove': 'local',
  'work-queue.list': 'local',
  'work-queue.read_agent': 'local',
  'work-queue.configure': 'local',
  'work-queue.reorder': 'local',
  'work-queue.requeue': 'local',
  'work-claims.claim': 'local',
  'work-claims.check': 'local',
  'work-claims.release': 'local',
  'audit.verify': 'local',
  'audit.query': 'local',
  'audit.get': 'local',
  'audit.account_timeline': 'local',
  'agent.pause': 'local',
  'agent.resume': 'local',
  'agent.list_paused': 'local',
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
  'heartbeat.end_beat': 'local',
  'heartbeat.status': 'local',
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
    markCallerTurnOutsider(caller);
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
