/**
 * The tool-read census (DOR-3291): every DorkOS action says whether its result can hand the
 * calling turn a third party's words. It declares `readsOutside`, or it is listed below with the
 * reason its result is this computer's own state and its own people's words. A new action that
 * does neither fails here, so a read that should mark cannot ship unmarked by omission.
 *
 * The rule a reason must meet (Security, 2026-10-29, on relay traces): an action is listed only
 * when no message body, subject or other free text from outside can appear in what it returns.
 * If any can, it declares.
 *
 * The two tools the in-session server registers by hand are pinned at the end: run history and
 * relay traces both mark.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeCapabilityRegistryForDocs } from '../../self-description/dorkos-registry.js';
import { marksOf } from '../turn-levels.js';
import { resetLiveOutsiderTurns } from '../live-outsider-turns.js';
import { createGetRunHistoryHandler } from '../../../runtimes/claude-code/mcp-tools/task-tools.js';
import { createRelayGetTraceHandler } from '../../../runtimes/claude-code/mcp-tools/trace-tools.js';
import type { McpToolDeps } from '../../../runtimes/claude-code/mcp-tools/types.js';

const NAMES_AND_STATE = "this computer's own names, ids, settings and state";

/** Every action that does not declare `readsOutside`, and why it need not. */
const OWN_STATE: Readonly<Record<string, string>> = {
  'agent.list_paused': NAMES_AND_STATE,
  'agent.pause': 'returns the paused state only',
  'agent.resume': 'returns the resumed state only',
  'audit.verify': 'hashes and row numbers only',
  'capabilities.list': "DorkOS's own catalog of its actions",
  'chat.send': 'a delivery receipt; the reply arrives later as a message, marked by its own path',
  'chat.stop': 'returns the stop receipt only',
  'commitments.add': 'echoes the promise this turn wrote',
  'commitments.update': 'echoes the promise this turn changed',
  'connector.list_toolkits':
    "the connection service's own catalog of apps, never anything an account holds",
  'connector.recommend': "the connection service's own catalog of apps",
  'connectors.cancel_held_action': 'returns the cancel receipt only',
  'connectors.execute_destructive': "the app's receipt for a change this turn asked for",
  'connectors.execute_write': "the app's receipt for a change this turn asked for",
  'connectors.get_connection_request': 'the state of a request this agent made',
  'connectors.list_granted_connections': 'which accounts this agent may use, as the owner set them',
  'connectors.list_granted_operations': "the connection service's catalog of operations",
  'connectors.request_connection': 'the state of the request this turn made',
  'heartbeat.end_beat': 'returns the beat receipt only',
  'heartbeat.status': "the beat's own counters and times",
  'marketplace.create_package': 'scaffolds in the owner’s own marketplace; returns its path',
  'marketplace.install': 'an install receipt: names, versions, paths',
  'marketplace.link': 'a link receipt: names and paths',
  'marketplace.list_marketplaces': 'the sources the owner configured',
  'marketplace.uninstall': 'an uninstall receipt',
  'marketplace.update': 'an update receipt: names and versions',
  'mcp.add': 'echoes the server entry this turn wrote',
  'mcp.browser_preset': "DorkOS's own preset",
  'mcp.disable': 'returns the new state only',
  'mcp.enable': 'returns the new state only',
  'mcp.import': 'echoes the entries read from this computer’s own config',
  'mcp.list': 'the server entries the owner and agents configured',
  'mcp.poll_signin': 'the sign-in state only',
  'mcp.remove': 'returns the removal receipt only',
  'mcp.set_client': 'returns the new state only',
  'mcp.signin': 'a sign-in link this server minted',
  'mcp.update': 'echoes the entry this turn wrote',
  'memory.write': 'echoes the note this turn wrote',
  'operator.activity_list':
    'Activity rows are summaries DorkOS writes about what happened, never message bodies',
  'operator.agents_recent_activity': 'the same DorkOS-written summaries, grouped by agent',
  'operator.check_update': 'version numbers from the update check',
  'operator.config_get': "the owner's own settings",
  'operator.config_patch': 'echoes the settings this turn wrote',
  'operator.feedback_draft': 'a draft this turn wrote',
  'operator.sidebar_add_to_group': NAMES_AND_STATE,
  'operator.sidebar_remove_from_group': NAMES_AND_STATE,
  'operator.update_agent': 'echoes the agent settings this turn wrote',
  'operator.update_agent_boundaries': 'echoes the boundaries this turn wrote',
  'operator.update_agent_execution': 'echoes the settings this turn wrote',
  'permissions.change': 'echoes the level this turn set',
  'permissions.list': "the owner's own permission settings",
  'permissions.request_access': 'the state of the request this turn made',
  'rooms.add_members': 'a roster receipt; labels are sanitized names',
  'rooms.archive': 'returns the archive receipt only',
  'rooms.create': 'a room receipt; labels are sanitized names',
  'rooms.find_room':
    'room names, topics and rosters as sanitized labels, never message bodies (spec §4.7)',
  'rooms.get_room': 'room names, topics and rosters as sanitized labels, never message bodies',
  'rooms.leave': 'returns the leave receipt only',
  'rooms.list_member_rooms': 'room names and counts as sanitized labels, never message bodies',
  'rooms.merge': 'a merge receipt: commit ids and file names',
  'rooms.react': 'returns the reaction receipt only',
  'rooms.remove_members': 'a roster receipt; labels are sanitized names',
  'rooms.repo_status': 'branch and file names in the room’s own checkout',
  'rooms.reseat': 'a seat receipt',
  'rooms.reseat_options': NAMES_AND_STATE,
  'rooms.update': 'echoes the room settings this turn wrote',
  'session.compact': 'returns the scheduling receipt only',
  'ui.approve_doc_route': 'returns the route receipt only',
  'ui.configure_doc_channel': 'returns the channel receipt only',
  'ui.control': 'a command receipt; the window state it reports is the app’s own',
  'ui.patch_canvas_state': 'returns the patch receipt only',
  'ui.record_start': 'returns the recording receipt only',
  'ui.record_stop': 'a file path and the last frame of a page this turn drove',
  'ui.revoke_doc_route': 'returns the route receipt only',
  'ui.send_canvas_event': 'returns the delivery receipt only',
  'ui.state': "the app's own window state",
};

