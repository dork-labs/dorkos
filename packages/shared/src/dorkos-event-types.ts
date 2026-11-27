/**
 * The table of every named type in the one event union (ADR 261123-170833):
 * for each type, the permission area it belongs to (for a later filter by
 * member; who receives an event today is the audience its sender passes to
 * `eventFanOut.broadcast`), a one-line meaning,
 * and the shape of its payload in words.
 *
 * One table per producing domain, merged into {@link DORKOS_EVENT_TYPES}, so a
 * new domain adds its own table rather than editing another's. The meanings and
 * payloads are the public description of the global stream:
 * `docs/integrations/sse-protocol.mdx` lists the types from this table
 * (`pnpm docs:sse-events` writes the list, and a test fails while it is stale),
 * so a type added here is documented the day it ships.
 *
 * Write `meaning` for someone building against the stream: what happened, and
 * what to do about it when that is not obvious. One sentence or two, no line
 * breaks, no `|`.
 *
 * @module shared/dorkos-event-types
 */
import type { PermissionAreaId } from './permissions/permission-schemas.js';

/** Where one event type belongs, and what it means. */
export interface DorkOsEventTypeInfo {
  /** The permission area, in the words capabilities use; `null` when none fits. */
  readonly area: PermissionAreaId | null;
  /** Why the area is `null`. Required exactly when it is. */
  readonly areaNote?: string;
  /** What the event says happened, in one line, for the public docs. */
  readonly meaning: string;
  /** The payload's shape in words, when the docs describe it; absent while not described. */
  readonly payload?: string;
}

/** A table of event types from one producing domain. */
type EventTable = Record<string, DorkOsEventTypeInfo>;

/** Why a chat event has no area of its own. */
const CHAT_NOTE = 'A chat; who may read a chat is the reach rule.';
/** The payload of an event that only says something changed. */
const CHANGED_AT = '{ changedAt: string }';

/** The stream's own frames: the connect preamble and the SSE keepalive. */
const STREAM_EVENTS = {
  connected: {
    area: null,
    areaNote: 'The stream saying it is open; it carries no data.',
    meaning:
      'The first frame of every connect. `resumed: true` means it picked up from your cursor.',
    payload: '{ connectedAt: string, sessionListsResetAt?: string, resumed?: true }',
  },
  heartbeat: {
    area: null,
    areaNote: 'A keepalive on the SSE wire; it carries no data.',
    meaning: 'A keepalive, every 15 seconds. Nothing to do.',
    payload: 'null',
  },
} as const satisfies EventTable;

/** The chat list (`SessionListEventSchema`). */
const SESSION_LIST_EVENTS = {
  session_upserted: {
    area: null,
    areaNote: CHAT_NOTE,
    meaning: 'A chat was created or its details changed.',
    payload: '{ session: Session }',
  },
  session_removed: {
    area: null,
    areaNote: CHAT_NOTE,
    meaning: 'A chat was deleted.',
    payload: '{ sessionId: string }',
  },
  session_status: {
    area: null,
    areaNote: CHAT_NOTE,
    meaning:
      "A chat's status changed: working, waiting, tokens, cost. `retiredSessionId` means the chat got its lasting id, so drop state held under the old one.",
    payload: '{ sessionId: string, cwd?: string, retiredSessionId?: string, status }',
  },
  session_list_invalidated: {
    area: null,
    areaNote: 'The whole chat list; no one area.',
    meaning:
      'The whole chat list may be different, for example after a switch of Claude account. Read it again.',
    payload: CHANGED_AT,
  },
  account_usage: {
    area: 'reach',
    meaning: "How much of the model account's usage limits is spent changed.",
    payload: 'AccountUsage',
  },
} as const satisfies EventTable;

