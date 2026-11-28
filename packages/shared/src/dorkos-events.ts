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
 * {@link DORKOS_EVENT_TYPES} is the table of every named type
 * (`./dorkos-event-types.ts`), merged from one table per producing domain, so a
 * new domain adds its own table there rather than editing another's. Each type
 * carries a one-line meaning, which the public docs list, and NAMES ITS AREA, in the words capabilities
 * use (a permission area, or `null` with a note saying why none fits), so
 * "which member sees which event" can later be a table over types. Extension
 * events are the `ext:<extensionId>:<event>` family, area `extensions`.
 *
 * @module shared/dorkos-events
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';
import { AccountUsageSchema } from './account-usage.js';
import {
  InteractionPendingEventSchema,
  InteractionResolvedEventSchema,
} from './interaction-events.js';
import { KeepAwakeStatusSchema, TunnelStatusSchema } from './schemas.js';
import { SessionListEventSchema } from './session-stream.js';
import {
  DORKOS_EVENT_TYPES,
  EXTENSION_EVENT_INFO,
  type DorkOsEventTypeInfo,
} from './dorkos-event-types.js';

export { DORKOS_EVENT_TYPES, type DorkOsEventTypeInfo } from './dorkos-event-types.js';

extendZodWithOpenApiOnce();

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
 * The area an event type belongs to, and what it means.
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
   * streams. `null` on a frame outside the numbering (the opening frames, the
   * cold-connect snapshot, the keepalive), which is never stored as a position
   * and never used to order or drop a frame.
   */
  readonly seq: number | null;
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
    .positive()
    .nullable()
    .describe(
      "Position in this stream: it only grows, may skip numbers, and is never compared with another stream's. `null` on a frame outside the numbering (`connected`, the cold-connect snapshot after it, `heartbeat`), which also has no id: never store it as a position, and never use it to order or drop a frame."
    ),
  at: z
    .string()
    .describe('When the server emitted the event, ISO 8601. A replayed event keeps its first one.'),
};

/** One envelope per named type, plus the extension family. */
const memberSchemas = [
  ...DORKOS_EVENT_NAMES.map((name) =>
    z
      .object({
        ...envelopeShape,
        type: z.literal(name),
        payload: PAYLOAD_SCHEMAS[name] ?? z.unknown(),
      })
      .describe(DORKOS_EVENT_TYPES[name].meaning)
  ),
  z
    .object({
      ...envelopeShape,
      type: z
        .string()
        .regex(EXTENSION_EVENT_PATTERN)
        .describe('`ext:<extensionId>:<event>`, an event an extension emits.'),
      payload: z.unknown(),
    })
    .describe(EXTENSION_EVENT_INFO.meaning),
] as unknown as readonly [z.ZodObject, z.ZodObject, ...z.ZodObject[]];

/**
 * The union of every event the global stream carries, as envelopes: what one
 * `GET /api/events` frame holds, over SSE (`data:`) and on the socket.
 */
export const DorkOsEventSchema = z.union(memberSchemas).openapi('DorkOsEvent');
