/**
 * How a hub takes its assignment: every case in `hub-assignment-sync.ts`, and
 * where each case leaves the hub. The owner account is made
 * through real Better Auth, so the registration policy's `provisioning` seam
 * is exercised rather than assumed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudApiProblemError } from '@dork-labs/cloud-api/client';
import type { HubAssignment } from '@dork-labs/cloud-api';
import { createDb, runMigrations, session, user, type Db } from '@dorkos/db';

const role = vi.hoisted(() => ({ value: 'hub' as 'computer' | 'hub' }));
vi.mock('../../../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));

const { createAuth, initAuth } = await import('../../auth/index.js');
const { initConfigManager } = await import('../../config-manager.js');
const { withRegistrationCaller } = await import('../../auth/registration-policy.js');
const sync = await import('../hub-assignment-sync.js');
const serving = await import('../hub-serving.js');
const runner = await import('../hub-assignment-runner.js');
const signingKey = await import('../hub-signing-key.js');

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
  let read: () => Promise<unknown>;
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
    signingKey.resetHubSigningKeyForTests();
    db = createDb(path.join(tmpDir, `auth-${Math.random().toString(36).slice(2)}.db`));
    runMigrations(db);
    dorkHome = fs.mkdtempSync(path.join(tmpDir, 'home-'));
    read = async () => ASSIGNED;
    confirmed = [];
  });

  /** The live wiring over this case's database and data dir, with a fake Cloud. */
  function deps(): import('../hub-assignment-sync.js').HubAssignmentSyncDeps {
    initAuth(db, tmpDir);
    return runner.liveHubDeps(dorkHome, {
      readAssignment: () => read(),
      confirm: async (id) => void confirmed.push(id),
    });
  }

  it('stays pooled with no owner, and takes Cloud`s wait', async () => {
    read = async () => ({ state: 'pooled', pollAfterSeconds: 7 });
    expect(await sync.syncHubAssignment(deps())).toEqual({ kind: 'pooled', pollAfterSeconds: 7 });
    expect(db.select().from(user).all()).toHaveLength(0);
    expect(serving.hubServingState().state).not.toBe('serving');
    expect(runner.nextHubBeatMs({ kind: 'pooled', pollAfterSeconds: 7 })).toBe(7_000);
  });

  it('reports the public half of its signing key when it confirms, the same key each time', async () => {
    const sent: (string | undefined)[] = [];
    initAuth(db, tmpDir);
    const d = runner.liveHubDeps(dorkHome, {
      readAssignment: () => read(),
      confirm: async (id, signingPublicKey) => void sent.push(signingPublicKey),
    });
    await sync.syncHubAssignment(d);
    read = async () => ({ ...ASSIGNED, assignmentId: 'asg_2' });
    await sync.syncHubAssignment(d);
    expect(sent[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sent[1]).toBe(sent[0]);
  });

  it('refuses, rather than make a new key, when a pinned hub has lost its own', async () => {
    const d = deps();
    await sync.syncHubAssignment(d);
    fs.rmSync(path.join(dorkHome, signingKey.HUB_SIGNING_KEY_FILE));
    signingKey.resetHubSigningKeyForTests();
    serving.resetHubServingStateForTests();
    expect(await sync.syncHubAssignment(d)).toEqual({ kind: 'refused' });
    expect(fs.existsSync(path.join(dorkHome, signingKey.HUB_SIGNING_KEY_FILE))).toBe(false);
  });

  it('stops for good when Cloud holds a different signing key for it', async () => {
    let calls = 0;
    initAuth(db, tmpDir);
    const d = runner.liveHubDeps(dorkHome, {
      readAssignment: () => read(),
      confirm: async () => {
        calls += 1;
        throw new CloudApiProblemError({
          type: 'about:blank',
          code: 'precondition_failed',
          status: 412,
          title: 'Different key',
        } as never);
      },
    });
    expect(await sync.syncHubAssignment(d)).toEqual({ kind: 'refused' });
    expect(serving.hubServingState()).toEqual({ state: 'refused' });
    expect(calls).toBe(1);
    // No retries: a refused hub's beat stops.
    expect(runner.nextHubBeatMs({ kind: 'refused' })).toBeNull();
  });

  it('refuses when its signing key file cannot be read', async () => {
    const d = deps();
    await sync.syncHubAssignment(d);
    fs.writeFileSync(path.join(dorkHome, signingKey.HUB_SIGNING_KEY_FILE), 'not a key');
    signingKey.resetHubSigningKeyForTests();
    serving.resetHubServingStateForTests();
    expect(await sync.syncHubAssignment(d)).toEqual({ kind: 'refused' });
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
    // Nobody signed in: the owner only ever signs in with their DorkOS account.
    expect(db.select().from(session).all()).toHaveLength(0);
    expect(sync.readHubOwnerPin(dorkHome)).toMatchObject({
      ownerAccountId: 'acct_1',
      issuer: 'https://accounts.example.invalid',
    });
    expect(confirmed).toEqual(['asg_1']);
    expect(serving.hubServingState().state).toBe('serving');
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
      expect(serving.hubServingState().state).not.toBe('serving');
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
    // What a crash right after pinning leaves: the key, made first, and the pin.
    signingKey.ensureHubSigningKey(dorkHome);
    signingKey.resetHubSigningKeyForTests();
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
    expect(serving.hubServingState().state).not.toBe('serving');
    expect(runner.nextHubBeatMs({ kind: 'ended' })).toBeNull();
  });

  it('changes nothing when Cloud cannot be reached', async () => {
    const d = deps();
    await sync.syncHubAssignment(d);
    read = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await sync.syncHubAssignment(d)).toEqual({ kind: 'unchanged', reason: 'failed' });
    expect(serving.hubServingState().state).toBe('serving');
  });

  it('stops serving, but not for good, on an answer it does not understand', async () => {
    const d = deps();
    await sync.syncHubAssignment(d);
    read = async () => ({ state: 'suspended' });
    expect(await sync.syncHubAssignment(d)).toEqual({ kind: 'unchanged', reason: 'unreadable' });
    expect(serving.hubServingState().state).not.toBe('serving');
    read = async () => ASSIGNED;
    expect(await sync.syncHubAssignment(d)).toEqual({ kind: 'serving', assignmentId: 'asg_1' });
  });

  it('leaves no pin behind a write that never finished', () => {
    sync.writeHubOwnerPin(dorkHome, {
      ownerAccountId: 'acct_1',
      issuer: 'https://accounts.example.invalid',
      pinnedAt: '2026-11-03T09:00:00Z',
    });
    expect(fs.readdirSync(dorkHome)).toEqual([sync.HUB_OWNER_PIN_FILE]);
  });

  it('refuses when the pin file cannot be read, rather than taking a new owner', async () => {
    fs.writeFileSync(path.join(dorkHome, sync.HUB_OWNER_PIN_FILE), 'not json');
    expect(await sync.syncHubAssignment(deps())).toEqual({ kind: 'refused' });
  });
});
