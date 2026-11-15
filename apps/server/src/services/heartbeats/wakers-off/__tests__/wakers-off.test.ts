/**
 * The team page's list of wakers that cannot wake (DOR-3641): which schedules
 * and heartbeats it names, since when, and who each waits on.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@dorkos/test-utils/db';
import { pulseSchedules, type Db } from '@dorkos/db';
import type { AgentPause } from '@dorkos/shared/mesh-schemas';
import type { HeartbeatWake } from '@dorkos/shared/heartbeat-schemas';
import {
  heartbeatWakeOf,
  listWakersOff,
  readOffSchedules,
  type WakersOffInput,
} from '../wakers-off.js';

const OWNER = 'owner-account';
const SCOUT = { id: 'agent-scout', name: 'Scout', runtime: 'claude-code', projectPath: '/a/scout' };
const ATLAS = { id: 'agent-atlas', name: 'Atlas', runtime: 'claude-code', projectPath: '/a/atlas' };

describe('wakers off (DOR-3641)', () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  function schedule(id: string, values: { enabled?: boolean; status?: string; agentId?: string }) {
    db.insert(pulseSchedules)
      .values({
        id,
        name: id,
        cron: '0 3 * * *',
        prompt: 'sweep',
        filePath: `/tasks/${id}/SKILL.md`,
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
        enabled: values.enabled ?? true,
        status: (values.status ?? 'active') as 'active',
        agentId: values.agentId ?? null,
      })
      .run();
  }

  function input(overrides: Partial<WakersOffInput> = {}): WakersOffInput {
    return {
      schedules: readOffSchedules(db),
      agents: [SCOUT, ATLAS],
      heartbeatsEnabled: true,
      heartbeatOf: async () => ({ wake: 'events' as HeartbeatWake, savedAt: null }),
      pauses: [],
      personOf: () => OWNER,
      nameOf: (accountId) => (accountId === OWNER ? 'Dorian' : null),
      ...overrides,
    };
  }

  it('names each schedule that cannot run, why, since when, and who it waits on', async () => {
    schedule('running', {});
    schedule('switched-off', { enabled: false, agentId: SCOUT.id });
    schedule('needs-ok', { status: 'pending_approval' });
    schedule('file-gone', { status: 'paused' });
    // The trigger stamps the time each was written; pinned here so the order is the test's.
    const since = (id: string, at: string) =>
      db.update(pulseSchedules).set({ offSince: at }).where(eq(pulseSchedules.id, id)).run();
    since('switched-off', '2026-11-02T09:00:00.000Z');
    since('needs-ok', '2026-11-04T09:00:00.000Z');
    since('file-gone', '2026-11-03T09:00:00.000Z');

    const { wakers } = await listWakersOff(input());

    // Longest off first.
    expect(wakers.map((waker) => [waker.id, waker.state])).toEqual([
      ['switched-off', 'off'],
      ['file-gone', 'paused'],
      ['needs-ok', 'waiting'],
    ]);
    expect(wakers[0]).toEqual({
      kind: 'schedule',
      id: 'switched-off',
      name: 'switched-off',
      agentId: SCOUT.id,
      state: 'off',
      offSince: '2026-11-02T09:00:00.000Z',
      waitingOn: { accountId: OWNER, name: 'Dorian' },
    });
    expect(wakers.find((waker) => waker.id === 'running')).toBeUndefined();
  });

  it('dates a switched-off heartbeat from its file and asks its agent’s person', async () => {
    const { wakers } = await listWakersOff(
      input({
        heartbeatOf: async (agent) =>
          agent.id === SCOUT.id
            ? { wake: 'off', savedAt: '2026-11-03T08:00:00.000Z' }
            : { wake: 'timed', savedAt: '2026-11-03T08:00:00.000Z' },
        personOf: (agentId) => (agentId === SCOUT.id ? 'person-2' : OWNER),
      })
    );

    expect(wakers).toEqual([
      {
        kind: 'heartbeat',
        id: SCOUT.id,
        name: 'Scout',
        agentId: SCOUT.id,
        state: 'off',
        offSince: '2026-11-03T08:00:00.000Z',
        waitingOn: { accountId: 'person-2', name: null },
      },
    ]);
  });

  it('names a paused agent once, waiting on the person who paused it', async () => {
    const pause: AgentPause = {
      agentId: ATLAS.id,
      pausedBy: { accountId: 'person-3', kind: 'person', name: 'Kai' },
      pausedAt: '2026-11-01T12:00:00.000Z',
    };
    const { wakers } = await listWakersOff(
      input({ pauses: [pause], heartbeatOf: async () => ({ wake: 'off', savedAt: null }) })
    );

    const atlas = wakers.filter((waker) => waker.agentId === ATLAS.id);
    expect(atlas).toEqual([
      expect.objectContaining({
        state: 'paused',
        offSince: '2026-11-01T12:00:00.000Z',
        waitingOn: { accountId: 'person-3', name: 'Kai' },
      }),
    ]);
  });

  it('shows one line for heartbeats off as a whole, with no time, last', async () => {
    schedule('switched-off', { enabled: false });

    const { wakers } = await listWakersOff(input({ heartbeatsEnabled: false }));

    expect(wakers.map((waker) => waker.id)).toEqual(['switched-off', 'all']);
    expect(wakers[1]).toMatchObject({
      kind: 'heartbeat',
      name: 'Every heartbeat',
      offSince: null,
      waitingOn: { accountId: OWNER, name: 'Dorian' },
    });
  });

  it('reads a heartbeat’s wake by the runner’s settings, and its file time when there is one', () => {
    expect(heartbeatWakeOf({ kind: 'absent' }, null)).toEqual({ wake: 'events', savedAt: null });
    expect(
      heartbeatWakeOf({ kind: 'valid', mtimeMs: Date.parse('2026-11-04T00:00:00.000Z') }, {
        wake: 'off',
      } as Parameters<typeof heartbeatWakeOf>[1])
    ).toEqual({ wake: 'off', savedAt: '2026-11-04T00:00:00.000Z' });
  });
});
