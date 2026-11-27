/**
 * The one event contract (ADR 261123-170833): the `DorkOsEvent` envelope and
 * the union of every event type the global stream, `GET /api/events`, carries.
 *
 * ## The envelope
 *
 * Every event is `{ seq, at, type, payload }`. `seq` is a position in ONE
 * stream: it only grows within that stream, it may skip numbers (a reader is
 * not sent an event that is not theirs, and an event that is nobody's still
 * spends a number), and a `seq` from one stream is never compared with a `seq`
 * from another. That is what lets a narrow stream be a filtered view of the
 * same contract, and lets a stream fed from another computer number its own.
 *
 * `GET /api/events` sends the whole envelope in every frame (DOR-5474): over
 * SSE it is the `data:` line, and on the socket it is the message itself. The
 * frame id (`id:` over SSE, `id` beside the envelope on the socket) is an opaque
 * resume cursor: echo it back whole as `Last-Event-ID`, or `?resume=` on a
 * socket, and read `seq` from the envelope, never from the id. `at` is when the
 * server emitted the event; a replayed event keeps its first `at`. The wire
 * helpers are in `./dorkos-event-frame.ts`.
 *
 * ## The union
 *
 * {@link DORKOS_EVENT_TYPES} is the table of every named type, merged from one
 * table per producing domain, so a new domain adds its own table here rather
 * than editing another's. Each type NAMES ITS AREA, in the words capabilities
 * use (a permission area, or `null` with a note saying why none fits), so
 * "which member sees which event" can later be a table over types. Extension
 * events are the `ext:<extensionId>:<event>` family, area `extensions`.
 *
 * @module shared/dorkos-events
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';
import type { PermissionAreaId } from './permissions/permission-schemas.js';
import { AccountUsageSchema } from './account-usage.js';
import {
  InteractionPendingEventSchema,
  InteractionResolvedEventSchema,
} from './interaction-events.js';
import { KeepAwakeStatusSchema, TunnelStatusSchema } from './schemas.js';
import { SessionListEventSchema } from './session-stream.js';

extendZodWithOpenApiOnce();

/** Where one event type belongs: the area that would decide who may read it. */
export interface DorkOsEventTypeInfo {
  /** The permission area, in the words capabilities use; `null` when none fits. */
  readonly area: PermissionAreaId | null;
  /** Why the area is `null`. Required exactly when it is. */
  readonly areaNote?: string;
}

/** A table of event types from one producing domain. */
type EventTable = Record<string, DorkOsEventTypeInfo>;

/** The stream's own frames: the connect preamble and the SSE keepalive. */
const STREAM_EVENTS = {
  connected: { area: null, areaNote: 'The stream saying it is open; it carries no data.' },
  heartbeat: { area: null, areaNote: 'A keepalive on the SSE wire; it carries no data.' },
} as const satisfies EventTable;

/** The chat list (`SessionListEventSchema`). */
const SESSION_LIST_EVENTS = {
  session_upserted: { area: null, areaNote: 'A chat; who may read a chat is the reach rule.' },
  session_removed: { area: null, areaNote: 'A chat; who may read a chat is the reach rule.' },
  session_status: { area: null, areaNote: 'A chat; who may read a chat is the reach rule.' },
  session_list_invalidated: { area: null, areaNote: 'The whole chat list; no one area.' },
  account_usage: { area: 'reach' },
} as const satisfies EventTable;

/** What waits on a person: asks, approvals, standing conditions, the inbox. */
const ATTENTION_EVENTS = {
  interaction_pending: { area: 'permissions' },
  interaction_resolved: { area: 'permissions' },
  approval_pending: { area: 'permissions' },
  approval_resolved: { area: 'permissions' },
  standing_pending: { area: 'permissions' },
  standing_resolved: { area: 'permissions' },
  notification: { area: null, areaNote: "The person's own inbox." },
  notification_read: { area: null, areaNote: "The person's own inbox." },
  read_cursor: { area: null, areaNote: "The person's own place in a thread." },
} as const satisfies EventTable;

/** Rooms: the list, membership and activity, for readers not on a room's own stream. */
const ROOM_EVENTS = {
  room_created: { area: 'rooms' },
  room_updated: { area: 'rooms' },
  room_member_added: { area: 'rooms' },
  room_member_removed: { area: 'rooms' },
  room_activity: { area: 'rooms' },
  room_presence: { area: 'rooms' },
  room_awaiting: { area: 'rooms' },
} as const satisfies EventTable;

/** Relay: messages between agents and the chat connections that carry them. */
const RELAY_EVENTS = {
  relay_connected: { area: 'messages' },
  relay_message: { area: 'messages' },
  relay_backpressure: { area: 'messages' },
  relay_signal: { area: 'messages' },
  relay_flow: { area: 'messages' },
  relay_dead_letter: { area: 'messages' },
  relay_bindings_changed: { area: 'connections' },
  relay_adapters_changed: { area: 'connections' },
  relay_chat_unclaimed: { area: 'connections' },
  relay_chat_unclaimed_burst: { area: 'connections' },
  connector_agent_requests_changed: { area: 'connections' },
} as const satisfies EventTable;

/** Scheduled tasks and their runs. */
const TASK_EVENTS = {
  tasks_changed: { area: 'tasks' },
  task_run_failed: { area: 'tasks' },
  task_run_finished: { area: 'tasks' },
  task_run_updated: { area: 'tasks' },
} as const satisfies EventTable;

