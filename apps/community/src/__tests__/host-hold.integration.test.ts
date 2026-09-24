/**
 * Host hold and host-started deletion (spec `community-host-operator-api`, "Host hold and
 * host-started deletion", amended by `community-hold-keeps-access`). A hold must stop growth
 * without revoking anything: members, agents, and invitations wait and work again on release.
 * A host may delete a community only after a hold with a published notice date.
 *
 * Tests run in order on one host with an injected clock. A is held and deleted; B, another
 * tenant, must stay untouched by all of it.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  CommunityConnectionAccessSchema,
  CommunityWireConnectionAccessResponseSchema,
  CommunityWireInvitePreviewResponseSchema,
} from '@dorkos/shared/community-wire';
import { sweepCommunityDeletions } from '../deletion-worker.js';
import { hashSecret } from '../security.js';
import {
  TENANCY_PASSWORD,
  admit,
  bootstrapHost,
  claimAsNewAccount,
  createPendingCommunity,
  expectStatus,
  pairInstall,
  startTenancyHarness,
  type TenancyHarness,
  type TenancyMember,
} from './tenancy-test-harness.js';
import { responseCookies } from './bootstrap-test-helper.js';

const DAY = 24 * 60 * 60_000;
let h: TenancyHarness;
/** Added to the wall clock by the server's clock. */
let clockOffsetMs = 0;
const clock = () => new Date(Date.now() + clockOffsetMs);
let operator: TenancyMember;
let member: TenancyMember;
let a = '';
let b = '';
let channelA = '';
let memberGrant = '';
let agentId = '';
let agentToken = '';
let secondAgentId = '';
let attachmentId = '';
let joiner = '';
let inviteToken = '';
let revocableInviteId = '';
let heldEraGrant = '';
let pendingPairing: { pairingId: string; verifier: string };
let streamBeforeHold: ReadableStreamDefaultReader<Uint8Array>;

const tenant = (communityId: string) => `/api/v1/communities/${communityId}`;

async function lifecycle(communityId = a) {
  return (
    await h.pool.query<{
      lifecycle: string;
      lifecycle_version: number;
      held_from_state: string | null;
      suspended_from_state: string | null;
    }>(
      `SELECT lifecycle,lifecycle_version,held_from_state,suspended_from_state
       FROM communities WHERE id=$1`,
      [communityId]
    )
  ).rows[0];
}

async function host(action: string, extra: Record<string, unknown> = {}, communityId = a) {
  return h.call(`/api/v1/host/communities/${communityId}/lifecycle`, {
    method: 'PATCH',
    cookie: operator.cookie,
    body: { action, lifecycleVersion: (await lifecycle(communityId)).lifecycle_version, ...extra },
  });
}

async function hostDelete(communityId = a) {
  return h.call(`/api/v1/host/communities/${communityId}/deletion`, {
    cookie: operator.cookie,
    body: {
      lifecycleVersion: (await lifecycle(communityId)).lifecycle_version,
      confirmIdSuffix: communityId.slice(-8),
    },
  });
}

async function expectHeld(response: Response, label: string) {
  expect(response.status, label).toBe(423);
  expect((await response.json()).code, label).toBe('COMMUNITY_HELD');
}

/** Every revocation column a hold used to touch, for community A. */
async function accessRows() {
  const [grants, credentials, agents, invites, pairings, admissions] = await Promise.all([
    h.pool.query('SELECT id,revoked_at FROM connection_grants WHERE community_id=$1 ORDER BY id', [
      a,
    ]),
    h.pool.query('SELECT id,revoked_at FROM agent_credentials WHERE community_id=$1 ORDER BY id', [
      a,
    ]),
    h.pool.query('SELECT id,active,revoked_at FROM agents WHERE community_id=$1 ORDER BY id', [a]),
    h.pool.query('SELECT id,revoked_at FROM invites WHERE community_id=$1 ORDER BY id', [a]),
    h.pool.query(
      'SELECT id,cancelled_at FROM connection_pairings WHERE community_id=$1 ORDER BY id',
      [a]
    ),
    h.pool.query('SELECT count(*)::int AS n FROM pending_admissions WHERE community_id=$1', [a]),
  ]);
  return {
    grants: grants.rows,
    liveGrants: grants.rows.filter((row) => !row.revoked_at).length,
    credentials: credentials.rows,
    agents: agents.rows,
    invites: invites.rows,
    pairings: pairings.rows,
    pendingAdmissions: admissions.rows[0].n as number,
  };
}

/** How many grants, agent credentials, active agents, and invitations are still live in A. */
async function liveAccess() {
  return (
    await h.pool.query(
      `SELECT (SELECT count(*)::int FROM connection_grants WHERE community_id=$1 AND revoked_at IS NULL) AS grants,
              (SELECT count(*)::int FROM agent_credentials WHERE community_id=$1 AND revoked_at IS NULL) AS credentials,
              (SELECT count(*)::int FROM agents WHERE community_id=$1 AND active) AS agents,
              (SELECT count(*)::int FROM invites WHERE community_id=$1 AND revoked_at IS NULL) AS invites`,
      [a]
    )
  ).rows[0];
}

