/**
 * Standalone proof: a self-hosted Community works with no outbound network
 * access, so it has no DorkOS Cloud dependency (spec
 * `community-tenancy-contract`, identity model and task 4.2: "The service works
 * with Cloud egress unavailable").
 *
 * Before any Community code opens a socket, this file wraps every TCP/TLS
 * connect, every DNS lookup and direct DNS query (`dns.resolve*`, `Resolver`,
 * both callback and promise forms), and every UDP send or connect in the
 * process. Loopback and the test database
 * host stay reachable; anything else is recorded and refused, exactly as a
 * firewall that blocks all egress would. The whole first-install to
 * two-community journey then runs through the real server, and the recorded
 * list must be empty at the end. The guard blocks every non-local host, which
 * is strictly stronger than blocking DorkOS Cloud alone.
 */
import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { recoverPassword } from '../recover-password.js';
import { sweepExpiredAttachments } from '../routes/attachments.js';
import { sweepExpiredExports } from '../routes/exports.js';
import { sweepExpiredAdmissions } from '../routes/invites.js';
import { sweepPendingBlobDeletions } from '../storage/pending-deletions.js';
import { sweepCommunityDeletions, sweepCommunityDeletionTombstones } from '../deletion-worker.js';
import { responseCookies } from './bootstrap-test-helper.js';
import {
  TENANCY_PASSWORD,
  admit,
  bootstrapHost,
  claimAsNewAccount,
  createPendingCommunity,
  expectStatus,
  startTenancyHarness,
  type TenancyHarness,
} from './tenancy-test-harness.js';

// ---- the egress guard, installed at module evaluation, before any socket opens ----

const databaseHost = new URL(process.env.COMMUNITY_TEST_DATABASE_URL ?? 'postgres://localhost')
  .hostname;
const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]', databaseHost]);
/** Every outbound attempt the guard refused, as `kind host:port`. */
const refused: string[] = [];

function isLocal(host: string | undefined): boolean {
  return host === undefined || host === '' || localHosts.has(host) || host.startsWith('127.');
}

