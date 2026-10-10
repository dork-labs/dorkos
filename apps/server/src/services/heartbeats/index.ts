/**
 * Heartbeats: agents wake on a beat or an event, look around for free, work
 * when there is work, and tell people at a decent hour (spec `heartbeats`).
 *
 * @module services/heartbeats
 */
export { heartbeatDomain, withBeatBypassCount, END_BEAT_TOOL } from './heartbeat-capabilities.js';
export { isBeatTurn } from './beat-turns.js';
export {
  startHeartbeats,
  stopHeartbeats,
  type HeartbeatsHandle,
  type HeartbeatsWiringDeps,
} from './heartbeats-wiring.js';