/** What waits on a person: asks, approvals, standing conditions, the inbox. */
const ATTENTION_EVENTS = {
  interaction_pending: {
    area: 'permissions',
    meaning: 'An agent on this computer stopped and is waiting on a person.',
    payload:
      '{ sessionId: string, cwd: string, interaction: PendingInteraction, roomId?: string, roomAuthorId?: string }',
  },
  interaction_resolved: {
    area: 'permissions',
    meaning: 'That prompt is over: answered, cancelled, or timed out. Drop the card.',
    payload: '{ sessionId: string, interactionId: string, outcome, resolvedAt: string }',
  },
  approval_pending: {
    area: 'permissions',
    meaning: 'Something needs your permission before it runs.',
    payload: 'PendingApproval',
  },
  approval_resolved: {
    area: 'permissions',
    meaning: 'An approval is over: granted, denied, used up, or expired. Drop the card.',
    payload: '{ approvalId: string, outcome, resolvedAt: string }',
  },
  standing_pending: {
    area: 'permissions',
    meaning:
      'Something will keep waiting on you until it is dealt with, such as a sign-in to renew.',
  },
  standing_resolved: {
    area: 'permissions',
    meaning: 'That standing item was dealt with. Drop it.',
  },
  notification: {
    area: null,
    areaNote: "The person's own inbox.",
    meaning: 'An inbox row appeared, or an existing one changed.',
    payload: '{ notification: Notification }',
  },
  notification_read: {
    area: null,
    areaNote: "The person's own inbox.",
    meaning: 'Notifications were marked read somewhere.',
    payload: '{ ids: string[], all: boolean, readAt: string, unreadCount: number }',
  },
  read_cursor: {
    area: null,
    areaNote: "The person's own place in a thread.",
    meaning: 'Your place in a chat or room moved, perhaps in another window.',
  },
} as const satisfies EventTable;

/** Rooms: the list, membership and activity, for readers not on a room's own stream. */
const ROOM_EVENTS = {
  room_created: {
    area: 'rooms',
    meaning: 'A room or direct chat you can read was created.',
    payload: '{ roomId: string, kind, title }',
  },
  room_updated: {
    area: 'rooms',
    meaning: "A room's details changed. Read it again.",
    payload: '{ roomId: string }',
  },
  room_member_added: {
    area: 'rooms',
    meaning: 'Someone joined a room.',
    payload: '{ roomId: string, authorId: string }',
  },
  room_member_removed: { area: 'rooms', meaning: 'Someone left a room.' },
  room_activity: {
    area: 'rooms',
    meaning: 'A new message landed in a room.',
    payload: '{ roomId: string, seq: number, lastActivityAt: string }',
  },
  room_presence: {
    area: 'rooms',
    meaning: 'How many agents are working in a room changed.',
    payload: '{ roomId: string, working: number }',
  },
  room_awaiting: {
    area: 'rooms',
    meaning: "How many of a room's chats are waiting on a person changed.",
    payload: '{ roomId: string, awaiting: number }',
  },
} as const satisfies EventTable;

/** Relay: messages between agents and the chat connections that carry them. */
const RELAY_EVENTS = {
  relay_connected: {
    area: 'messages',
    meaning: 'Relay is on, and this stream now carries its messages.',
    payload: '{ pattern: string, connectedAt: string }',
  },
  relay_message: { area: 'messages', meaning: 'A Relay message reached you.' },
  relay_backpressure: {
    area: 'messages',
    meaning: 'A Relay mailbox is filling faster than it empties.',
  },
  relay_signal: {
    area: 'messages',
    meaning: 'A passing Relay signal: typing, presence, a read or delivery receipt, progress.',
  },
  relay_flow: {
    area: 'messages',
    meaning: 'A message travelled between a chat and the agent that answers it.',
  },
  relay_dead_letter: {
    area: 'messages',
    meaning: 'A message could not be delivered and was set aside.',
  },
  relay_bindings_changed: {
    area: 'connections',
    meaning: 'Which agent answers which chat changed. Read that list again.',
    payload: CHANGED_AT,
  },
  relay_adapters_changed: {
    area: 'connections',
    meaning: 'A chat connection was added, changed, connected or dropped. Read the list again.',
    payload: CHANGED_AT,
  },
  relay_chat_unclaimed: {
    area: 'connections',
    meaning:
      'A new chat wrote in that no agent answers yet. It names the sender, never the message.',
  },
  relay_chat_unclaimed_burst: {
    area: 'connections',
    meaning: 'Too many unclaimed chats arrived to send one by one; this counts the rest.',
  },
  connector_agent_requests_changed: {
    area: 'connections',
    meaning: 'An agent asked to use a service, or such a request was answered.',
    payload: CHANGED_AT,
  },
} as const satisfies EventTable;

