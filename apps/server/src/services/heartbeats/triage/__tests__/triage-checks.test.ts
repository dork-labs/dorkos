/**
 * What the Heartbeat page says about checks, and the credits offer's one
 * notification (spec `heartbeats` §6.3, §7.6).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { HeartbeatStore } from '../../heartbeat-store.js';
import {
  checksStatus,
  checksToday,
  notifyOfferOnce,
  offerOpen,
  requestsTodayUtc,
} from '../triage-checks.js';

let db: Db;
let store: HeartbeatStore;

/** A finished beat whose triage carries these rung-1 steps. */
function beat(id: string, startedAt: string, steps: unknown[]) {
  store.insertBeat({ id, agentId: 'agent-juno', startedAt, kind: 'pulse', wake: 'timer' });
  store.finishBeat(id, { outcome: 'quiet', triage: JSON.stringify({ rung: 'model', steps }) });
}

const CHECK = {
  rung: 1,
  model: 'small-1',
  requests: 1,
  usage: { inputTokens: 100, outputTokens: 5 },
};

beforeEach(() => {
  db = createTestDb();
  store = new HeartbeatStore(db);
});

describe('checksToday', () => {
  it('counts rung-1 checks and their tokens in the person’s day only', () => {
    const now = new Date('2026-10-12T22:00:00Z'); // 18:00 in New York
    beat('today-1', '2026-10-12T13:00:00Z', [{ rung: 0 }, CHECK]);
    beat('today-2', '2026-10-12T21:00:00Z', [{ rung: 0 }, CHECK]);
    // 23:30 the evening before in New York: yesterday there, though the same UTC day.
    beat('yesterday', '2026-10-12T03:30:00Z', [CHECK]);
    // Skipped by the fuse, never sent (the token was gone), and a rules-only
    // beat: none of them is a check.
    beat('fused', '2026-10-12T14:00:00Z', [{ rung: 1, skipped: 'fuse' }]);
    beat('unsent', '2026-10-12T14:30:00Z', [{ rung: 1, failure: 'outage', requests: 0 }]);
    store.insertBeat({
      id: 'rules',
      agentId: 'agent-juno',
      startedAt: '2026-10-12T15:00:00Z',
      kind: 'pulse',
      wake: 'timer',
    });
    store.finishBeat('rules', { outcome: 'quiet', triage: '{"rung":"rules","verdict":"quiet"}' });
    expect(checksToday(db, 'agent-juno', now, 'America/New_York')).toEqual({
      checks: 2,
      tokens: 210,
    });
    expect(checksToday(db, 'agent-other', now, 'America/New_York')).toEqual({
      checks: 0,
      tokens: 0,
    });
  });
});

describe('requestsTodayUtc', () => {
  it('sums requests sent today in UTC, an ask-twice counting two', () => {
    beat('a', '2026-10-12T01:00:00Z', [CHECK]);
    beat('b', '2026-10-12T13:00:00Z', [{ ...CHECK, requests: 2 }]);
    beat('c', '2026-10-11T23:00:00Z', [CHECK]);
    beat('d', '2026-10-12T14:00:00Z', [{ rung: 1, failure: 'outage', requests: 0 }]);
    expect(requestsTodayUtc(db, new Date('2026-10-12T22:00:00Z'))).toBe(3);
  });
});

describe('the offer', () => {
  it('stands only while nobody answered and credits can be had', () => {
    expect(offerOpen(null, true, true)).toBe(true);
    expect(offerOpen(undefined, true, true)).toBe(true);
    expect(offerOpen(true, true, true)).toBe(false);
    expect(offerOpen(false, true, true)).toBe(false);
    expect(offerOpen(null, false, true)).toBe(false);
  });

  it('is not spent while heartbeats are off', () => {
    expect(offerOpen(null, true, false)).toBe(false);
  });

  it('is drawn for the owner only', () => {
    const input = {
      runsOn: 'runtime' as const,
      runtime: 'codex',
      today: { checks: 0, tokens: 0 },
      offerOpen: true,
    };
    expect(checksStatus({ ...input, viewerIsOwner: true }).offer).toBe(true);
    expect(checksStatus({ ...input, viewerIsOwner: false }).offer).toBe(false);
  });

  describe('its notification', () => {
    let home: string;
    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), 'credits-offer-'));
    });
    afterEach(async () => {
      await rm(home, { recursive: true, force: true });
    });

    it('is raised once on this computer, across restarts', async () => {
      const notify = vi.fn().mockResolvedValue(undefined);
      const deps = { dorkHome: home, open: () => true, notify, nowIso: () => 'now' };
      expect(await notifyOfferOnce(deps)).toBe(true);
      expect(await notifyOfferOnce(deps)).toBe(false);
      // A fresh process reads the same file.
      expect(await notifyOfferOnce({ ...deps })).toBe(false);
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it('is not raised while the offer does not stand', async () => {
      const notify = vi.fn();
      expect(
        await notifyOfferOnce({ dorkHome: home, open: () => false, notify, nowIso: () => 'now' })
      ).toBe(false);
      expect(notify).not.toHaveBeenCalled();
    });
  });
});