/** Start a pairing from a local install and leave it waiting for approval. */
async function startPairing(scopes: string[]) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const started = await expectStatus(
    await h.call(`${tenant(a)}/pairings/start`, {
      headers: { origin: '' },
      body: { installName: 'Waiting install', challenge, scopes },
    }),
    201,
    'pairing start'
  );
  return { pairingId: (await started.json()).pairingId as string, verifier };
}

/** Approve a waiting pairing in the browser and exchange it for the install's bearer. */
async function completePairing(
  pairing: { pairingId: string; verifier: string },
  approverCookie: string
) {
  const { pairingId, verifier } = pairing;
  await expectStatus(
    await h.call(`${tenant(a)}/pairings/approve`, { cookie: approverCookie, body: { pairingId } }),
    200,
    'pairing approve'
  );
  const polled = await expectStatus(
    await h.call(`${tenant(a)}/pairings/poll`, {
      headers: { origin: '' },
      body: { pairingId, verifier },
    }),
    200,
    'pairing poll'
  );
  const exchanged = await expectStatus(
    await h.call(`${tenant(a)}/pairings/exchange`, {
      headers: { origin: '' },
      body: { pairingId, code: (await polled.json()).code, verifier },
    }),
    200,
    'pairing exchange'
  );
  return (await exchanged.json()).token as string;
}

const sseBuffers = new WeakMap<ReadableStreamDefaultReader<Uint8Array>, string>();

/** Read the next SSE event's data, failing after five seconds without one. */
async function nextSse(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<{ type: string }> {
  let buffer = sseBuffers.get(reader) ?? '';
  for (;;) {
    const boundary = buffer.indexOf('\n\n');
    if (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      sseBuffers.set(reader, buffer);
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      if (data) return JSON.parse(data.slice(6));
      continue;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('SSE timed out')), 5_000);
      }),
    ]).finally(() => clearTimeout(timeout));
    if (chunk.done) throw new Error('SSE closed before an event');
    buffer += new TextDecoder().decode(chunk.value);
  }
}

const inDays = (days: number) => new Date(clock().getTime() + days * DAY).toISOString();

/** Every row a tenant owns, read straight from the tables that carry a community id. */
async function tenantRows(communityId: string): Promise<Record<string, unknown>> {
  const tables = (
    await h.pool.query<{ table_name: string }>(
      `SELECT DISTINCT table_name FROM information_schema.columns
       WHERE table_schema='public' AND column_name='community_id' ORDER BY table_name`
    )
  ).rows.map((row) => row.table_name);
  const result: Record<string, unknown> = {
    communities: (
      await h.pool.query('SELECT to_jsonb(c)::text AS row FROM communities c WHERE id=$1', [
        communityId,
      ])
    ).rows,
  };
  for (const table of tables) {
    result[table] = (
      await h.pool.query(
        `SELECT to_jsonb(t)::text AS row FROM "${table}" t WHERE community_id=$1 ORDER BY 1`,
        [communityId]
      )
    ).rows;
  }
  return result;
}

let bBefore: Record<string, unknown>;

beforeAll(async () => {
  h = await startTenancyHarness('host_hold', { now: clock });
  const first = await bootstrapHost(h, 'Operator', 'operator@hold.test');
  operator = { cookie: first.cookie, memberId: first.memberId };
  a = first.communityId;
  channelA = first.channelId;
  member = await admit(h, a, operator.cookie, { name: 'Member', email: 'member@hold.test' });
  await expectStatus(
    await h.call(`${tenant(a)}/channels/${channelA}/join`, { cookie: member.cookie, body: {} }),
    200,
    'member joins'
  );
  await expectStatus(
    await h.call(`${tenant(a)}/channels/${channelA}/entries`, {
      cookie: operator.cookie,
      body: { text: 'Before the hold', idempotencyKey: 'before' },
    }),
    201,
    'post before hold'
  );
  memberGrant = await pairInstall(h, a, member.cookie);
  const enrolled = await expectStatus(
    await h.call(`${tenant(a)}/agents`, {
      bearer: memberGrant,
      body: { localAgentId: 'agent-1', displayName: 'Agent One' },
    }),
    201,
    'enroll agent'
  );
  const enrollment = await enrolled.json();
  agentId = enrollment.agent.memberId;
  agentToken = enrollment.token;
  await expectStatus(
    await h.call(`${tenant(a)}/channels/${channelA}/agents`, {
      bearer: memberGrant,
      body: { agentId },
    }),
    200,
    'agent joins the channel'
  );
  const second = await expectStatus(
    await h.call(`${tenant(a)}/agents`, {
      bearer: memberGrant,
      body: { localAgentId: 'agent-y', displayName: 'Agent Y' },
    }),
    201,
    'enroll a second agent'
  );
  secondAgentId = (await second.json()).agent.memberId;
  const uploaded = await expectStatus(
    await h.call(`${tenant(a)}/channels/${channelA}/attachments`, {
      method: 'POST',
      cookie: operator.cookie,
      headers: {
        'content-type': 'text/plain',
        'x-file-name': 'kept.txt',
        'x-file-size': '4',
        'idempotency-key': 'kept-file',
      },
      raw: 'kept',
    }),
    201,
    'upload before hold'
  );
  attachmentId = (await uploaded.json()).attachment.id;
  await expectStatus(
    await h.call(`${tenant(a)}/channels/${channelA}/entries`, {
      cookie: operator.cookie,
      body: { text: 'A file', idempotencyKey: 'file-entry', attachmentIds: [attachmentId] },
    }),
    201,
    'post the file before hold'
  );
  const pending = await createPendingCommunity(h, operator.cookie, 'Tenant B');
  b = pending.communityId;
  await claimAsNewAccount(h, pending.token, 'B Owner', 'b-owner@hold.test');
  bBefore = await tenantRows(b);
}, 60_000);

