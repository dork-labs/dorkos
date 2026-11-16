/**
 * The live wakers-off reader (DOR-3641): heartbeats count as off only by the
 * person's own switch, a global schedule waits on the owner, and the owner's
 * name comes from their profile.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { pulseSchedules, type Db } from '@dorkos/db';
import { configManager, initConfigManager } from '../../../core/config-manager.js';
import { liveWakersOffReader } from '../live-wakers-off.js';

const OWNER = 'owner-account';

describe('liveWakersOffReader', () => {
  let db: Db;
  let dorkHome: string;

  beforeEach(async () => {
    db = createTestDb();
    dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'wakers-off-live-'));
    // The real config, in a throwaway home.
    initConfigManager(dorkHome);
    configManager.set('profile', { ...configManager.get('profile'), displayName: 'Dorian' });
  });

  afterEach(async () => {
    await fs.rm(dorkHome, { recursive: true, force: true });
  });

  function reader() {
    return liveWakersOffReader({
      db,
      agents: { list: () => [] },
      store: { getState: () => undefined },
      chain: {
        resolveChainPerson: () => ({ kind: 'person', accountId: 'person-2', source: 'reportsTo' }),
      },
      ownerAccountId: () => OWNER,
      isOwner: (accountId) => accountId === OWNER,
    });
  }

  it('shows "Every heartbeat" only when the person’s own switch is off', async () => {
    configManager.set('heartbeats', { ...configManager.get('heartbeats'), enabled: true });
    expect((await reader().list()).wakers).toEqual([]);

    configManager.set('heartbeats', { ...configManager.get('heartbeats'), enabled: false });
    expect((await reader().list()).wakers).toEqual([
      expect.objectContaining({ id: 'all', waitingOn: { accountId: OWNER, name: 'Dorian' } }),
    ]);
  });

  it('has a global schedule wait on the owner by their profile name, and an agent’s on its person', async () => {
    configManager.set('heartbeats', { ...configManager.get('heartbeats'), enabled: true });
    for (const [id, agentId] of [
      ['global', null],
      ['scouts', 'agent-scout'],
    ] as const) {
      db.insert(pulseSchedules)
        .values({
          id,
          name: id,
          cron: '0 3 * * *',
          prompt: 'sweep',
          filePath: `/tasks/${id}/SKILL.md`,
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-01T00:00:00.000Z',
          enabled: false,
          agentId,
        })
        .run();
    }

    const { wakers } = await reader().list();

    expect(Object.fromEntries(wakers.map((waker) => [waker.id, waker.waitingOn]))).toEqual({
      global: { accountId: OWNER, name: 'Dorian' },
      // Nobody else's name is known here.
      scouts: { accountId: 'person-2', name: null },
    });
  });
});
