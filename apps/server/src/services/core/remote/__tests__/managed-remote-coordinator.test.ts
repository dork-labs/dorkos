/**
 * The managed remote access coordinator (DOR-2086): the enrolment ceremony,
 * mode choice, close and withdrawal, against an offline Cloud answering from
 * the published fixtures, a real config file and a real encrypted store in a
 * temp directory, and a fake tunnel.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import approved from '@dork-labs/cloud-api/fixtures/v1/remote/enrolment-request-approved.json' with { type: 'json' };
import denied from '@dork-labs/cloud-api/fixtures/v1/remote/enrolment-request-denied.json' with { type: 'json' };
import expired from '@dork-labs/cloud-api/fixtures/v1/remote/enrolment-request-expired.json' with { type: 'json' };
import pending from '@dork-labs/cloud-api/fixtures/v1/remote/enrolment-request-pending.json' with { type: 'json' };
import enrolmentRequest from '@dork-labs/cloud-api/fixtures/v1/remote/enrolment-request.json' with { type: 'json' };
import withEdgeProof from '@dork-labs/cloud-api/fixtures/v1/remote/credential-with-edge-proof.json' with { type: 'json' };
import withoutEdgeProof from '@dork-labs/cloud-api/fixtures/v1/remote/credential.json' with { type: 'json' };
import revoked from '@dork-labs/cloud-api/fixtures/v1/remote/credential-revoke.json' with { type: 'json' };
import withdrawn from '@dork-labs/cloud-api/fixtures/v1/remote/enrolment-withdrawn.json' with { type: 'json' };
import alreadyDelivered from '@dork-labs/cloud-api/fixtures/v1/problem/remote-credential-already-delivered.json' with { type: 'json' };
import alreadyEnrolled from '@dork-labs/cloud-api/fixtures/v1/problem/remote-enrolment-already-enrolled.json' with { type: 'json' };
import signedIn from '@dork-labs/cloud-api/fixtures/v1/session/signed-in.json' with { type: 'json' };
import statusClosed from '@dork-labs/cloud-api/fixtures/v1/remote/status-closed.json' with { type: 'json' };

import { initConfigManager } from '../../config-manager.js';
import { EncryptedFileCredentialStore, type CredentialStore } from '../../credential-provider.js';
import { resolveCloudIdentity } from '../../cloud/v1-client.js';
import { ManagedAvailability } from '../managed-availability.js';
import {
  CLOUD_MAY_REMAIN_NOTE,
  MANAGED_REMOTE_ALREADY_SET_UP,
  MANAGED_REMOTE_NOT_SET_UP,
  MANAGED_REMOTE_UNAVAILABLE,
  ManagedRemoteCoordinator,
} from '../managed-remote-coordinator.js';
import { RemoteCredentials } from '../remote-credentials.js';
import { readRemoteState, updateRemoteState } from '../remote-state.js';
import { FakeCloud, problem } from './fake-cloud.js';

const REQUESTS = '/v1/remote/enrolment/requests';
const REQUEST = `${REQUESTS}/${enrolmentRequest.requestId}`;
const ISSUE = '/v1/remote/credentials/issue';
const CONFIRM = '/v1/remote/credentials/confirm';
const REVOKE = '/v1/remote/credentials/revoke';
const ENROLMENT = '/v1/remote/enrolment';
const CONFIRMED = {
  status: 200,
  body: { credentialId: withEdgeProof.credentialId, confirmedAt: '2026-09-15T12:04:00.000Z' },
};

let tmpDir: string;

function fakeTunnel() {
  return {
    status: {
      enabled: false,
      connected: false,
      isRunning: false,
      url: null,
      port: null,
      startedAt: null,
      authEnabled: false,
      tokenConfigured: false,
      domain: null,
    },
    mode: 'off' as 'off' | 'byo' | 'managed',
    getMode() {
      return this.mode;
    },
    getManagedPhase: vi.fn(() => null as null | 'opening' | 'open' | 'draining'),
    getManagedDrain: vi.fn(() => null),
    closeManaged: vi.fn(
      async (_options: { immediate: boolean; drainDeadlineMs?: number; reason?: string }) =>
        undefined
    ),
    stopOwnTunnel: vi.fn(async () => undefined),
    emit: vi.fn(() => true),
  };
}

interface Harness {
  cloud: FakeCloud;
  coordinator: ManagedRemoteCoordinator;
  commands: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  tunnel: ReturnType<typeof fakeTunnel>;
  store: CredentialStore;
  sleeps: number[];
  now: { value: number };
  /** With `manualSleep`, lets the waiting poll run once. */
  release: () => void;
}

