/**
 * The broadcast names the unified `/api/events` stream forwards to generic
 * subscribers. `StreamManager` dispatches each of these to `subscribeEvent`.
 *
 * Derived from the one shared union (`@dorkos/shared/dorkos-events`), never
 * listed here: a name the server emits is a name the union holds, so it reaches
 * dispatch without a second list to keep in step. Three kinds are left out:
 *
 * - the chat-list events, which `StreamManager` validates and hands to the
 *   session binding instead (`SESSION_LIST_EVENT_TYPES`);
 * - `heartbeat`, a keepalive on the SSE wire that nothing subscribes to;
 * - the `ext:<id>:<event>` family, which extensions read through their own API.
 *
 * @module shared/lib/transport/generic-events
 */
import { DORKOS_EVENT_NAMES, type DorkOsEventName } from '@dorkos/shared/dorkos-events';
import type { SessionListEvent } from '@dorkos/shared/session-stream';

/** A union type not dispatched as a generic event. */
type NotGeneric = SessionListEvent['type'] | 'heartbeat';

/** Names {@link GENERIC_EVENTS} leaves out; see the module doc. */
const NOT_GENERIC: ReadonlySet<string> = new Set<NotGeneric>([
  'session_upserted',
  'session_removed',
  'session_status',
  'heartbeat',
]);

/** A broadcast name forwarded from the unified events stream to subscribers. */
export type GenericEventName = Exclude<DorkOsEventName, NotGeneric>;

/** Broadcast names forwarded from the unified events stream to subscribers. */
export const GENERIC_EVENTS: readonly GenericEventName[] = DORKOS_EVENT_NAMES.filter(
  (name): name is GenericEventName => !NOT_GENERIC.has(name)
);