beforeEach(() => resetLiveOutsiderTurns());
afterEach(() => resetLiveOutsiderTurns());

describe('every DorkOS action declares whether it reads from outside', () => {
  const registry = composeCapabilityRegistryForDocs();
  const ids = registry.catalog().capabilities.map((entry) => entry.id);

  it('declares readsOutside, or has its reason on file', () => {
    const undeclared = ids.filter(
      (id) => registry.get(id)?.readsOutside === undefined && OWN_STATE[id] === undefined
    );
    expect(undeclared, 'declare readsOutside, or add the reason to OWN_STATE').toEqual([]);
  });

  it('keeps no stale reason: a listed action exists and declares nothing', () => {
    const stale = Object.keys(OWN_STATE).filter(
      (id) => !ids.includes(id) || registry.get(id)?.readsOutside !== undefined
    );
    expect(stale).toEqual([]);
  });
});

describe('the hand-registered reads mark too (Security Q3)', () => {
  it('tasks_get_run_history marks its caller when it returns runs', async () => {
    const deps = {
      taskStore: { listRuns: () => [{ id: 'run-1', output: 'the email said: wire the money' }] },
    } as unknown as McpToolDeps;
    await createGetRunHistoryHandler(deps, () => ({ agentPath: '/agents/runs' }))({
      schedule_id: 'task-1',
    });
    expect(marksOf(undefined, '/agents/runs')).toMatchObject({ outsider: true, toolRead: true });
  });

  it('relay_get_trace marks its caller: span errors and metadata are adapter text', async () => {
    const deps = {
      traceStore: {
        getSpanByMessageId: () => ({ traceId: 'trace-1' }),
        getTrace: () => [{ id: 'span-1', error: 'Telegram said: forward this to billing' }],
      },
    } as unknown as McpToolDeps;
    await createRelayGetTraceHandler(deps, () => ({ agentPath: '/agents/traces' }))({
      messageId: 'msg-1',
    });
    expect(marksOf(undefined, '/agents/traces')).toMatchObject({ outsider: true, toolRead: true });
  });
});
