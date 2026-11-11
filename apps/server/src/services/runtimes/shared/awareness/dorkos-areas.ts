/**
 * What an agent can do in DorkOS, one line per area, in every agent's
 * start-of-session context (DOR-3219).
 *
 * ## Why this exists
 *
 * The orientation block used to name four subsystems (Console, Tasks, Relay,
 * Mesh), so an agent asked "can you use my browser?" or "add an MCP server"
 * answered from what it knew of the outside world: it sent a person to Terminal,
 * or recommended another tool, for something DorkOS already does (FB-61,
 * DOR-3157). On Claude Code most DorkOS tools are deferred and show up as bare
 * names, so the tool list alone does not tell an agent what an area is for.
 *
 * ## What it promises, and what it doesn't
 *
 * Each line says what an agent can DO, and names the permission areas that
 * govern it, never the agent's current level: a level can change at any moment,
 * and a stale "Allowed" in a cached prompt would read as permission. The block
 * points at the tool that reports the live levels instead. Lines describe only
 * what is built and works today (the demo-claim gate in `meta/ROADMAP.md`).
 *
 * **Trusted system text, written here and nowhere else.** Nothing in it is read
 * from a release note, a room, a file or the network, and it names no tool
 * prefix, so it reads the same on every runtime (the rule
 * `context-tool-names.test.ts` enforces for `runtimes/shared/`).
 *
 * ## The drift test
 *
 * Every line lists the capability and tool ids it covers, by id prefix, and the
 * permission areas those ids belong to. `__tests__/dorkos-areas.test.ts` fails
 * when an agent-reachable id has no line, or when a line's areas drift from
 * its ids'. Add a capability, and the test asks for its line.
 *
 * @module services/runtimes/shared/awareness/dorkos-areas
 */
import type { PermissionAreaId } from '@dorkos/shared/permissions';
import { getPermissionArea } from '@dorkos/shared/permissions';

/** One area of DorkOS, as an agent is told about it. */
export interface DorkosAreaLine {
  /** The name the line starts with. */
  readonly name: string;
  /** What an agent can do there, in one short plain sentence. */
  readonly can: string;
  /**
   * The capability and direct-tool ids this line answers for, by prefix: an id
   * is covered when it equals an entry or starts with it.
   */
  readonly covers: readonly string[];
  /** The permission areas those ids belong to, in display order. */
  readonly areas: readonly PermissionAreaId[];
  /**
   * What decides it instead, for a line whose ids belong to no permission area,
   * so the line never reads as "always allowed" when something else gates it.
   */
  readonly gate?: string;
}

