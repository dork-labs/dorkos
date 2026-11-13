/**
 * The Inbox line when a global MCP server adds a tool that an agent may already
 * use without asking, because it allows every tool on that server (DOR-4118).
 * Said once per server and tool, with Review: the house `open` action. The row
 * opens the server's sheet (`notificationLink` in the client).
 *
 * The line never names the tool. A tool's name comes from the server, so it is
 * untrusted text, and a line travels further than the sheet (a phone push, a
 * desktop banner): the person reads the name on the sheet, where it is plain
 * text (Security, Nov 12). No agent reads the Inbox (an agent caller gets an
 * empty list), and `relay: 'never'` keeps it off chat apps.
 *
 * The emitter is the sheet's tools route (`routes/mcp-server-sheet.ts`).
 *
 * @module services/mesh/global-mcp/global-mcp-tool-added-notice
 */
import type { NotificationActionDTO } from '@dorkos/shared/notification-schemas';
import type { NotificationRegistryEntry } from '../../notifications/notification-registry.js';

/** The payload of `mcp-server.tool_added`. */
export interface McpToolAddedPayloads {
  'mcp-server.tool_added': {
    /** The global server, as the person named it. */
    server: string;
    /** The added tool. Only ever part of the dedupe key; never shown. */
    tool: string;
    /** The agents allowing every tool on the server, by name. */
    agentNames: string[];
  };
}

const ACTIONS: NotificationActionDTO[] = [{ id: 'open', label: 'Review', style: 'primary' }];

/** "Quill", "Quill and Atlas", "Quill, Atlas and 2 more". */
function namesOf(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? 'An agent';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/**
 * The line's title.
 *
 * @param p - The row's payload.
 */
export function mcpToolAddedTitle(p: McpToolAddedPayloads['mcp-server.tool_added']): string {
  return `${p.server} added a tool. ${namesOf(p.agentNames)} can use it without asking.`;
}

/** The entry, spread into the registry's `ENTRIES`. */
export const MCP_TOOL_ADDED_ENTRIES: {
  'mcp-server.tool_added': NotificationRegistryEntry<'mcp-server.tool_added'>;
} = {
  'mcp-server.tool_added': {
    kind: 'mcp-server.tool_added',
    tier: 'notable',
    storage: 'event',
    subjectType: 'system',
    locate: (p) => ({ subjectId: `mcp-server:${p.server}` }),
    title: mcpToolAddedTitle,
    body: (p) =>
      p.agentNames.length === 1
        ? `It allows every ${p.server} tool, including new ones.`
        : `They allow every ${p.server} tool, including new ones.`,
    actions: () => ACTIONS,
    dedupeKey: (p) => `mcp-tool-added:${p.server}:${p.tool}`,
    relay: 'never',
  },
};
