/**
 * Standalone proof: a self-hosted Community works with no outbound network
 * access, so it has no DorkOS Cloud dependency (spec
 * `community-tenancy-contract`, identity model and task 4.2: "The service works
 * with Cloud egress unavailable").
 *
 * Before any Community code opens a socket, this file wraps every TCP/TLS
 * connect and every DNS lookup in the process. Loopback and the test database
 * host stay reachable; anything else is recorded and refused, exactly as a
 * firewall that blocks all egress would. The whole first-install to
 * two-community journey then runs through the real server, and the recorded
 * list must be empty at the end. The guard blocks every non-local host, which
 * is strictly stronger than blocking DorkOS Cloud alone.
 */
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

it('refuses a direct outbound connection, so the journey below cannot reach anything off the host', async () => {
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