/** Scheduled tasks and their runs. */
const TASK_EVENTS = {
  tasks_changed: {
    area: 'tasks',
    meaning: 'A schedule was added, changed or removed. Read the list again.',
    payload: CHANGED_AT,
  },
  task_run_failed: { area: 'tasks', meaning: 'A scheduled run failed.' },
  task_run_finished: { area: 'tasks', meaning: 'A scheduled run finished.' },
  task_run_updated: {
    area: 'tasks',
    meaning: "A finished run's output grew, from work it left running. Read the run again.",
    payload: '{ runId: string, scheduleId: string }',
  },
} as const satisfies EventTable;

/** Agents: the roster, pauses and liveness. */
const AGENT_EVENTS = {
  agents_changed: {
    area: 'agents',
    meaning:
      'An agent was registered, renamed or removed, by any path. Names and ids only: read the agent back for the rest. Sent only when the write changed something.',
    payload:
      "{ kind: 'registered' or 'updated' or 'removed', agentId: string, name?: string, displayName?: string, changedAt: string }",
  },
  agent_pauses_changed: {
    area: 'agents',
    meaning: 'An agent was paused or resumed.',
    payload: CHANGED_AT,
  },
  mesh_liveness_changed: {
    area: 'agents',
    meaning: 'Agents stopped answering, or came back.',
    payload: '{ unreachable, resurrected, changedAt: string }',
  },
} as const satisfies EventTable;

/** Extensions, packages and the tools they add. */
const PACKAGE_EVENTS = {
  extension_reloaded: {
    area: 'extensions',
    meaning: 'Apps were rebuilt, turned on or approved. Reload what you show of them.',
    payload: "{ type: 'extension_reloaded', extensionIds: string[], timestamp: number }",
  },
  capabilities_changed: {
    area: 'extensions',
    meaning: "An app's tools joined or left the list. Read the catalog again.",
    payload: '{ version: number }',
  },
  commands_changed: {
    area: 'packages',
    meaning: 'The slash commands changed. Read them again.',
    payload: CHANGED_AT,
  },
  marketplace_dev_link_reloaded: {
    area: 'packages',
    meaning: 'A package linked from a folder for development was rebuilt.',
  },
} as const satisfies EventTable;

/** Settings, and how this computer is reached from outside. */
const SETTINGS_EVENTS = {
  config_changed: {
    area: 'settings',
    meaning:
      'Settings were written. Section names only, never a value. Sent for every write, except one that only saved where you last were in a space.',
    payload: '{ sections: string[], changedAt: string }',
  },
  keep_awake_status: {
    area: 'settings',
    meaning: 'Whether this computer is being kept awake changed.',
    payload: 'KeepAwakeStatus',
  },
  tunnel_status: {
    area: 'reach',
    meaning:
      'Remote access opened, closed, dropped or changed address. A new connection gets the current one in its opening frames. Never sent to an agent.',
    payload: 'TunnelStatus',
  },
  session_relay_presence: {
    area: 'reach',
    meaning: 'Whether someone is using this computer from the web changed.',
  },
  local_browser_changed: {
    area: 'reach',
    meaning: 'The browser on this computer that agents use was handed over, or its sign-in moved.',
    payload: CHANGED_AT,
  },
  community_connections_changed: {
    area: 'reach',
    meaning:
      'A space connection was added, connected, needs reconnecting, or was removed. Read `GET /api/community-connections` for your own list.',
    payload: CHANGED_AT,
  },
} as const satisfies EventTable;

/** Every named event type the global stream carries, by name, in table order. */
export const DORKOS_EVENT_TYPES = {
  ...STREAM_EVENTS,
  ...SESSION_LIST_EVENTS,
  ...ATTENTION_EVENTS,
  ...ROOM_EVENTS,
  ...RELAY_EVENTS,
  ...TASK_EVENTS,
  ...AGENT_EVENTS,
  ...PACKAGE_EVENTS,
  ...SETTINGS_EVENTS,
} as const satisfies EventTable;

/** The extension event family, `ext:<extensionId>:<event>`. */
export const EXTENSION_EVENT_INFO: DorkOsEventTypeInfo = {
  area: 'extensions',
  meaning: 'An event an app sent, named by the app.',
};