afterAll(async () => {
  await h?.close();
});

it('refuses a notice shorter than the minimum, and a notice outside a hold', async () => {
  // Purpose: fails if a host could publish less notice than members are promised.
  for (const days of [1, 6, 13]) {
    const refused = await host('hold', { deletionNoticeAt: inDays(days) });
    expect(refused.status, `${days} days`).toBe(409);
  }
  expect((await host('set_notice', { deletionNoticeAt: inDays(30) })).status).toBe(409);
  expect((await lifecycle()).lifecycle).toBe('active');
});

it('holds A without revoking any grant, agent, invitation, admission, or pairing (AC-1)', async () => {
  // Purpose: fails if the hold still revokes (spec `community-hold-keeps-access`). Everything a
  // member, agent owner, or invited person had before the hold must still exist after it.
  // Someone half-way through joining when the hold lands: invited, signed up, and bound.
  const issued = await expectStatus(
    await h.call(`${tenant(a)}/invites`, { cookie: operator.cookie, body: { seats: 1 } }),
    201,
    'invite before hold'
  );
  const preflight = await expectStatus(
    await h.call(`${tenant(a)}/invites/preflight`, {
      body: { token: (await issued.json()).token },
    }),
    200,
    'preflight before hold'
  );
  const admission = responseCookies(preflight);
  const signedUp = await expectStatus(
    await h.call('/api/auth/sign-up/email', {
      cookie: admission,
      body: { name: 'Joiner', email: 'joiner@hold.test', password: TENANCY_PASSWORD },
    }),
    200,
    'sign up before hold'
  );
  joiner = `${admission}; ${responseCookies(signedUp)}`;
  await expectStatus(
    await h.call(`${tenant(a)}/invites/bind`, { cookie: joiner, body: {} }),
    200,
    'bind before hold'
  );
  const waiting = await expectStatus(
    await h.call(`${tenant(a)}/invites`, { cookie: operator.cookie, body: { seats: 1 } }),
    201,
    'invitation I'
  );
  const waitingBody = await waiting.json();
  inviteToken = waitingBody.token;
  const revocable = await expectStatus(
    await h.call(`${tenant(a)}/invites`, { cookie: operator.cookie, body: { seats: 1 } }),
    201,
    'second invitation'
  );
  revocableInviteId = (await revocable.json()).invite.id;
  pendingPairing = await startPairing(['read']);
  // A live stream opened before the hold; the hold must close it honestly (AC-3).
  const stream = await h.call(`${tenant(a)}/channels/${channelA}/events`, { bearer: memberGrant });
  expect(stream.status).toBe(200);
  streamBeforeHold = stream.body!.getReader();
  expect((await nextSse(streamBeforeHold)).type).toBe('snapshot');
  expect((await nextSse(streamBeforeHold)).type).toBe('replay_complete');

  const before = await accessRows();
  expect(before.pendingAdmissions).toBeGreaterThan(1);
  await expectStatus(await host('hold', { deletionNoticeAt: null }), 200, 'hold');
  expect(await lifecycle()).toMatchObject({ lifecycle: 'held', held_from_state: 'active' });
  expect(await accessRows()).toEqual(before);
});

it('closes a live stream opened before the hold with reason archived, not removed (AC-3)', async () => {
  // Purpose: fails if a held community's stream reads as a lost membership.
  const closed = (await nextSse(streamBeforeHold)) as { type: string; reason?: string };
  expect(closed).toMatchObject({ type: 'closed', reason: 'archived' });
  await streamBeforeHold.cancel();
});

