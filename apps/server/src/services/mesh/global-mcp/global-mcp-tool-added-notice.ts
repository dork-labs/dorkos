/**
 * The Inbox line when a global MCP server adds a tool that an agent may already
 * use without asking, because it allows every tool on that server (DOR-4118).
 * Said once per server and tool, with Review (opens the server's sheet) and OK.
 *
 * The line never names the tool. A tool's name comes from the server, so it is
 * untrusted text, and notifications are read by agents too: the person reads
 * the name on the sheet, where it is plain text (Security, Nov 12). The row
 * carries the tool only in its dedupe key.
 *
 * The emitter is the sheet's tools route (`routes/mcp-server-sheet.ts`).
 *
 * @module services/mesh/global-mcp/global-mcp-tool-added-notice
 */
import type { NotificationActionDTO } from '@dorkos/shared/notification-schemas';
import type { NotificationRegistryEntry } from '../../notifications/notification-registry.js';

/** The intent behind Review: open the server's sheet. */
export const REVIEW_MCP_SERVER_ACTION_ID = 'review-mcp-server';

/** The intent behind OK: mark the row read. */
export const OK_MCP_TOOL_ADDED_ACTION_ID = 'ok-mcp-tool-added';

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

const ACTIONS: NotificationActionDTO[] = [
  { id: REVIEW_MCP_SERVER_ACTION_ID, label: 'Review', style: 'neutral' },
  { id: OK_MCP_TOOL_ADDED_ACTION_ID, label: 'OK', style: 'primary' },
];

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