/**
 * Build a coordinator over a fake Cloud. `blockSleep` makes every poll wait
 * until the setup is cancelled, so a test can look at a pending setup.
 */
function harness(
  options: {
    flag?: boolean;
    blockSleep?: boolean;
    manualSleep?: boolean;
    store?: CredentialStore;
  } = {}
): Harness {
  const waiting: Array<() => void> = [];
  const cloud = new FakeCloud();
  const tunnel = fakeTunnel();
  const commands = { start: vi.fn(async () => true), stop: vi.fn() };
  const store = options.store ?? new EncryptedFileCredentialStore(tmpDir);
  const sleeps: number[] = [];
  const now = { value: Date.parse('2026-09-15T12:00:00.000Z') };
  let key = 0;
  const availability = new ManagedAvailability({
    flagOn: () => options.flag ?? true,
    captureContext: cloud.capture,
    now: () => now.value,
  });
  const coordinator = new ManagedRemoteCoordinator({
    availability,
    captureContext: cloud.capture,
    resolveIdentity: resolveCloudIdentity,
    readRemoteState,
    updateRemoteState,
    remoteCredentials: new RemoteCredentials(() => store),
    commands,
    tunnel: tunnel as never,
    ownTunnelEnabled: () => false,
    sleep: (ms, signal) => {
      sleeps.push(ms);
      if (options.manualSleep) return new Promise((resolve) => waiting.push(resolve));
      if (!options.blockSleep) return Promise.resolve();
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve()));
    },
    random: () => 0.5,
    now: () => now.value,
    newIdempotencyKey: () => `key-${++key}`,
  });
  return {
    cloud,
    coordinator,
    commands,
    tunnel,
    store,
    sleeps,
    now,
    release: () => waiting.shift()?.(),
  };
}

/** Everything under the temp data directory, as text. */
function everyFile(dir = tmpDir): string {
  let out = '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    out += entry.isDirectory() ? everyFile(full) : fs.readFileSync(full, 'utf-8');
  }
  return out;
}