it('refuses every growing action with 423 COMMUNITY_HELD while kept credentials stay live', async () => {
  // Purpose: fails if a hold reuses suspension (everything refused) or lets anything grow.
  await expectHeld(
    await h.call(`${tenant(a)}/channels/${channelA}/entries`, {
      cookie: member.cookie,
      body: { text: 'During the hold', idempotencyKey: 'during' },
    }),
    'post'
  );
  await expectHeld(
    await h.call(`${tenant(a)}/channels/${channelA}/attachments`, {
      method: 'POST',
      cookie: member.cookie,
      headers: {
        'content-type': 'text/plain',
        'x-file-name': 'held.txt',
        'x-file-size': '1',
        'idempotency-key': 'held-file',
      },
      raw: 'a',
    }),
    'upload'
  );
  await expectHeld(
    await h.call(`${tenant(a)}/invites`, { cookie: operator.cookie, body: { seats: 1 } }),
    'invitation'
  );
  await expectHeld(
    await h.call(`${tenant(a)}/channels/${channelA}`, {
      method: 'PATCH',
      cookie: operator.cookie,
      body: { name: 'renamed' },
    }),
    'channel rename'
  );
  await expectHeld(
    await h.call(`${tenant(a)}/members/${member.memberId}/role`, {
      method: 'PATCH',
      cookie: operator.cookie,
      body: { role: 'admin' },
    }),
    'role change'
  );
  await expectHeld(
    await h.call(`${tenant(a)}/channels/${channelA}/members`, {
      cookie: operator.cookie,
      body: { memberId: member.memberId },
    }),
    'channel member add'
  );
  await expectHeld(
    await h.call(`${tenant(a)}/owner/transfer`, {
      cookie: operator.cookie,
      body: {
        successorMemberId: member.memberId,
        password: TENANCY_PASSWORD,
        lifecycleVersion: (await lifecycle()).lifecycle_version,
      },
    }),
    'owner transfer'
  );
  await expectHeld(
    await h.call(`${tenant(a)}/channels`, {
      cookie: operator.cookie,
      body: { name: 'new-room', visibility: 'public' },
    }),
    'new channel'
  );
  const settings = await h.call(`${tenant(a)}/settings`, { cookie: operator.cookie });
  expect(settings.status).toBe(200);
  await expectHeld(
    await h.call(`${tenant(a)}/settings`, {
      method: 'PATCH',
      cookie: operator.cookie,
      headers: { 'if-match': `"${(await settings.json()).settingsVersion}"` },
      body: { name: 'Renamed while held' },
    }),
    'settings edit'
  );
  await expectHeld(
    await h.call(`${tenant(a)}/owner/lifecycle`, {
      cookie: operator.cookie,
      body: {
        action: 'archive',
        lifecycleVersion: (await lifecycle()).lifecycle_version,
        password: TENANCY_PASSWORD,
        confirmName: 'Operator Community',
      },
    }),
    'owner archive'
  );
  // A write-scope pairing is refused; only the read-only pairing an archive allows works.
  const writePairing = await h.call(`${tenant(a)}/pairings/start`, {
    headers: { origin: '' },
    body: { installName: 'Writer', challenge: 'x'.repeat(43), scopes: ['read', 'post'] },
  });
  await expectHeld(writePairing, 'write pairing');
  // The kept grant G is live, yet it cannot enroll, rotate, or recover an agent.
  await expectHeld(
    await h.call(`${tenant(a)}/agents`, {
      bearer: memberGrant,
      body: { localAgentId: 'agent-2', displayName: 'Agent Two' },
    }),
    'agent enrollment'
  );
  await expectHeld(
    await h.call(`${tenant(a)}/agents/${agentId}/rotate`, { bearer: memberGrant, body: {} }),
    'agent rotate'
  );
  await expectHeld(
    await h.call(`${tenant(a)}/agents/recover`, {
      bearer: memberGrant,
      body: { localAgentId: 'agent-1', displayName: 'Agent One' },
    }),
    'agent recover'
  );
});