/** Agents: the roster, pauses and liveness. */
const AGENT_EVENTS = {
  agents_changed: { area: 'agents' },
  agent_pauses_changed: { area: 'agents' },
  mesh_liveness_changed: { area: 'agents' },
} as const satisfies EventTable;

/** Extensions, packages and the tools they add. */
const PACKAGE_EVENTS = {
  extension_reloaded: { area: 'extensions' },
  capabilities_changed: { area: 'extensions' },
  commands_changed: { area: 'packages' },
  marketplace_dev_link_reloaded: { area: 'packages' },
} as const satisfies EventTable;

/** Settings, and how this computer is reached from outside. */
const SETTINGS_EVENTS = {
  config_changed: { area: 'settings' },
  keep_awake_status: { area: 'settings' },
  tunnel_status: { area: 'reach' },
  session_relay_presence: { area: 'reach' },
  local_browser_changed: { area: 'reach' },
  community_connections_changed: { area: 'reach' },
} as const satisfies EventTable;

/** Every named event type the global stream carries, by name. */
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

/** One named event type. */
export type DorkOsEventName = keyof typeof DORKOS_EVENT_TYPES;

/** Every named event type, in table order. */
export const DORKOS_EVENT_NAMES = Object.keys(DORKOS_EVENT_TYPES) as readonly DorkOsEventName[];

/** The prefix of the extension event family. */
export const EXTENSION_EVENT_PREFIX = 'ext:';

/** An event an extension emits: `ext:<extensionId>:<event>`. */
export type ExtensionEventType = `ext:${string}:${string}`;

/** The pattern {@link ExtensionEventType} names. */
const EXTENSION_EVENT_PATTERN = /^ext:[^:]+:.+$/;

/** The area of every extension event. */
const EXTENSION_EVENT_INFO: DorkOsEventTypeInfo = { area: 'extensions' };

/** Any event type the global stream carries. */
export type DorkOsEventType = DorkOsEventName | ExtensionEventType;

/**
 * Whether a name is one of the union's types.
 *
 * @param name - An event name, e.g. from a frame.
 */
export function isDorkOsEventType(name: string): name is DorkOsEventType {
  return Object.hasOwn(DORKOS_EVENT_TYPES, name) || EXTENSION_EVENT_PATTERN.test(name);
}

/**
 * The area an event type belongs to.
 *
 * @param type - A member of the union.
 */
export function dorkOsEventArea(type: DorkOsEventType): DorkOsEventTypeInfo {
  return Object.hasOwn(DORKOS_EVENT_TYPES, type)
    ? DORKOS_EVENT_TYPES[type as DorkOsEventName]
    : EXTENSION_EVENT_INFO;
}

/**
 * One event: its place in its stream, when it happened, what it is, and its
 * data. See the module doc for what `seq` promises; this is what every frame
 * of `GET /api/events` carries.
 */
export interface DorkOsEvent<T extends DorkOsEventType = DorkOsEventType, P = unknown> {
  /**
   * Position in this stream: only grows, may skip, never compared across
   * streams. 0 on a frame outside the numbering (the opening frames, the
   * keepalive).
   */
  readonly seq: number;
  /** When the server emitted the event, ISO 8601. A replay keeps the first one. */
  readonly at: string;
  /** The event type, a member of the union. */
  readonly type: T;
  /** The event's data. */
  readonly payload: P;
}

/** The payload schema of the types that already have a shared one. */
const PAYLOAD_SCHEMAS: Partial<Record<DorkOsEventName, z.ZodType>> = {
  session_upserted: SessionListEventSchema.options[0],
  session_removed: SessionListEventSchema.options[1],
  session_status: SessionListEventSchema.options[2],
  interaction_pending: InteractionPendingEventSchema,
  interaction_resolved: InteractionResolvedEventSchema,
  account_usage: AccountUsageSchema,
  keep_awake_status: KeepAwakeStatusSchema,
  tunnel_status: TunnelStatusSchema,
};

const envelopeShape = {
  seq: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Position in this stream: it only grows, may skip numbers, and is never compared with another stream's. 0 on a frame with no place in the stream (`connected`, the snapshot after it, `heartbeat`), which also has no id."
    ),
  at: z
    .string()
    .describe('When the server emitted the event, ISO 8601. A replayed event keeps its first one.'),
};

/** One envelope per named type, plus the extension family. */
const memberSchemas = [
  ...DORKOS_EVENT_NAMES.map((name) =>
    z.object({
      ...envelopeShape,
      type: z.literal(name),
      payload: PAYLOAD_SCHEMAS[name] ?? z.unknown(),
    })
  ),
  z.object({
    ...envelopeShape,
    type: z
      .string()
      .regex(EXTENSION_EVENT_PATTERN)
      .describe('`ext:<extensionId>:<event>`, an event an extension emits.'),
    payload: z.unknown(),
  }),
] as unknown as readonly [z.ZodObject, z.ZodObject, ...z.ZodObject[]];

/**
 * The union of every event the global stream carries, as envelopes: what one
 * `GET /api/events` frame holds, over SSE (`data:`) and on the socket.
 */
export const DorkOsEventSchema = z.union(memberSchemas).openapi('DorkOsEvent');