function connectTarget(args: unknown[]): { host?: string; port?: unknown; path?: string } {
  // net.connect() hands Socket#connect its normalized arguments as one array.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === 'object') return first as { host?: string; path?: string };
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first)))
    return { port: first, host: typeof args[1] === 'string' ? args[1] : undefined };
  if (typeof first === 'string') return { path: first };
  return {};
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
  const target = connectTarget(args);
  if (target.path === undefined && !isLocal(target.host)) {
    refused.push(`connect ${target.host}:${String(target.port)}`);
    const error = Object.assign(new Error('Egress is blocked in this test'), {
      code: 'ECONNREFUSED',
    });
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return (originalConnect as (...rest: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;

function blockedLookup(hostname: string) {
  refused.push(`dns ${hostname}`);
  return Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
}
const originalLookup = dns.lookup;
dns.lookup = function guardedLookup(hostname: string, ...rest: unknown[]) {
  if (!isLocal(hostname)) {
    const callback = rest.at(-1) as (error: Error) => void;
    process.nextTick(() => callback(blockedLookup(hostname)));
    return;
  }
  return (originalLookup as (...all: unknown[]) => unknown)(hostname, ...rest);
} as typeof dns.lookup;
const originalPromiseLookup = dns.promises.lookup;
dns.promises.lookup = async function guardedPromiseLookup(hostname: string, ...rest: unknown[]) {
  if (!isLocal(hostname)) throw blockedLookup(hostname);
  return (originalPromiseLookup as (...all: unknown[]) => Promise<unknown>)(hostname, ...rest);
} as typeof dns.promises.lookup;

// Direct DNS queries always go to a resolver off the host, so every one is refused.
type Patchable = Record<string, unknown>;
const restores: (() => void)[] = [];
function blockResolvers(target: Patchable, style: 'callback' | 'promise') {
  for (const name of Object.keys(target)) {
    if (!/^(resolve|reverse)/.test(name) || typeof target[name] !== 'function') continue;
    const original = target[name];
    target[name] = function blockedResolve(hostname: string, ...rest: unknown[]) {
      const error = blockedLookup(`${name} ${hostname}`);
      if (style === 'promise') return Promise.reject(error);
      const callback = rest.at(-1) as (error: Error) => void;
      process.nextTick(() => callback(error));
      return undefined;
    };
    restores.push(() => {
      target[name] = original;
    });
  }
}
blockResolvers(dns as unknown as Patchable, 'callback');
blockResolvers(dns.Resolver.prototype as unknown as Patchable, 'callback');
blockResolvers(dns.promises as unknown as Patchable, 'promise');
blockResolvers(dns.promises.Resolver.prototype as unknown as Patchable, 'promise');

// UDP: refuse a send or connect to anything but a local address.
function udpTarget(args: unknown[]): { port?: unknown; host?: string } {
  const portIndex = args.findIndex((arg, index) => index > 0 && typeof arg === 'number');
  const port = args[portIndex];
  const host =
    typeof args[portIndex + 1] === 'string' ? (args[portIndex + 1] as string) : undefined;
  return { port, host };
}
for (const method of ['send', 'connect'] as const) {
  const original = dgram.Socket.prototype[method] as (...args: unknown[]) => unknown;
  (dgram.Socket.prototype as unknown as Patchable)[method] = function guardedUdp(
    this: dgram.Socket,
    ...args: unknown[]
  ) {
    const target =
      method === 'connect'
        ? { port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined }
        : udpTarget(args);
    if (!isLocal(target.host)) {
      refused.push(`udp ${target.host}:${String(target.port)}`);
      const callback = args.at(-1);
      const error = Object.assign(new Error('Egress is blocked in this test'), {
        code: 'ECONNREFUSED',
      });
      if (typeof callback === 'function') process.nextTick(() => callback(error));
      return undefined;
    }
    return original.apply(this, args);
  };
  restores.push(() => {
    (dgram.Socket.prototype as unknown as Patchable)[method] = original;
  });
}

// ---- the journey ----

let h: TenancyHarness;

beforeAll(async () => {
  h = await startTenancyHarness('tenancy_egress');
}, 60_000);

afterAll(async () => {
  await h?.close();
  net.Socket.prototype.connect = originalConnect;
  dns.lookup = originalLookup;
  dns.promises.lookup = originalPromiseLookup;
  for (const restore of restores) restore();
});

async function nextEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: { buffer: string }
) {
  while (true) {
    const boundary = state.buffer.indexOf('\n\n');
    if (boundary >= 0) {
      const frame = state.buffer.slice(0, boundary);
      state.buffer = state.buffer.slice(boundary + 2);
      const event = /^event: (.*)$/m.exec(frame)?.[1];
      if (event) return event;
      continue;
    }
    const part = await reader.read();
    if (part.done) throw new Error('Stream closed before an event');
    state.buffer += new TextDecoder().decode(part.value);
  }
}

it('refuses direct outbound TCP, DNS, and UDP, so the journey below cannot reach anything off the host', async () => {
  // Discrimination check: the guard must actually refuse, or an empty list below proves nothing.
  await expect(
    fetch('https://example.com/', { signal: AbortSignal.timeout(5_000) })
  ).rejects.toThrow();
  expect(refused).toEqual(['connect example.com:443']);
  await expect(dns.promises.lookup('example.com')).rejects.toMatchObject({ code: 'ENOTFOUND' });
  await expect(
    new Promise((resolve, reject) => {
      const socket = net.connect({ host: '192.0.2.1', port: 443 });
      socket.once('connect', resolve);
      socket.once('error', reject);
    })
  ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  expect(refused).toEqual(['connect example.com:443', 'dns example.com', 'connect 192.0.2.1:443']);
  // Direct DNS queries, callback and promise, default and custom resolvers.
  await expect(dns.promises.resolve4('example.com')).rejects.toMatchObject({ code: 'ENOTFOUND' });
  await expect(new dns.promises.Resolver().resolveTxt('example.com')).rejects.toMatchObject({
    code: 'ENOTFOUND',
  });
  await expect(
    new Promise((resolve, reject) =>
      new dns.Resolver().resolveAny('example.com', (error, value) =>
        error ? reject(error) : resolve(value)
      )
    )
  ).rejects.toMatchObject({ code: 'ENOTFOUND' });
  // UDP to an address off the host.
  const udp = dgram.createSocket('udp4');
  try {
    await expect(
      new Promise((resolve, reject) =>
        udp.send('ping', 53, '192.0.2.53', (error) => (error ? reject(error) : resolve(null)))
      )
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  } finally {
    udp.close();
  }
  expect(refused.slice(3)).toEqual([
    'dns resolve4 example.com',
    'dns resolveTxt example.com',
    'dns resolveAny example.com',
    'udp 192.0.2.53:53',
  ]);
  refused.length = 0;
});

it('runs install, chat, files, local pairing, agents, export, a second community, recovery, and every sweep with egress blocked', async () => {
  // First install: host operator, first community, owner membership.
  const host = await bootstrapHost(h, 'Operator', 'operator@egress.test');
  const a = `/api/v1/communities/${host.communityId}`;
  expect((await h.call('/api/v1/community', { cookie: host.cookie })).status).toBe(200);

  // Chat and files.
  const posted = await expectStatus(
    await h.call(`${a}/channels/${host.channelId}/entries`, {
      cookie: host.cookie,
      body: { text: 'hello offline', idempotencyKey: 'egress-first' },
    }),
    201,
    'first post'
  );
  const cursor = (await posted.json()).cursor;
  const upload = await expectStatus(
    await h.call(`${a}/channels/${host.channelId}/attachments`, {
      method: 'POST',
      cookie: host.cookie,
      headers: {
        'content-type': 'text/plain',
        'x-file-name': 'offline.txt',
        'x-file-size': '7',
        'idempotency-key': 'egress-file',
      },
      raw: 'offline',
    }),
    201,
    'upload'
  );
  const attachmentId = (await upload.json()).attachment.id;
  await expectStatus(
    await h.call(`${a}/channels/${host.channelId}/entries`, {
      cookie: host.cookie,
      body: {
        text: 'with file',
        idempotencyKey: 'egress-file-post',
        attachmentIds: [attachmentId],
      },
    }),
    201,
    'post with file'
  );
  const download = await expectStatus(
    await h.call(`${a}/attachments/${attachmentId}`, { cookie: host.cookie }),
    200,
    'download'
  );
  expect(await download.text()).toBe('offline');
  await expectStatus(
    await h.call(`${a}/channels/${host.channelId}/read-cursor`, {
      method: 'PUT',
      cookie: host.cookie,
      body: { cursor },
    }),
    200,
    'read cursor'
  );

  // A second person joins by invitation and reads the live stream.
  const member = await admit(h, host.communityId, host.cookie, {
    name: 'Member',
    email: 'member@egress.test',
  });
  await expectStatus(
    await h.call(`${a}/channels/${host.channelId}/join`, { cookie: member.cookie, body: {} }),
    200,
    'member joins'
  );
  const stream = await expectStatus(
    await h.call(`${a}/channels/${host.channelId}/events`, { cookie: member.cookie }),
    200,
    'stream'
  );
  const reader = stream.body!.getReader();
  const streamState = { buffer: '' };
  try {
    expect(await nextEvent(reader, streamState)).toBe('snapshot');
    expect(await nextEvent(reader, streamState)).toBe('replay_complete');
  } finally {
    await reader.cancel();
  }

  // A local DorkOS install pairs through browser approval, then enrolls an agent that posts.
  const verifier = randomBytes(32).toString('base64url');
  const started = await expectStatus(
    await h.call(`${a}/pairings/start`, {
      headers: { origin: '' },
      body: {
        installName: 'Offline laptop',
        challenge: createHash('sha256').update(verifier).digest('base64url'),
        scopes: ['read', 'post', 'enroll-agent'],
      },
    }),
    201,
    'pairing start'
  );
  const { pairingId } = await started.json();
  await expectStatus(
    await h.call(`${a}/pairings/approve`, { cookie: host.cookie, body: { pairingId } }),
    200,
    'pairing approve'
  );
  const polled = await expectStatus(
    await h.call(`${a}/pairings/poll`, { headers: { origin: '' }, body: { pairingId, verifier } }),
    200,
    'pairing poll'
  );
  const { code } = await polled.json();
  const exchanged = await expectStatus(
    await h.call(`${a}/pairings/exchange`, {
      headers: { origin: '' },
      body: { pairingId, code, verifier },
    }),
    200,
    'pairing exchange'
  );
  const grantToken = (await exchanged.json()).token as string;
  await expectStatus(
    await h.call(`${a}/channels/${host.channelId}/entries`, { bearer: grantToken }),
    200,
    'bearer history'
  );
  const enrolled = await expectStatus(
    await h.call(`${a}/agents`, {
      bearer: grantToken,
      body: { localAgentId: 'offline-agent', displayName: 'Offline Agent' },
    }),
    201,
    'enroll agent'
  );
  const agent = await enrolled.json();
  await expectStatus(
    await h.call(`${a}/channels/${host.channelId}/agents`, {
      cookie: host.cookie,
      body: { agentId: agent.agent.memberId },
    }),
    200,
    'agent joins channel'
  );
  await expectStatus(
    await h.call(`${a}/channels/${host.channelId}/entries`, {
      bearer: agent.token,
      body: { text: 'agent offline', idempotencyKey: 'egress-agent' },
    }),
    201,
    'agent post'
  );

  // Personal export, created and downloaded.
  const exported = await expectStatus(
    await h.call(`${a}/me/export`, { cookie: host.cookie, body: {} }),
    201,
    'export'
  );
  const archive = await expectStatus(
    await h.call(`${a}/exports/${(await exported.json()).archiveId}`, { cookie: host.cookie }),
    200,
    'export download'
  );
  expect((await archive.arrayBuffer()).byteLength).toBeGreaterThan(0);

  // A second community on the same host, claimed by a new account.
  const pending = await createPendingCommunity(h, host.cookie, 'Offline second');
  const bOwner = await claimAsNewAccount(h, pending.token, 'B Owner', 'b-owner@egress.test');
  expect(
    (await h.call(`/api/v1/communities/${pending.communityId}/me`, { cookie: bOwner.cookie }))
      .status
  ).toBe(200);
  const alias = await h.call('/api/v1/community', { cookie: host.cookie });
  expect(alias.status).toBe(409);
  expect(await alias.json()).toMatchObject({ code: 'COMMUNITY_SELECTION_REQUIRED' });
  const memberships = await expectStatus(
    await h.call('/api/v1/memberships', { cookie: host.cookie }),
    200,
    'memberships'
  );
  expect((await memberships.json()).memberships).toHaveLength(1);

  // Host-wide offline password recovery, then sign-in with the new password.
  await recoverPassword(h.pool, 'member@egress.test', 'recovered-password-123');
  const signIn = await expectStatus(
    await h.call('/api/auth/sign-in/email', {
      body: { email: 'member@egress.test', password: 'recovered-password-123' },
    }),
    200,
    'sign in after recovery'
  );
  expect(responseCookies(signIn)).toContain('session_token');
  expect(TENANCY_PASSWORD).not.toBe('recovered-password-123');

  // Every background job main.ts schedules, once each.
  await sweepExpiredAttachments(h.pool, h.blobStore);
  await sweepExpiredExports(h.pool, h.blobStore);
  await sweepExpiredAdmissions(h.pool);
  await sweepPendingBlobDeletions(h.pool, h.blobStore);
  await sweepCommunityDeletions(h.pool, h.blobStore);
  await sweepCommunityDeletionTombstones(h.pool);

  expect(refused).toEqual([]);
}, 60_000);

it('runs every administration request, including a scheduled deletion sweep, with egress blocked', async () => {
  // The host operator from the journey above, signed in again.
  const signedIn = await expectStatus(
    await h.call('/api/auth/sign-in/email', {
      body: { email: 'operator@egress.test', password: TENANCY_PASSWORD },
    }),
    200,
    'operator sign-in'
  );
  const operator = responseCookies(signedIn);
  const pending = await createPendingCommunity(h, operator, 'Offline admin');
  const c = `/api/v1/communities/${pending.communityId}`;
  const owner = await claimAsNewAccount(h, pending.token, 'Admin Owner', 'admin-owner@egress.test');
  const successor = await admit(h, pending.communityId, owner.cookie, {
    name: 'Successor',
    email: 'successor@egress.test',
  });
  const version = async () =>
    (
      await h.pool.query<{ lifecycle_version: number }>(
        'SELECT lifecycle_version FROM communities WHERE id=$1',
        [pending.communityId]
      )
    ).rows[0].lifecycle_version;

  // Settings: name and description, a raster icon in the local filesystem store,
  // and the admission policy closed and reopened, each against its ETag.
  const settings = await expectStatus(
    await h.call(`${c}/settings`, { cookie: owner.cookie }),
    200,
    'read settings'
  );
  let etag = settings.headers.get('etag')!;
  const patchSettings = async (body: object, step: string) => {
    const response = await expectStatus(
      await h.call(`${c}/settings`, {
        method: 'PATCH',
        cookie: owner.cookie,
        headers: { 'if-match': etag },
        body,
      }),
      200,
      step
    );
    etag = `"${(await response.json()).settingsVersion}"`;
  };
  await patchSettings({ name: 'Offline admin renamed', description: 'Runs offline' }, 'rename');
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('offline')]);
  const icon = await expectStatus(
    await h.call(`${c}/settings/icon`, {
      method: 'PUT',
      cookie: owner.cookie,
      headers: { 'if-match': etag },
      raw: png,
    }),
    200,
    'upload icon'
  );
  etag = `"${(await icon.json()).settingsVersion}"`;
  const served = await expectStatus(
    await h.call(`${c}/icon`, { cookie: owner.cookie }),
    200,
    'serve icon'
  );
  expect(Buffer.from(await served.arrayBuffer())).toEqual(png);
  await patchSettings({ admissionPolicy: 'closed' }, 'close admission');
  await patchSettings({ admissionPolicy: 'invite_only' }, 'reopen admission');

  // Ownership transfer, then archive and restore by the new owner.
  await expectStatus(
    await h.call(`${c}/owner/transfer`, {
      cookie: owner.cookie,
      body: {
        successorMemberId: successor.memberId,
        password: TENANCY_PASSWORD,
        lifecycleVersion: await version(),
      },
    }),
    200,
    'transfer ownership'
  );
  const lifecycle = async (action: 'archive' | 'restore') =>
    expectStatus(
      await h.call(`${c}/owner/lifecycle`, {
        cookie: successor.cookie,
        body: {
          action,
          lifecycleVersion: await version(),
          password: TENANCY_PASSWORD,
          confirmName: 'Offline admin renamed',
        },
      }),
      200,
      action
    );
  await lifecycle('archive');
  await lifecycle('restore');

  // Host suspension and resumption.
  for (const action of ['suspend', 'resume'] as const) {
    await expectStatus(
      await h.call(`/api/v1/host/communities/${pending.communityId}/lifecycle`, {
        method: 'PATCH',
        cookie: operator,
        body: { action, lifecycleVersion: await version() },
      }),
      200,
      `host ${action}`
    );
  }

  // Deletion: request, cancel, request again, then a due sweep removes it.
  await lifecycle('archive');
  const requestDeletion = async () =>
    expectStatus(
      await h.call(`${c}/owner/deletion`, {
        cookie: successor.cookie,
        body: {
          lifecycleVersion: await version(),
          password: TENANCY_PASSWORD,
          confirmName: 'Offline admin renamed',
          confirmIdSuffix: pending.communityId.slice(-8),
        },
      }),
      200,
      'request deletion'
    );
  await requestDeletion();
  await expectStatus(
    await h.call(`${c}/owner/deletion/cancel`, {
      cookie: successor.cookie,
      body: { lifecycleVersion: await version(), password: TENANCY_PASSWORD },
    }),
    200,
    'cancel deletion'
  );
  await requestDeletion();
  // Fixture shortcut: skip the grace period rather than wait for it.
  await h.pool.query(
    `UPDATE communities SET delete_requested_at=now()-interval '8 days',
       delete_after=now()-interval '1 day' WHERE id=$1`,
    [pending.communityId]
  );
  await h.pool.query(
    `UPDATE community_deletion_jobs SET delete_after=now()-interval '1 day',next_attempt_at=now()
     WHERE community_id=$1`,
    [pending.communityId]
  );
  let completed = 0;
  for (let pass = 0; pass < 20 && !completed; pass++) {
    const result = await sweepCommunityDeletions(h.pool, h.blobStore, 100);
    expect(result.failed).toBe(0);
    completed = result.completed;
    await h.pool.query('UPDATE community_deletion_jobs SET next_attempt_at=now()');
    await h.pool.query('UPDATE community_deletion_blob_progress SET next_attempt_at=now()');
  }
  expect(completed).toBe(1);
  expect(
    (await h.pool.query('SELECT 1 FROM communities WHERE id=$1', [pending.communityId])).rowCount
  ).toBe(0);

  expect(refused).toEqual([]);
}, 60_000);