it('lets a kept grant and a kept agent read history and files, and nothing else (AC-2)', async () => {
  // Purpose: fails if reads still need a history-only grant or a read-only scope set during a
  // hold, if an agent is refused every read while held, or if capabilities ignore the hold.
  const history = await expectStatus(
    await h.call(`${tenant(a)}/channels/${channelA}/entries`, { bearer: memberGrant }),
    200,
    'G reads history'
  );
  expect(JSON.stringify(await history.json())).toContain('Before the hold');
  const file = await expectStatus(
    await h.call(`${tenant(a)}/attachments/${attachmentId}`, { bearer: memberGrant }),
    200,
    'G downloads a file'
  );
  expect(await file.text()).toBe('kept');
  await expectHeld(
    await h.call(`${tenant(a)}/channels/${channelA}/entries`, {
      bearer: memberGrant,
      body: { text: 'G during the hold', idempotencyKey: 'g-during' },
    }),
    'G posts'
  );
  const agentHistory = await expectStatus(
    await h.call(`${tenant(a)}/channels/${channelA}/entries`, { bearer: agentToken }),
    200,
    'X reads history'
  );
  expect(JSON.stringify(await agentHistory.json())).toContain('Before the hold');
  const agentFile = await expectStatus(
    await h.call(`${tenant(a)}/attachments/${attachmentId}`, { bearer: agentToken }),
    200,
    'X downloads a file'
  );
  expect(await agentFile.text()).toBe('kept');
  await expectHeld(
    await h.call(`${tenant(a)}/channels/${channelA}/entries`, {
      bearer: agentToken,
      body: { text: 'X during the hold', idempotencyKey: 'x-during' },
    }),
    'X posts'
  );
  await expectHeld(
    await h.call(`${tenant(a)}/channels/${channelA}/events`, { bearer: memberGrant }),
    'G opens a stream'
  );
  await expectHeld(
    await h.call(`${tenant(a)}/channels/${channelA}/events`, { bearer: agentToken }),
    'X opens a stream'
  );
  await expectHeld(
    await h.call(`${tenant(a)}/channels/${channelA}/events`, { cookie: member.cookie }),
    'the browser opens a stream'
  );
  const access = await expectStatus(
    await h.call(`${tenant(a)}/me/connection-access`, { bearer: memberGrant }),
    200,
    'connection access'
  );
  const body = CommunityWireConnectionAccessResponseSchema.parse(await access.json());
  expect(CommunityConnectionAccessSchema.safeParse(body.access).success).toBe(true);
  expect(body.access.lastKnown).toMatchObject({
    lifecycle: 'archived',
    capabilities: { read: true, post: false, enrollAgent: false, stream: false },
  });
  // The grant list keeps the grant's real scopes, so a member sees it will post again.
  const grants = await expectStatus(
    await h.call(`${tenant(a)}/me/grants`, { cookie: member.cookie }),
    200,
    'grant list'
  );
  expect((await grants.json()).grants).toEqual([
    expect.objectContaining({
      scopes: ['read', 'post', 'enroll-agent'],
      lifecycle: 'archived',
      capabilities: { read: true, post: false, enrollAgent: false, stream: false },
    }),
  ]);
});

it('still serves history, read-only pairing, and the owner’s export while held', async () => {
  // Purpose: fails if the hold cuts members off from reading or the owner off from their data.
  const history = await expectStatus(
    await h.call(`${tenant(a)}/channels/${channelA}/entries`, { cookie: member.cookie }),
    200,
    'history'
  );
  expect(JSON.stringify(await history.json())).toContain('Before the hold');
  const readOnly = await pairInstall(h, a, member.cookie, ['read']);
  await expectStatus(
    await h.call(`${tenant(a)}/channels/${channelA}/entries`, { bearer: readOnly }),
    200,
    'history through a read-only installation'
  );
  await expectStatus(
    await h.call(`${tenant(a)}/owner/export`, {
      cookie: operator.cookie,
      body: { password: TENANCY_PASSWORD },
    }),
    201,
    'owner export while held'
  );
  const memberships = await expectStatus(
    await h.call('/api/v1/memberships', { cookie: member.cookie }),
    200,
    'memberships'
  );
  expect((await memberships.json()).memberships).toEqual([
    expect.objectContaining({ communityId: a, lifecycle: 'held', deletionNoticeAt: null }),
  ]);
});

it('keeps invitations waiting: preview says held, joining answers 423 and writes nothing (AC-4, AC-2c)', async () => {
  // Purpose: fails if the hold revokes an invitation or lets anyone join while it lasts.
  const preview = await expectStatus(
    await h.call(`${tenant(a)}/invites/preview`, { body: { token: inviteToken } }),
    200,
    'preview'
  );
  expect(CommunityWireInvitePreviewResponseSchema.parse(await preview.json())).toMatchObject({
    communityName: 'Operator Community',
    held: true,
  });
  // A made-up link learns nothing, not even that the community is on hold.
  const forged = await h.call(`${tenant(a)}/invites/preflight`, {
    body: { token: `${inviteToken.slice(0, -4)}AAAA` },
  });
  expect(forged.status).toBe(403);
  const growth = async () =>
    (
      await h.pool.query(
        `SELECT (SELECT count(*)::int FROM members WHERE community_id=$1) AS members,
                (SELECT count(*)::int FROM invite_uses WHERE community_id=$1) AS uses,
                (SELECT count(*)::int FROM community_handles WHERE community_id=$1) AS handles,
                (SELECT count(*)::int FROM pending_admissions WHERE community_id=$1) AS admissions`,
        [a]
      )
    ).rows[0];
  const before = await growth();
  await expectHeld(
    await h.call(`${tenant(a)}/invites/preflight`, { body: { token: inviteToken } }),
    'preflight'
  );
  await expectHeld(
    await h.call(`${tenant(a)}/invites/bind`, { cookie: joiner, body: {} }),
    'bind a live join attempt'
  );
  await expectHeld(
    await h.call(`${tenant(a)}/invites/redeem`, { cookie: joiner, body: {} }),
    'redeem a live join attempt'
  );
  await expectHeld(await h.call(`${tenant(a)}/invites/pending`, { cookie: joiner }), 'pending');
  expect(await growth()).toEqual(before);
  // Removing an agent is not growth: its owner can still remove it through a kept grant.
  await expectStatus(
    await h.call(`${tenant(a)}/agents/${secondAgentId}`, {
      method: 'DELETE',
      bearer: memberGrant,
    }),
    204,
    'remove an agent while held'
  );
  // Removing an invitation is not growth.
  await expectStatus(
    await h.call(`${tenant(a)}/invites/${revocableInviteId}`, {
      method: 'DELETE',
      cookie: operator.cookie,
    }),
    204,
    'revoke an invitation while held'
  );
});

