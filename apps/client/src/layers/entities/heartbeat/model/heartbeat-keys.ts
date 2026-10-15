/**
 * Query keys for heartbeats, in one place so saving `HEARTBEAT.md` can
 * invalidate the status it changes.
 *
 * @module entities/heartbeat/model/heartbeat-keys
 */

/** Every heartbeat query sits under this prefix. */
const HEARTBEAT_KEY = ['heartbeat'] as const;

/** The query keys the heartbeat hooks read under. */
export const heartbeatKeys = {
  /** Everything heartbeat-shaped. */
  all: HEARTBEAT_KEY,
  /** `GET /api/agents/:id/heartbeat` for one agent. */
  agent: (agentId: string) => [...HEARTBEAT_KEY, 'agent', agentId] as const,
};
