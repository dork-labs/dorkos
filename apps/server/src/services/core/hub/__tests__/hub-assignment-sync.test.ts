/**
 * How a hub takes its assignment: every case in `hub-assignment-sync.ts`, and
 * the gate that refuses requests until it serves. The owner account is made
 * through real Better Auth, so the registration policy's `provisioning` seam
 * is exercised rather than assumed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudApiProblemError } from '@dork-labs/cloud-api/client';
import type { HubAssignment } from '@dork-labs/cloud-api';
import { createDb, runMigrations, user, type Db } from '@dorkos/db';

const role = vi.hoisted(() => ({ value: 'hub' as 'computer' | 'hub' }));
vi.mock('../../../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));

const { createAuth } = await import('../../auth/index.js');
const { initConfigManager } = await import('../../config-manager.js');
const { withRegistrationCaller } = await import('../../auth/registration-policy.js');
const sync = await import('../hub-assignment-sync.js');
const serving = await import('../hub-serving.js');
const runner = await import('../hub-assignment-runner.js');

const ASSIGNED: HubAssignment = {
  state: 'assigned',
  assignmentId: 'asg_1',
  assignedAt: '2026-11-03T09:00:00Z',
  ownerAccountId: 'acct_1',
  issuer: 'https://accounts.example.invalid',
  address: 'https://hub-1.example.invalid',
  frontDoorProof: { header: 'x-example-proof', secret: 's'.repeat(40) },
};

describe('a hub taking its assignment', () => {
  let tmpDir: string;
  let db: Db;
  let dorkHome: string;
  let read: () => Promise<HubAssignment | null>;
  let confirmed: string[];

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-hub-'));
    initConfigManager(tmpDir);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    role.value = 'hub';
    serving.resetHubServingStateForTests();
    db = createDb(path.join(tmpDir, `auth-${Math.random().toString(36).slice(2)}.db`));
    runMigrations(db);
    dorkHome = fs.mkdtempSync(path.join(tmpDir, 'home-'));
    read = async () => ASSIGNED;
    confirmed = [];
  });

  /** The live wiring, over this case's database, data dir and fake Cloud. */
  function deps(): import('../hub-assignment-sync.js').HubAssignmentSyncDeps {
    const auth = createAuth(db, tmpDir);
    return {
      readAssignment: () => read(),
      confirm: async (id) => void confirmed.push(id),
      ownerExists: () => db.select().from(user).all().length > 0,
      createOwner: async (body) => {
        await withRegistrationCaller('provisioning', () => auth.api.signUpEmail({ body }));
      },
      readPin: () => sync.readHubOwnerPin(dorkHome),
      writePin: (pin) => sync.writeHubOwnerPin(dorkHome, pin),
    };
  }

  it('refuses every request but the health check until it serves', () => {
    expect(serving.hubRefusesRequest('/api/config')).toBe(true);
    expect(serving.hubRefusesRequest('/')).toBe(true);
    expect(serving.hubRefusesRequest('/api/health')).toBe(false);
  });

  it('never refuses anything on a person`s own computer', () => {
    role.value = 'computer';
    expect(serving.hubRefusesRequest('/api/config')).toBe(false);
  });

  it('stays pooled with no owner, and takes Cloud`s wait', async () => {
    read = async () => ({ state: 'pooled', pollAfterSeconds: 7 });
    expect(await sync.syncHubAssignment(deps())).toEqual({ kind: 'pooled', pollAfterSeconds: 7 });
    expect(db.select().from(user).all()).toHaveLength(0);
    expect(serving.hubRefusesRequest('/api/config')).toBe(true);
    expect(runner.nextHubBeatMs({ kind: 'pooled', pollAfterSeconds: 7 })).toBe(7_000);
  });

  it('pins the owner, makes the owner account, confirms, then serves', async () => {
    expect(await sync.syncHubAssignment(deps())).toEqual({
      kind: 'serving',
      assignmentId: 'asg_1',
    });
    const owners = db.select().from(user).all();
    expect(owners).toHaveLength(1);
    expect(owners[0]?.role).toBe('owner');
    expect(owners[0]?.email).toBe('owner@hub-1.example.invalid');
    expect(sync.readHubOwnerPin(dorkHome)).toMatchObject({
      ownerAccountId: 'acct_1',
      issuer: 'https://accounts.example.invalid',
    });
    expect(confirmed).toEqual(['asg_1']);
    expect(serving.hubRefusesRequest('/api/config')).toBe(false);
    expect(serving.hubServingState()).toMatchObject({ state: 'serving' });
  });

  it('takes new keys for the same owner without a second account', async () => {
    const d = deps();
    await sync.syncHubAssignment(d);
    read = async () => ({
      ...ASSIGNED,
      assignmentId: 'asg_2',
      address: 'https://hub-2.example.invalid',
    });
    expect(await sync.syncHubAssignment(d)).toEqual({ kind: 'serving', assignmentId: 'asg_2' });
    expect(db.select().from(user).all()).toHaveLength(1);
    expect(confirmed).toEqual(['asg_1', 'asg_2']);
  });

  it('refuses for good when Cloud names a different owner or issuer', async () => {
    for (const changed of [
      { ownerAccountId: 'acct_2' },
      { issuer: 'https://other.example.invalid' },
    ]) {
      serving.resetHubServingStateForTests();
      fs.rmSync(path.join(dorkHome, sync.HUB_OWNER_PIN_FILE), { force: true });
      db = createDb(path.join(tmpDir, `auth-${Math.random().toString(36).slice(2)}.db`));
      runMigrations(db);
      const fresh = deps();
      read = async () => ASSIGNED;
      await sync.syncHubAssignment(fresh);
      read = async () => ({ ...ASSIGNED, assignmentId: 'asg_3', ...changed });
      expect(await sync.syncHubAssignment(fresh)).toEqual({ kind: 'refused' });
      expect(serving.hubRefusesRequest('/api/config')).toBe(true);
      // It stays refused even if Cloud puts the old owner back.
      read = async () => ASSIGNED;
      await sync.syncHubAssignment(fresh);
      expect(serving.hubServingState()).toEqual({ state: 'refused' });
    }
  });

  it('refuses when an assigned hub is reported pooled again', async () => {
    const d = deps();
    await sync.syncHubAssignment(d);
    read = async () => ({ state: 'pooled' });
    expect(await sync.syncHubAssignment(d)).toEqual({ kind: 'refused' });
  });

  it('refuses a hub that holds an account it never pinned', async () => {
    const auth = createAuth(db, tmpDir);
    await withRegistrationCaller('provisioning', () =>
      auth.api.signUpEmail({
        body: { email: 'someone@example.invalid', password: 'correct-horse-battery', name: 'X' },
      })
    );
    expect(await sync.syncHubAssignment(deps())).toEqual({ kind: 'refused' });
    expect(confirmed).toEqual([]);
  });

  it('makes the owner account on the next sync if it crashed after pinning', async () => {
    sync.writeHubOwnerPin(dorkHome, {
      ownerAccountId: 'acct_1',
      issuer: 'https://accounts.example.invalid',
      pinnedAt: '2026-11-03T09:00:00Z',
    });
    expect(await sync.syncHubAssignment(deps())).toEqual({
      kind: 'serving',
      assignmentId: 'asg_1',
    });
    expect(db.select().from(user).all()).toHaveLength(1);
  });

  it('stops serving when the assignment ends', async () => {
    const d = deps();
    await sync.syncHubAssignment(d);
    read = async () => {
      throw new CloudApiProblemError({
        type: 'about:blank',
        code: 'not_found',
        status: 404,
        title: 'Not found',
      } as never);
    };
    expect(await sync.syncHubAssignment(d)).toEqual({ kind: 'ended' });
    expect(serving.hubRefusesRequest('/api/config')).toBe(true);
    expect(runner.nextHubBeatMs({ kind: 'ended' })).toBeNull();
  });

  it('changes nothing when Cloud cannot be reached', async () => {
    const d = deps();
    await sync.syncHubAssignment(d);
    read = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await sync.syncHubAssignment(d)).toEqual({ kind: 'unchanged', reason: 'failed' });
    expect(serving.hubRefusesRequest('/api/config')).toBe(false);
  });

  it('refuses when the pin file cannot be read, rather than taking a new owner', async () => {
    fs.writeFileSync(path.join(dorkHome, sync.HUB_OWNER_PIN_FILE), 'not json');
    expect(await sync.syncHubAssignment(deps())).toEqual({ kind: 'refused' });
  });
});