it('approves a pairing started before the hold as read-only history access (AC-6)', async () => {
  // Purpose: fails if a pairing approved while held could gain write scopes.
  heldEraGrant = await completePairing(pendingPairing, member.cookie);
  const row = await h.pool.query<{ scopes: string[]; history_only: boolean }>(
    'SELECT scopes,history_only FROM connection_grants WHERE token_hash=$1',
    [hashSecret(heldEraGrant)]
  );
  expect(row.rows[0]).toEqual({ scopes: ['read'], history_only: true });
});

it('releases A and everything works again with nobody reconnecting (AC-2)', async () => {
  // Purpose: fails if anything was revoked by the hold or needs a new pairing or enrollment.
  await expectStatus(await host('release'), 200, 'release');
  expect(await lifecycle()).toMatchObject({ lifecycle: 'active', held_from_state: null });
  await expectStatus(
    await h.call(`${tenant(a)}/channels/${channelA}/entries`, {
      bearer: memberGrant,
      body: { text: 'G after release', idempotencyKey: 'g-after' },
    }),
    201,
    'G posts'
  );
  await expectStatus(
    await h.call(`${tenant(a)}/channels/${channelA}/entries`, {
      bearer: agentToken,
      body: { text: 'X after release', idempotencyKey: 'x-after' },
    }),
    201,
    'X posts'
  );
  const stream = await expectStatus(
    await h.call(`${tenant(a)}/channels/${channelA}/events`, { bearer: memberGrant }),
    200,
    'G opens a stream'
  );
  const reader = stream.body!.getReader();
  expect((await nextSse(reader)).type).toBe('snapshot');
  await reader.cancel();
  const access = await expectStatus(
    await h.call(`${tenant(a)}/me/connection-access`, { bearer: memberGrant }),
    200,
    'connection access'
  );
  const body = CommunityWireConnectionAccessResponseSchema.parse(await access.json());
  expect(body.access.lastKnown).toMatchObject({
    lifecycle: 'active',
    capabilities: { read: true, post: true, enrollAgent: true, stream: true },
  });
  // The join attempt that waited through the hold completes, and so does invitation I.
  await expectStatus(
    await h.call(`${tenant(a)}/invites/redeem`, { cookie: joiner, body: {} }),
    200,
    'the waiting join attempt completes'
  );
  const preview = await expectStatus(
    await h.call(`${tenant(a)}/invites/preview`, { body: { token: inviteToken } }),
    200,
    'preview after release'
  );
  expect((await preview.json()).held).toBe(false);
  const preflight = await expectStatus(
    await h.call(`${tenant(a)}/invites/preflight`, { body: { token: inviteToken } }),
    200,
    'preflight after release'
  );
  const admission = responseCookies(preflight);
  const signedUp = await expectStatus(
    await h.call('/api/auth/sign-up/email', {
      cookie: admission,
      body: { name: 'Later', email: 'later@hold.test', password: TENANCY_PASSWORD },
    }),
    200,
    'sign up after release'
  );
  const later = `${admission}; ${responseCookies(signedUp)}`;
  await expectStatus(
    await h.call(`${tenant(a)}/invites/bind`, { cookie: later, body: {} }),
    200,
    'bind'
  );
  await expectStatus(
    await h.call(`${tenant(a)}/invites/redeem`, { cookie: later, body: {} }),
    200,
    'invitation I redeems'
  );
  // A pairing approved while held stays read-only after release.
  expect(
    (
      await h.call(`${tenant(a)}/channels/${channelA}/entries`, {
        bearer: heldEraGrant,
        body: { text: 'held-era grant', idempotencyKey: 'held-era' },
      })
    ).status
  ).toBe(403);
});

it('suspends from a hold revoking everything, and resumes back to the hold still revoked (AC-5)', async () => {
  // Purpose: fails if the kept-credential change leaked into suspension.
  await expectStatus(await host('hold', { deletionNoticeAt: null }), 200, 'hold again');
  expect((await accessRows()).liveGrants).toBeGreaterThan(0);
  await expectStatus(await host('suspend'), 200, 'suspend held');
  expect(await lifecycle()).toMatchObject({
    lifecycle: 'suspended',
    suspended_from_state: 'held',
    held_from_state: 'active',
  });
  expect(await liveAccess()).toEqual({ grants: 0, credentials: 0, agents: 0, invites: 0 });
  await expectStatus(await host('resume'), 200, 'resume to held');
  expect(await lifecycle()).toMatchObject({ lifecycle: 'held', held_from_state: 'active' });
  expect(await liveAccess()).toEqual({ grants: 0, credentials: 0, agents: 0, invites: 0 });
  await expectStatus(await host('release'), 200, 'release');
  expect(await lifecycle()).toMatchObject({ lifecycle: 'active', held_from_state: null });
  expect(
    (await h.call(`${tenant(a)}/channels/${channelA}/entries`, { bearer: memberGrant })).status
  ).toBe(401);
  expect(
    (await h.call(`${tenant(a)}/channels/${channelA}/entries`, { bearer: agentToken })).status
  ).toBe(401);
});

