/**
 * `heartbeat.wakers_off` (DOR-3641, DOR-4978): every schedule and heartbeat that cannot wake now,
 * since when, and who it waits on, for the team page. Served by the capability mount on
 * `GET /api/heartbeats/wakers-off` (ADR 261123-170830).
 *
 * Readable by anyone who can read the task list, which already shows each schedule's state, so
 * agents read it too, with no permission area: it changes nothing and names only the team's own
 * schedules and people.
 *
 * @module services/heartbeats/wakers-off/wakers-off-capability
 */
import { z } from 'zod';
import { WakersOffSchema, type WakersOff } from '@dorkos/shared/waker-schemas';
import { defineCapability } from '../../core/capabilities/index.js';
import { CapabilityToolError } from '../../core/capabilities/mcp-envelope.js';

/** Where the list comes from. */
export interface WakersOffReader {
  /** Every waker that cannot wake now. */
  list(): Promise<WakersOff>;
}

/** Set by the running server; absent, the capability says heartbeats are not running. */
let reader: WakersOffReader | undefined;

/**
 * Teach `heartbeat.wakers_off` where to read from.
 *
 * @param next - The reader, or undefined at shutdown.
 */
export function setWakersOffReader(next: WakersOffReader | undefined): void {
  reader = next;
}

/** The capability; in the heartbeat domain. */
export const wakersOffCapability = defineCapability({
  id: 'heartbeat.wakers_off',
  title: 'List what cannot wake',
  description:
    'Every schedule and heartbeat that cannot wake now: why, since when, and who it waits on.',
  tier: 'observe',
  area: null,
  areaNote: 'schedule states the task list already shows to everyone in the space',
  input: z.object({}),
  output: WakersOffSchema,
  surfaces: { http: { method: 'get', path: '/api/heartbeats/wakers-off' } },
  invoke: async () => {
    if (!reader) {
      throw new CapabilityToolError({
        code: 'HEARTBEATS_UNAVAILABLE',
        error: 'Heartbeats are not running on this server yet.',
      });
    }
    return reader.list();
  },
});
