/**
 * The Inbox line when a saved global MCP server's name turned out to be one of
 * DorkOS's own (DOR-4262). Since DOR-3600 such a server never reaches an agent;
 * this says so once, with Review: the house `open` action, which opens the
 * server's sheet (`notificationLink` in the client), where the person renames it.
 *
 * Raised at startup for every saved server with a reserved name. Nothing new can
 * take such a name (the store refuses it), so startup is the only place one is
 * found. The name is the person's own, shown as plain text; no agent reads the
 * Inbox, and `relay: 'never'` keeps it off chat apps.
 *
 * @module services/mesh/global-mcp/global-mcp-reserved-name-notice
 */
import type { NotificationActionDTO } from '@dorkos/shared/notification-schemas';
import type { NotificationRegistryEntry } from '../../notifications/notification-registry.js';

/** The payload of `mcp-server.reserved_name`. */
export interface McpReservedNamePayloads {
  'mcp-server.reserved_name': {
    /** The global server, as the person named it. */
    server: string;
  };
}

const ACTIONS: NotificationActionDTO[] = [{ id: 'open', label: 'Review', style: 'primary' }];

/**
 * As long as the inbox keeps a row (`NOTIFICATION_RETENTION_DAYS`, 30): dedupe
 * reads the stored rows, so a longer window would claim a silence the store
 * cannot keep. A server still unrenamed a month later is said again, once.
 */
export const RESERVED_NAME_DEDUPE_MS = 30 * 24 * 60 * 60 * 1000;

/** The entry, spread into the registry's `ENTRIES`. */
export const MCP_RESERVED_NAME_ENTRIES: {
  'mcp-server.reserved_name': NotificationRegistryEntry<'mcp-server.reserved_name'>;
} = {
  'mcp-server.reserved_name': {
    kind: 'mcp-server.reserved_name',
    tier: 'notable',
    storage: 'event',
    subjectType: 'system',
    locate: (p) => ({ subjectId: `mcp-server:${p.server}` }),
    // The designer's words (DOR-4262).
    title: (p) => `${p.server} stopped reaching your agents.`,
    body: () => 'Its name is now reserved for DorkOS. Rename it to fix this.',
    actions: () => ACTIONS,
    dedupeKey: (p) => `mcp-reserved-name:${p.server}`,
    dedupeWindowMs: RESERVED_NAME_DEDUPE_MS,
    relay: 'never',
  },
};

/**
 * Say once, for each saved server whose name is one of DorkOS's own, that it
 * stopped reaching agents. The dedupe key keeps a restart from saying it again.
 *
 * @param servers - The saved servers, as the store lists them.
 * @param say - Raises one line; the notification service by default.
 */
export function sayReservedNameServers(
  servers: readonly { name: string; reservedName: boolean }[],
  say: (server: string) => void
): void {
  for (const server of servers) if (server.reservedName) say(server.name);
}
