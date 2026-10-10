/**
 * An agent's heartbeat, as the app reads it (spec `heartbeats` §7.6): how it
 * wakes, its next check, its last checks, and the messages held for people's
 * hours.
 *
 * @module entities/heartbeat
 */
export { heartbeatKeys } from './model/heartbeat-keys';
export { useAgentHeartbeat } from './model/use-agent-heartbeat';
