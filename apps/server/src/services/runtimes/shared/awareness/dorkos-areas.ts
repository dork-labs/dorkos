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
    can: 'start a spin-off chat for long work; message, read or stop another; summarize your own.',
    covers: ['chat.', 'session_start', 'session.compact'],
    areas: ['agents', 'messages', 'own_chat'],
  },
  {
    name: 'Rooms',
    can: "post, react, read and search rooms you're in; open rooms, change members, merge files.",
    covers: ['rooms.'],
    areas: ['rooms'],
  },
  {
    name: 'Canvas',
    can: "open documents, files, diffs, widgets and pages beside the chat or on a room's canvas.",
    covers: [
      'ui.control',
      'ui.state',
      'ui.read_canvas_document',
      'ui.patch_canvas_state',
      'ui.send_canvas_event',
      'ui.configure_doc_channel',
      'ui.approve_doc_route',
      'ui.revoke_doc_route',
    ],
    areas: [],
    gate: 'always on',
  },
  {
    name: 'Canvas browser',
    can: 'drive a page DorkOS serves in a canvas tab. A real website is only shown there.',
    covers: [
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
    can:
      'drive a real website, signed in, in a browser page a person shares with this chat ' +
      "(Browser, in the right panel's + menu). Ask them to share one; never send them to a terminal.",
    covers: ['local_browser.', 'mcp.browser_preset'],
    areas: [],
    gate: 'a person shares it',
  },
  {
    name: 'Connected apps',
    can: 'read and change things in apps a person connected for you, or ask for one.',
    covers: ['connector.', 'connectors.'],
    areas: [],
    gate: 'each app grant',
  },
  {
    name: 'MCP servers',
    can:
      'add, test, sign in, switch and remove your own MCP servers, or import one on this ' +
      'computer. A change reaches you next turn, in this chat: no restart.',
    covers: ['mcp.'],
    areas: ['packages'],
    gate: 'adding or changing one always asks',
  },
  {
    name: 'Chat connections',
    can: 'switch the Telegram and Slack connections, and choose which agent gets each chat.',
    covers: [
      'relay_list_adapters',
      'relay_enable_adapter',
      'relay_disable_adapter',
      'relay_reload_adapters',
      'binding_',
    ],
    areas: ['connections'],
  },
  {
    name: 'Reaching the person',
    can: "message them on their phone or chat app when they aren't here; trace a lost message.",
    covers: ['relay_notify_user', 'relay_list_endpoints', 'relay_get_trace', 'relay_get_metrics'],
    areas: ['messages'],
  },
  {
    name: 'Tasks',
    can: 'create, change and delete scheduled runs, read how they went, and end a heartbeat.',
    covers: ['tasks_', 'heartbeat.'],
    areas: ['tasks'],
  },
  {
    name: 'Agents',
    can: 'find, register, create, change, pause and resume agents, and sort the sidebar.',
    covers: [
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
    name: 'Marketplace and extensions',
    can: 'install, update and remove packages; build and test extensions a person approves.',
    covers: ['marketplace.', 'create_extension', 'reload_extensions', 'test_extension'],
    areas: ['packages'],
  },
  {
    name: 'Memory',
    can: 'save notes your other sessions read, and record and close the promises you make.',
    covers: ['memory.', 'commitments.'],
    areas: [],
    gate: 'always on',
  },
  {
    name: 'Activity',
    can: "read what agents did, every chat running now, the audit log and agents' transcripts.",
    covers: ['audit.', 'operator.activity_list', 'operator.agents_recent_activity'],
    areas: [],
    gate: 'read only',
  },
  {
    name: 'Settings',
    can: 'change everyday settings, see your permissions, and ask for one you lack.',
    covers: [
      'operator.config_',
      'operator.check_update',
      'permissions.',
      'capabilities.list',
      'operator.feedback_draft',
    ],
    areas: ['settings', 'permissions'],
  },
  {
    name: 'This computer',
    can: "see the server's health, open chats, extension errors and Claude account usage.",
    covers: [
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
];

/** Whether a capability or tool id falls under one of a line's prefixes. */
export function areaLineCovers(line: DorkosAreaLine, id: string): boolean {
  return line.covers.some((prefix) => id === prefix || id.startsWith(prefix));
}

/** The permission phrase a line ends with. */
function permissionOf(line: DorkosAreaLine): string {
  const labels = line.areas.map((id) => getPermissionArea(id)?.label ?? id);
  return [...labels, ...(line.gate ? [line.gate] : [])].join('; ');
}

/**
 * The `<dorkos_areas>` block: every area line, plus the rule that sends an
 * agent to the catalog before it says DorkOS can't do something.
 *
 * Static, so it stays in each runtime's cached prefix.
 */
export function buildDorkosAreasBlock(): string {
  const lines = DORKOS_AREAS.map((line) => `- ${line.name}: ${line.can} [${permissionOf(line)}]`);
  return `<dorkos_areas>
What you can do in DorkOS. This is what exists, not what you may do now: [brackets] name the
permission that governs each line; the tool whose name ends in \`list_my_permissions\` has your levels.
${lines.join('\n')}
Before you say DorkOS can't do something, or send anyone to an outside tool or a terminal, search
the tool whose name ends in \`list_capabilities\` (with a \`query\`), and use what it finds.
</dorkos_areas>`;
}