/** Every area, in the order an agent reads them. */
export const DORKOS_AREAS: readonly DorkosAreaLine[] = [
  {
    name: 'Chats',
    can: 'spin off long work; message, read or stop chats; summarize yours.',
    covers: ['chat.', 'session_start', 'session.compact'],
    areas: ['agents', 'messages', 'own_chat'],
  },
  {
    name: 'Rooms',
    can: 'post, react, read and search; open rooms, set members, merge files.',
    covers: ['rooms.'],
    areas: ['rooms'],
  },
  {
    // One line for both canvas surfaces (DOR-3219 diet): the document table and
    // the browser tab are the same place to an agent.
    name: 'Canvas',
    can: 'open documents, files, diffs, widgets and pages, here or in a room; drive DorkOS pages (not real sites), which can send you events.',
    covers: [
      'ui.control',
      'ui.state',
      'ui.read_canvas_document',
      'ui.patch_canvas_state',
      'ui.send_canvas_event',
      'ui.configure_doc_channel',
      'ui.approve_doc_route',
      'ui.revoke_doc_route',
      'ui.click',
      'ui.type',
      'ui.press',
      'ui.scroll',
      'ui.wait_for',
      'ui.read_page',
      'ui.screenshot',
      'ui.read_console',
      'ui.read_network',
      'ui.record_start',
      'ui.record_stop',
    ],
    areas: [],
    gate: 'always on',
  },
  {
    name: 'Agent browser',
    can: 'drive a real website in a page a person shares (Browser, + menu); ask for one, never send them to a terminal.',
    covers: ['local_browser.', 'mcp.browser_preset'],
    areas: [],
    gate: 'a person shares it',
  },
  {
    name: 'Connected apps',
    can: 'use connected apps, ask for one, or give access up.',
    covers: ['connector.', 'connectors.'],
    areas: ['permissions'],
    gate: 'per-app grant',
  },
  {
    // MCP servers, packages and extensions share one permission area, so one line (DOR-3219 diet).
    name: 'Tools',
    can: 'add or remove your MCP servers and packages; build extensions a person approves. A change reaches you next turn, in this chat: no restart.',
    covers: ['mcp.', 'marketplace.', 'create_extension', 'reload_extensions', 'test_extension'],
    areas: ['packages'],
    gate: 'adding an MCP server asks',
  },
  {
    // Telegram and Slack, and reaching the person through them, on one line.
    name: 'Chat apps',
    can: "switch Telegram and Slack, pick each chat's agent, reach the person there.",
    covers: [
      'relay_list_adapters',
      'relay_enable_adapter',
      'relay_disable_adapter',
      'relay_reload_adapters',
      'binding_',
      'relay_notify_user',
      'relay_list_endpoints',
      'relay_get_trace',
      'relay_get_metrics',
    ],
    areas: ['messages', 'connections'],
  },
  {
    name: 'Tasks',
    can: 'create, change and delete schedules; read runs; end a heartbeat.',
    covers: ['tasks_', 'heartbeat.'],
    areas: ['tasks'],
  },
  {
    name: 'Agents',
    can: 'find, create, change, pause and resume agents and their work queues.',
    covers: [
      'work-queue.',
      'mesh_',
      'create_agent',
      'get_agent',
      'agent.',
      'operator.update_agent',
      'operator.sidebar_',
    ],
    areas: ['agents', 'safety'],
  },
  {
    name: 'Memory',
    can: 'save notes your other sessions read.',
    covers: ['memory.'],
    areas: [],
    gate: 'always on',
  },
  {
    name: 'To-dos',
    can: "record promises, read the team's, mark yours kept or dropped.",
    covers: ['todo_promises.'],
    areas: ['todos'],
  },
  {
    // What agents did and how this computer is doing, both read only, on one line.
    name: 'Activity',
    can: 'read agent activity, running chats, audit log, transcripts, server health, Claude usage.',
    covers: [
      'audit.',
      'operator.activity_list',
      'operator.agents_recent_activity',
      'ping',
      'get_server_info',
      'get_session_count',
      'get_extension_api',
      'list_extensions',
      'get_extension_errors',
      'accounts_',
    ],
    areas: [],
    gate: 'read only',
  },
  {
    name: 'Settings',
    can: 'change settings, see your permissions, ask for one you lack.',
    covers: [
      'operator.config_',
      'operator.check_update',
      'permissions.',
      'instructions.',
      'capabilities.list',
      'operator.feedback_draft',
    ],
    areas: ['settings', 'permissions'],
  },
];

/** Whether a capability or tool id falls under one of a line's prefixes. */
export function areaLineCovers(line: DorkosAreaLine, id: string): boolean {
  return line.covers.some((prefix) => id === prefix || id.startsWith(prefix));
}

/** One area line: its name, what it does, and the permission areas that govern it. */
function renderLine(line: DorkosAreaLine): string {
  const labels = line.areas.map((id) => getPermissionArea(id)?.label ?? id);
  return `- ${line.name}: ${line.can}${labels.length > 0 ? ` [${labels.join('; ')}]` : ''}`;
}

/**
 * Every other gate, once each, with the lines it governs (DOR-3219 diet). A
 * gate repeated in a bracket on every line it touched cost a third of the block.
 */
function gatesLine(): string {
  const byGate = new Map<string, string[]>();
  for (const line of DORKOS_AREAS) {
    if (line.gate) byGate.set(line.gate, [...(byGate.get(line.gate) ?? []), line.name]);
  }
  const groups = [...byGate].map(([gate, names]) => `${gate} (${names.join(', ')})`);
  return `Gates: ${groups.join('; ')}.`;
}

/**
 * The `<dorkos_areas>` block: every area line, what governs each, and the rule
 * that sends an agent to the catalog before it says DorkOS can't do something.
 *
 * Static, so it stays in each runtime's cached prefix.
 */
export function buildDorkosAreasBlock(): string {
  return `<dorkos_areas>
What exists, not what you may do now. [Brackets] name the permission; the tool whose
name ends in \`list_my_permissions\` has your levels.
${DORKOS_AREAS.map(renderLine).join('\n')}
${gatesLine()}
Before you say DorkOS can't do something, search the tool whose name ends in \`list_capabilities\`.
</dorkos_areas>`;
}
