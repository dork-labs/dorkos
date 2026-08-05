/**
 * The durable streams' upgrade routes, in one list.
 *
 * `index.ts` hands this to {@link attachUpgradeRouter} alongside the terminal's
 * route. Order matters only in that no two patterns may overlap, and none of
 * these do — each claims one exact path shape.
 *
 * @module routes/stream-sockets
 */
import type { UpgradeRoute } from '../services/core/streams/upgrade-router.js';
import { globalEventsRoute } from './events-socket.js';
import { sessionEventsRoute } from './session-events-socket.js';
import { roomEventsRoute } from './room-events-socket.js';

/** Every durable stream a cockpit window opens, as upgrade routes. */
export const durableStreamRoutes: readonly UpgradeRoute[] = [
  globalEventsRoute,
  sessionEventsRoute,
  roomEventsRoute,
];