it('refuses host deletion from active, archived, suspended, held without notice, and before the notice date', async () => {
  // Purpose: fails if any gate before host-started deletion is missing.
  const refused = async (label: string) => {
    const response = await hostDelete();
    expect(response.status, label).toBe(409);
  };
  await refused('active');
  // Owner archive still revokes (AC-5): a grant made just before it does not survive.
  await pairInstall(h, a, member.cookie);
  expect((await liveAccess()).grants).toBe(1);
  await expectStatus(
    await h.call(`${tenant(a)}/owner/lifecycle`, {
      cookie: operator.cookie,
      body: {
        action: 'archive',
        lifecycleVersion: (await lifecycle()).lifecycle_version,
        password: TENANCY_PASSWORD,
        confirmName: 'Operator Community',
      },
    }),
    200,
    'owner archives'
  );
  expect((await liveAccess()).grants).toBe(0);
  await refused('archived');
  await expectStatus(await host('suspend'), 200, 'suspend archived');
  await refused('suspended');
  await expectStatus(await host('resume'), 200, 'resume archived');
  await expectStatus(await host('hold', { deletionNoticeAt: null }), 200, 'hold archived');
  expect(await lifecycle()).toMatchObject({ lifecycle: 'held', held_from_state: 'archived' });
  await refused('held without notice');
  await expectStatus(
    await host('set_notice', { deletionNoticeAt: inDays(14.01) }),
    200,
    'publish notice'
  );
  // A published notice cannot be shortened below the minimum, but can be moved later.
  expect((await host('set_notice', { deletionNoticeAt: inDays(10) })).status).toBe(409);
  await expectStatus(await host('set_notice', { deletionNoticeAt: inDays(20) }), 200, 'later');
  const memberships = await h.call('/api/v1/memberships', { cookie: member.cookie });
  expect(
    (await memberships.json()).memberships.find(
      (row: { communityId: string }) => row.communityId === a
    ).deletionNoticeAt
  ).not.toBeNull();
  clockOffsetMs = 19 * DAY;
  await refused('before the notice date');
  // The last eight characters of the id must match, so a script cannot delete the wrong one.
  clockOffsetMs = 21 * DAY;
  const wrongSuffix = await h.call(`/api/v1/host/communities/${a}/deletion`, {
    cookie: operator.cookie,
    body: { lifecycleVersion: (await lifecycle()).lifecycle_version, confirmIdSuffix: b.slice(-8) },
  });
  expect(wrongSuffix.status).toBe(409);
});

it('deletes A after the notice date with a host requester, which only the host can cancel, back to the hold', async () => {
  // Purpose: fails if host deletion skips the seven days, lets the owner cancel it, or a cancel
  // lifts the hold. Host deletion from a hold still revokes (AC-5).
  await pairInstall(h, a, member.cookie, ['read']);
  expect((await liveAccess()).grants).toBe(1);
  const started = await expectStatus(await hostDelete(), 200, 'host deletion');
  expect((await liveAccess()).grants).toBe(0);
  expect(await started.json()).toMatchObject({
    lifecycle: 'deletion_pending',
    deletionRequestedBy: 'host',
  });
  const row = await h.pool.query<{
    delete_requested_at: Date;
    delete_after: Date;
    delete_requested_by: string | null;
    host: string;
  }>(
    `SELECT delete_requested_at,delete_after,delete_requested_by,
            delete_requested_by_host_actor AS host FROM communities WHERE id=$1`,
    [a]
  );
  expect(row.rows[0].delete_after.getTime() - row.rows[0].delete_requested_at.getTime()).toBe(
    7 * DAY
  );
  expect(row.rows[0].delete_requested_by).toBeNull();
  expect(row.rows[0].host).toMatch(/^person:/);

  const status = await expectStatus(
    await h.call(`${tenant(a)}/owner/deletion`, { cookie: operator.cookie }),
    200,
    'owner reads the host deletion'
  );
  expect(await status.json()).toMatchObject({ requestedBy: 'host', returnsTo: 'held' });
  const ownerCancel = await h.call(`${tenant(a)}/owner/deletion/cancel`, {
    cookie: operator.cookie,
    body: { lifecycleVersion: (await lifecycle()).lifecycle_version, password: TENANCY_PASSWORD },
  });
  expect(ownerCancel.status).toBe(409);
  await expectStatus(
    await h.call(`/api/v1/host/communities/${a}/deletion`, {
      method: 'DELETE',
      cookie: operator.cookie,
    }),
    200,
    'host cancels'
  );
  expect(await lifecycle()).toMatchObject({ lifecycle: 'held', held_from_state: 'archived' });
});