/** A Cloud that approves at once and issues a credential with an edge proof. */
function approving(cloud: FakeCloud): FakeCloud {
  return cloud
    .on('POST', REQUESTS, { status: 200, body: enrolmentRequest })
    .on('GET', REQUEST, { status: 200, body: approved })
    .on('POST', ISSUE, { status: 200, body: withEdgeProof })
    .on('POST', CONFIRM, CONFIRMED);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-remote-coordinator-'));
  initConfigManager(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('with the switch off', () => {
  it('reports hidden, refuses setup and asks Cloud nothing', async () => {
    const { cloud, coordinator } = harness({ flag: false });
    expect((await coordinator.report()).availability).toBe('hidden');
    const result = await coordinator.startEnrolment();
    expect(result).toMatchObject({ ok: false, code: MANAGED_REMOTE_UNAVAILABLE });
    expect(await coordinator.selectMode('managed')).toMatchObject({ ok: false });
    expect(cloud.calls).toEqual([]);
  });
});

describe('linked but not enrolled', () => {
  it('reports no enrolment and nothing open, and refuses managed mode', async () => {
    const { coordinator } = harness();
    const report = await coordinator.report();
    expect(report).toMatchObject({
      mode: 'off',
      state: 'off',
      availability: 'available',
      enrolment: { status: 'none' },
    });
    expect(await coordinator.selectMode('managed')).toMatchObject({
      ok: false,
      code: MANAGED_REMOTE_NOT_SET_UP,
    });
    expect(readRemoteState().mode).toBe('off');
  });
});

describe('setup', () => {
  it('shows the code and approval page while a person has not answered', async () => {
    const { cloud, coordinator, sleeps } = harness({ blockSleep: true });
    cloud.on('POST', REQUESTS, { status: 200, body: enrolmentRequest });
    expect(await coordinator.startEnrolment()).toEqual({ ok: true });
    expect((await coordinator.report()).enrolment).toEqual({
      status: 'pending',
      userCode: enrolmentRequest.userCode,
      approveUrl: enrolmentRequest.approveUrl,
      expiresAt: enrolmentRequest.expiresAt,
    });
    // Never sooner than Cloud asked.
    expect(sleeps[0]).toBeGreaterThanOrEqual(enrolmentRequest.pollAfterMs);
    expect(cloud.callsTo('POST', REQUESTS)[0]?.body).toBeUndefined();
  });

  it('on approval saves the consent, stores the secrets, confirms, then saves references and hosts', async () => {
    const { cloud, coordinator, store, commands } = harness();
    approving(cloud).on(
      'GET',
      REQUEST,
      { status: 200, body: pending },
      { status: 200, body: approved }
    );
    await coordinator.startEnrolment();
    await coordinator.settled;

    const state = readRemoteState();
    expect(state).toMatchObject({
      mode: 'managed',
      enrolmentId: approved.enrolment.enrolmentId,
      consentVersion: approved.enrolment.consentVersion,
      instanceId: 'inst_0001',
      credentialId: withEdgeProof.credentialId,
      credentialRef: `file:remote-tunnel-${withEdgeProof.credentialId}`,
      edgeProofRef: `file:remote-edge-${withEdgeProof.credentialId}`,
      fingerprint: withEdgeProof.fingerprint,
      hosts: withEdgeProof.hosts,
      edgeProofHeader: withEdgeProof.edgeProof.header,
    });
    // Only now does the command stream start: Cloud's open arrives on it.
    expect(commands.start).toHaveBeenCalledTimes(1);
    expect(await store.get(`remote-tunnel-${withEdgeProof.credentialId}`)).toBe(
      withEdgeProof.value
    );
    expect(await store.get(`remote-edge-${withEdgeProof.credentialId}`)).toBe(
      withEdgeProof.edgeProof.secret
    );
    // Issued for this instance with a fresh key, then confirmed by id.
    expect(cloud.callsTo('POST', ISSUE)[0]?.body).toEqual({
      instanceId: 'inst_0001',
      idempotencyKey: 'key-1',
    });
    expect(cloud.callsTo('POST', CONFIRM)[0]?.body).toEqual({
      credentialId: withEdgeProof.credentialId,
    });
    // No secret anywhere in plain text on disk.
    const disk = everyFile();
    expect(disk).not.toContain(withEdgeProof.value);
    expect(disk).not.toContain(withEdgeProof.edgeProof.secret);
    const report = await coordinator.report();
    expect(report.enrolment).toEqual({ status: 'enrolled' });
    expect(report.state).toBe('asleep');
    expect(report.url).toBe('https://example-instance.remote.invalid');
  });

  it.each([
    ['denied', denied],
    ['expired', expired],
  ] as const)('reports %s as its own state and enrols nothing', async (status, answer) => {
    const { cloud, coordinator } = harness();
    cloud
      .on('POST', REQUESTS, { status: 200, body: enrolmentRequest })
      .on('GET', REQUEST, { status: 200, body: answer });
    await coordinator.startEnrolment();
    await coordinator.settled;
    expect((await coordinator.report()).enrolment).toEqual({ status });
    expect(readRemoteState().enrolmentId).toBeNull();
    expect(cloud.callsTo('POST', ISSUE)).toEqual([]);
  });

  it('reports expired once the request lapses here, without asking again', async () => {
    const { cloud, coordinator, now } = harness();
    cloud.on('POST', REQUESTS, { status: 200, body: enrolmentRequest });
    now.value = Date.parse(enrolmentRequest.expiresAt) + 1;
    await coordinator.startEnrolment();
    await coordinator.settled;
    expect((await coordinator.report()).enrolment).toEqual({ status: 'expired' });
    expect(cloud.callsTo('GET', REQUEST)).toEqual([]);
  });

  it('replaces a pending setup with a new one', async () => {
    const { cloud, coordinator } = harness({ blockSleep: true });
    cloud.on(
      'POST',
      REQUESTS,
      { status: 200, body: enrolmentRequest },
      { status: 200, body: { ...enrolmentRequest, requestId: 'enrq_0002', userCode: 'LMNP-QRST' } }
    );
    await coordinator.startEnrolment();
    await coordinator.startEnrolment();
    expect((await coordinator.report()).enrolment).toMatchObject({ userCode: 'LMNP-QRST' });
  });

  it('issues again with a new key when Cloud says the key was spent', async () => {
    const { cloud, coordinator } = harness();
    approving(cloud).on(
      'POST',
      ISSUE,
      { status: 409, body: alreadyDelivered },
      { status: 200, body: withEdgeProof }
    );
    await coordinator.startEnrolment();
    await coordinator.settled;
    const keys = cloud
      .callsTo('POST', ISSUE)
      .map((call) => (call.body as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toEqual(['key-1', 'key-2']);
    expect(readRemoteState().credentialId).toBe(withEdgeProof.credentialId);
  });

  it('refuses a credential without an edge proof: nothing stored, nothing confirmed', async () => {
    const { cloud, coordinator, store } = harness();
    approving(cloud).on('POST', ISSUE, { status: 200, body: withoutEdgeProof });
    await coordinator.startEnrolment();
    await coordinator.settled;
    expect(cloud.callsTo('POST', CONFIRM)).toEqual([]);
    expect(await store.get(`remote-tunnel-${withoutEdgeProof.credentialId}`)).toBeNull();
    expect(readRemoteState()).toMatchObject({ credentialId: null, credentialRef: null });
    const report = await coordinator.report();
    expect(report.enrolment).toEqual({ status: 'enrolled' });
    expect(report.state).toBe('blocked');
    expect(report.reason).toMatch(/cannot check requests/);
  });

  it('stops before confirming when the store cannot keep the credential', async () => {
    const failing: CredentialStore = {
      get: async () => null,
      put: async () => {
        throw new Error('disk full');
      },
      delete: async () => undefined,
    } as unknown as CredentialStore;
    const { cloud, coordinator } = harness({ store: failing });
    approving(cloud);
    await coordinator.startEnrolment();
    await coordinator.settled;
    expect(cloud.callsTo('POST', CONFIRM)).toEqual([]);
    expect(readRemoteState()).toMatchObject({ credentialId: null, credentialRef: null });
    expect((await coordinator.report()).reason).toMatch(/could not be stored/);
  });

  it('forgets the stored secrets when Cloud does not confirm them', async () => {
    const { cloud, coordinator, store } = harness();
    approving(cloud).on('POST', CONFIRM, problem(503, 'unavailable'));
    await coordinator.startEnrolment();
    await coordinator.settled;
    expect(await store.get(`remote-tunnel-${withEdgeProof.credentialId}`)).toBeNull();
    expect(await store.get(`remote-edge-${withEdgeProof.credentialId}`)).toBeNull();
    expect(readRemoteState()).toMatchObject({ credentialId: null, credentialRef: null });
  });

  it('resumes at the credential when a person approved but setup stopped there', async () => {
    const { cloud, coordinator } = harness();
    approving(cloud).on('POST', ISSUE, problem(503, 'unavailable'));
    await coordinator.startEnrolment();
    await coordinator.settled;
    expect((await coordinator.report()).state).toBe('blocked');

    cloud.on('POST', ISSUE, { status: 200, body: withEdgeProof });
    await coordinator.startEnrolment();
    await coordinator.settled;
    expect(cloud.callsTo('POST', REQUESTS)).toHaveLength(1);
    expect(readRemoteState().credentialId).toBe(withEdgeProof.credentialId);
    expect(await coordinator.startEnrolment()).toMatchObject({
      ok: false,
      code: MANAGED_REMOTE_ALREADY_SET_UP,
    });
  });

  it('says so when Cloud already holds an enrolment, naming withdrawal as the way out', async () => {
    const { cloud, coordinator } = harness();
    cloud.on('POST', REQUESTS, { status: 409, body: alreadyEnrolled });
    const result = await coordinator.startEnrolment();
    expect(result).toMatchObject({ ok: false, code: MANAGED_REMOTE_ALREADY_SET_UP });
    const error = (result as { error: string }).error;
    expect(error).toMatch(/Withdraw/);
    expect(error.split(/\s+/).length).toBeLessThanOrEqual(15);
  });

  it.each([
    ['another request', { ...approved, requestId: 'enrq_9999' }],
    [
      'another consent version',
      { ...approved, enrolment: { ...approved.enrolment, consentVersion: '2099-01-01' } },
    ],
  ])('keeps nothing from an approval of %s', async (_label, answer) => {
    const { cloud, coordinator } = harness();
    approving(cloud).on('GET', REQUEST, { status: 200, body: answer });
    await coordinator.startEnrolment();
    await coordinator.settled;
    expect(readRemoteState().enrolmentId).toBeNull();
    expect(cloud.callsTo('POST', ISSUE)).toEqual([]);
    const report = await coordinator.report();
    expect(report.enrolment).toEqual({ status: 'none' });
    expect(report.reason).toMatch(/different setup/);
    // Cloud may hold an enrolment from it: a withdrawal asks it to forget one.
    await coordinator.withdraw();
    expect(cloud.callsTo('DELETE', ENROLMENT)).toHaveLength(1);
  });

  it('reads hidden after Cloud answers the request route 404', async () => {
    const { cloud, coordinator } = harness();
    cloud.on('POST', REQUESTS, { status: 404 });
    expect(await coordinator.startEnrolment()).toMatchObject({ code: MANAGED_REMOTE_UNAVAILABLE });
    expect((await coordinator.report()).availability).toBe('hidden');
  });
});

describe('stale answers', () => {
  it('keeps nothing from an approval that arrives after an unlink', async () => {
    const { cloud, coordinator, release } = harness({ manualSleep: true });
    approving(cloud);
    await coordinator.startEnrolment();
    cloud.unlink();
    release();
    await coordinator.settled;
    expect(readRemoteState().enrolmentId).toBeNull();
    expect(cloud.callsTo('POST', ISSUE)).toEqual([]);
  });

  it('keeps nothing from A → unlink → A with the same key', async () => {
    const { cloud, coordinator, store } = harness();
    approving(cloud);
    // Relink with the same key between the issue and the store.
    cloud.on('POST', ISSUE, { status: 200, body: withEdgeProof });
    const originalFetch = cloud.fetch;
    let relinked = false;
    (cloud as { fetch: typeof originalFetch }).fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      if (!relinked && new URL(input).pathname === ISSUE) {
        relinked = true;
        cloud.unlink();
        cloud.relink();
      }
      return response;
    };
    await coordinator.startEnrolment();
    await coordinator.settled;
    expect(cloud.callsTo('POST', CONFIRM)).toEqual([]);
    expect(readRemoteState().credentialId).toBeNull();
    expect(await store.get(`remote-tunnel-${withEdgeProof.credentialId}`)).toBeNull();
  });
});

describe('an enrolment from another link', () => {
  async function setUpThenMoveTo(h: Harness, instanceId: string): Promise<void> {
    approving(h.cloud);
    await h.coordinator.startEnrolment();
    h.release();
    await h.coordinator.settled;
    h.cloud.on('GET', '/v1/session', { status: 200, body: { ...signedIn, instanceId } });
    h.cloud.on('GET', '/v1/remote/status', {
      status: 200,
      body: { ...statusClosed, instanceId },
    });
    h.cloud.relink('instance-key-b');
  }

  it('reads as not enrolled, is narrowed, and cannot be chosen', async () => {
    const h = harness({ manualSleep: true });
    await setUpThenMoveTo(h, 'inst_0002');
    const report = await h.coordinator.report();
    expect(report).toMatchObject({ mode: 'off', state: 'off', enrolment: { status: 'none' } });
    expect(readRemoteState()).toMatchObject({ mode: 'off', enrolmentId: null, instanceId: null });
    expect(await h.coordinator.selectMode('managed')).toMatchObject({
      ok: false,
      code: MANAGED_REMOTE_NOT_SET_UP,
    });
  });

  it('is not resumed by a setup under the new link: that one asks Cloud afresh', async () => {
    const h = harness({ manualSleep: true });
    await setUpThenMoveTo(h, 'inst_0002');
    h.cloud.on('GET', REQUEST, { status: 200, body: pending });
    expect(await h.coordinator.startEnrolment()).toEqual({ ok: true });
    expect(h.cloud.callsTo('POST', REQUESTS)).toHaveLength(2);
    expect(readRemoteState().enrolmentId).toBeNull();
  });
});

describe('mode', () => {
  async function setUp(h: Harness): Promise<void> {
    approving(h.cloud);
    await h.coordinator.startEnrolment();
    await h.coordinator.settled;
  }

  it('choosing their own tunnel closes managed access at once', async () => {
    const h = harness();
    await setUp(h);
    expect(await h.coordinator.selectMode('byo')).toEqual({ ok: true });
    expect(readRemoteState().mode).toBe('byo');
    expect(h.tunnel.closeManaged).toHaveBeenCalledWith({ immediate: true, reason: 'mode_change' });
  });

  it('choosing managed needs Cloud to be reachable now, not just the switch on', async () => {
    const h = harness();
    await setUp(h);
    await h.coordinator.selectMode('off');
    h.cloud.on('GET', '/v1/remote/status', { networkError: true });
    h.cloud.relink();
    expect(await h.coordinator.selectMode('managed')).toMatchObject({
      ok: false,
      code: MANAGED_REMOTE_UNAVAILABLE,
    });
    expect(readRemoteState().mode).toBe('off');
  });

  it('choosing managed closes their own tunnel so the two never run together', async () => {
    const h = harness();
    await setUp(h);
    await h.coordinator.selectMode('off');
    h.tunnel.mode = 'byo';
    expect(await h.coordinator.selectMode('managed')).toEqual({ ok: true });
    expect(h.tunnel.stopOwnTunnel).toHaveBeenCalled();
    expect(readRemoteState().mode).toBe('managed');
  });
});

describe('close', () => {
  it('drains under the local default deadline, named as local, rather than a timer of its own', () => {
    const h = harness();
    h.tunnel.getManagedPhase.mockReturnValue('open');
    h.coordinator.close();
    expect(h.tunnel.closeManaged).toHaveBeenCalledTimes(1);
    // No deadline given: the ingress applies MANAGED_DRAIN_DEADLINE_MS and the report says local.
    expect(h.tunnel.closeManaged).toHaveBeenCalledWith({ immediate: false, reason: 'closed_here' });
  });

  it('does nothing when managed access is not open', () => {
    const h = harness();
    h.tunnel.getManagedPhase.mockReturnValue(null);
    h.coordinator.close();
    expect(h.tunnel.closeManaged).not.toHaveBeenCalled();
  });
});

describe('withdrawal', () => {
  it('is local first and stays withdrawn when Cloud is down, saying Cloud may keep a record', async () => {
    const h = harness();
    approving(h.cloud);
    await h.coordinator.startEnrolment();
    await h.coordinator.settled;
    h.cloud
      .on('POST', REVOKE, { networkError: true })
      .on('DELETE', ENROLMENT, { networkError: true });

    const outcome = h.coordinator.withdraw();
    // Synchronous: before any Cloud answer, everything local is already done.
    expect(h.commands.stop).toHaveBeenCalled();
    expect(readRemoteState()).toMatchObject({
      mode: 'off',
      enrolmentId: null,
      credentialId: null,
      credentialRef: null,
      hosts: [],
    });
    expect(h.tunnel.closeManaged).toHaveBeenCalledWith({ immediate: true, reason: 'withdrawn' });
    expect(h.cloud.callsTo('POST', REVOKE)).toHaveLength(1);
    expect(h.cloud.callsTo('DELETE', ENROLMENT)).toHaveLength(1);

    expect(await outcome).toBe('may_remain');
    expect(readRemoteState().enrolmentId).toBeNull();
    expect(await h.store.get(`remote-tunnel-${withEdgeProof.credentialId}`)).toBeNull();
    const report = await h.coordinator.report();
    expect(report).toMatchObject({ mode: 'off', enrolment: { status: 'none' } });
    expect(report.reason).toBe(CLOUD_MAY_REMAIN_NOTE);
  });

  it('reports done when Cloud revoked and forgot', async () => {
    const h = harness();
    approving(h.cloud);
    await h.coordinator.startEnrolment();
    await h.coordinator.settled;
    h.cloud.on('POST', REVOKE, { status: 200, body: revoked }).on('DELETE', ENROLMENT, {
      status: 200,
      body: withdrawn,
    });
    expect(await h.coordinator.withdraw()).toBe('done');
    expect((await h.coordinator.report()).reason).toBeUndefined();
  });

  it('cancels a pending setup, and a later approval changes nothing', async () => {
    const h = harness({ blockSleep: true });
    h.cloud
      .on('POST', REQUESTS, { status: 200, body: enrolmentRequest })
      .on('GET', REQUEST, { status: 200, body: approved });
    await h.coordinator.startEnrolment();
    await h.coordinator.withdraw();
    await h.coordinator.settled;
    expect((await h.coordinator.report()).enrolment).toEqual({ status: 'none' });
    expect(h.cloud.callsTo('GET', REQUEST)).toEqual([]);
    expect(readRemoteState().enrolmentId).toBeNull();
    // Cloud is asked to forget any enrolment the request may still produce.
    expect(h.cloud.callsTo('DELETE', ENROLMENT)).toHaveLength(1);
  });

  it('asks Cloud again later, under the same link, and clears the note once it answers', async () => {
    const h = harness({ manualSleep: true });
    approving(h.cloud).on('GET', REQUEST, { status: 200, body: approved });
    await h.coordinator.startEnrolment();
    h.release();
    await h.coordinator.settled;
    h.cloud
      .on('POST', REVOKE, { networkError: true })
      .on('DELETE', ENROLMENT, { networkError: true });
    expect(await h.coordinator.withdraw()).toBe('may_remain');
    expect((await h.coordinator.report()).reason).toBe(CLOUD_MAY_REMAIN_NOTE);

    h.cloud.on('POST', REVOKE, { status: 200, body: revoked }).on('DELETE', ENROLMENT, {
      status: 200,
      body: withdrawn,
    });
    h.release();
    await h.coordinator.cleanupSettled;
    expect(h.cloud.callsTo('POST', REVOKE)).toHaveLength(2);
    expect(h.cloud.callsTo('DELETE', ENROLMENT)).toHaveLength(2);
    expect(h.cloud.callsTo('POST', REVOKE)[1]?.authorization).toBe('Bearer instance-key-a');
    expect((await h.coordinator.report()).reason).toBeUndefined();
    // Nothing local came back.
    expect(readRemoteState()).toMatchObject({ mode: 'off', enrolmentId: null, credentialId: null });
  });

  it('abandons the retry once the link it was owed under ends, keeping the note', async () => {
    const h = harness({ manualSleep: true });
    approving(h.cloud);
    await h.coordinator.startEnrolment();
    h.release();
    await h.coordinator.settled;
    h.cloud
      .on('POST', REVOKE, { networkError: true })
      .on('DELETE', ENROLMENT, { networkError: true });
    expect(await h.coordinator.withdraw()).toBe('may_remain');
    h.cloud.unlink();
    h.cloud.relink('instance-key-b');
    h.cloud.on('POST', REVOKE, { status: 200, body: revoked });
    h.release();
    await h.coordinator.cleanupSettled;
    expect(h.cloud.callsTo('POST', REVOKE)).toHaveLength(1);
    expect(h.cloud.calls.some((call) => call.authorization === 'Bearer instance-key-b')).toBe(
      false
    );
    expect((await h.coordinator.report()).reason).toBe(CLOUD_MAY_REMAIN_NOTE);
  });

  it('stops the retry when a person starts setup again', async () => {
    const h = harness({ manualSleep: true });
    approving(h.cloud);
    await h.coordinator.startEnrolment();
    h.release();
    await h.coordinator.settled;
    h.cloud
      .on('POST', REVOKE, { networkError: true })
      .on('DELETE', ENROLMENT, { networkError: true });
    await h.coordinator.withdraw();
    const retry = h.coordinator.cleanupSettled;
    h.cloud.on('GET', REQUEST, { status: 200, body: pending });
    await h.coordinator.startEnrolment();
    h.release();
    await retry;
    expect(h.cloud.callsTo('DELETE', ENROLMENT)).toHaveLength(1);
  });

  it('never rejects when a status listener throws', async () => {
    const h = harness();
    h.tunnel.emit.mockImplementation(() => {
      throw new Error('listener failed');
    });
    approving(h.cloud);
    await h.coordinator.startEnrolment().catch(() => undefined);
    await h.coordinator.settled;
    h.cloud.on('POST', REVOKE, { status: 200, body: revoked }).on('DELETE', ENROLMENT, {
      status: 200,
      body: withdrawn,
    });
    await expect(h.coordinator.withdraw()).resolves.toBe('done');
  });

  it('on unlink asks Cloud to forget an enrolment it said it holds', async () => {
    const h = harness();
    h.cloud
      .on('POST', REQUESTS, { status: 409, body: alreadyEnrolled })
      .on('DELETE', ENROLMENT, { status: 200, body: withdrawn });
    await h.coordinator.startEnrolment();
    await h.coordinator.withdrawOnUnlink();
    expect(h.cloud.callsTo('DELETE', ENROLMENT)).toHaveLength(1);
  });

  it('on unlink with nothing managed, asks Cloud nothing', async () => {
    const h = harness();
    expect(await h.coordinator.withdrawOnUnlink()).toBe('done');
    expect(h.cloud.calls).toEqual([]);
    expect(h.commands.stop).toHaveBeenCalledTimes(1);
  });

  it('on unlink sends its Cloud calls under the old key before the link is cleared', async () => {
    const h = harness();
    approving(h.cloud);
    await h.coordinator.startEnrolment();
    await h.coordinator.settled;
    const outcome = h.coordinator.withdrawOnUnlink();
    // The link clears its key right after the unlink step's synchronous part.
    h.cloud.unlink();
    await outcome;
    const revoke = h.cloud.callsTo('POST', REVOKE)[0];
    expect(revoke?.authorization).toBe('Bearer instance-key-a');
  });
});