it('lets the owner delete a held community, cancels that back to the hold, and keeps the host out of it', async () => {
  // Purpose: fails if the hold traps an owner, if the owner's cancel lifts the hold, or if the
  // host can cancel an owner's deletion. The owner's deletion from a hold still revokes (AC-5).
  await pairInstall(h, a, member.cookie, ['read']);
  expect((await liveAccess()).grants).toBe(1);
  await expectStatus(
    await h.call(`${tenant(a)}/owner/deletion`, {
      cookie: operator.cookie,
      body: {
        lifecycleVersion: (await lifecycle()).lifecycle_version,
        password: TENANCY_PASSWORD,
        confirmName: 'Operator Community',
        confirmIdSuffix: a.slice(-8),
      },
    }),
    200,
    'owner deletes while held'
  );
  expect((await liveAccess()).grants).toBe(0);
  expect(
    (
      await h.call(`/api/v1/host/communities/${a}/deletion`, {
        method: 'DELETE',
        cookie: operator.cookie,
      })
    ).status
  ).toBe(409);
  await expectStatus(
    await h.call(`${tenant(a)}/owner/deletion/cancel`, {
      cookie: operator.cookie,
      body: { lifecycleVersion: (await lifecycle()).lifecycle_version, password: TENANCY_PASSWORD },
    }),
    200,
    'owner cancels'
  );
  expect(await lifecycle()).toMatchObject({ lifecycle: 'held', held_from_state: 'archived' });
});

it('withdraws the notice when a held community is suspended, so days without export never count', async () => {
  // Purpose: the owner cannot export while suspended. If the notice survived, a host could hold
  // with a notice, suspend, wait out the date, resume, and delete with no export window at all.
  await expectStatus(
    await host('set_notice', { deletionNoticeAt: inDays(14.01) }),
    200,
    'publish notice'
  );
  await expectStatus(await host('suspend'), 200, 'suspend the held community');
  const suspended = await h.pool.query('SELECT deletion_notice_at FROM communities WHERE id=$1', [
    a,
  ]);
  expect(suspended.rows[0].deletion_notice_at).toBeNull();
  expect(
    (
      await h.pool.query(
        `SELECT changed_fields FROM host_audit_events
         WHERE community_id=$1 AND action='community.suspend' ORDER BY created_at DESC LIMIT 1`,
        [a]
      )
    ).rows[0].changed_fields
  ).toEqual(['lifecycle', 'deletion_notice_at']);
  clockOffsetMs += 15 * DAY;
  await expectStatus(await host('resume'), 200, 'resume to the hold');
  expect(await lifecycle()).toMatchObject({ lifecycle: 'held' });
  expect((await hostDelete()).status).toBe(409);
});

it('leaves community B untouched by every hold, release, and deletion of A', async () => {
  // Purpose: fails if any host lifecycle change reaches another tenant.
  expect(await tenantRows(b)).toEqual(bBefore);
});

it('keeps who asked for a host deletion in the receipt after the community is gone', async () => {
  // Purpose: host audit rows go with the tenant; without the receipt, nothing would say a host
  // (and which operator or key) deleted the community.
  const held = await h.pool.query<{ deletion_notice_at: Date | null }>(
    'SELECT deletion_notice_at FROM communities WHERE id=$1',
    [a]
  );
  expect(held.rows[0].deletion_notice_at).toBeNull();
  await expectStatus(
    await host('set_notice', { deletionNoticeAt: inDays(14.01) }),
    200,
    'notice again'
  );
  clockOffsetMs += 15 * DAY;
  await expectStatus(await hostDelete(), 200, 'host deletion');
  await h.pool.query(
    `UPDATE communities SET delete_requested_at=now()-interval '8 days',
       delete_after=now()-interval '1 day' WHERE id=$1`,
    [a]
  );
  await h.pool.query(
    `UPDATE community_deletion_jobs SET delete_after=now()-interval '1 day',next_attempt_at=now()
     WHERE community_id=$1`,
    [a]
  );
  for (let pass = 0; pass < 10; pass++) {
    const result = await sweepCommunityDeletions(h.pool, h.blobStore, 100);
    if (result.completed) break;
    await h.pool.query('UPDATE community_deletion_jobs SET next_attempt_at=now()');
  }
  const receipt = await h.pool.query(
    'SELECT requested_by,requested_by_host_actor FROM community_deletion_tombstones WHERE community_id=$1',
    [a]
  );
  const operatorUser = (
    await h.pool.query<{ id: string }>('SELECT id FROM "user" WHERE email=$1', [
      'operator@hold.test',
    ])
  ).rows[0].id;
  expect(receipt.rows).toEqual([
    { requested_by: 'host', requested_by_host_actor: `person:${operatorUser}` },
  ]);
});
