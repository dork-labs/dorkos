/**
 * Host-set community limits and the host usage read (spec `community-host-operator-api` P2,
 * adversarial rows 6-8 and 16). Every limit is a cap, answered with 409 and its own code;
 * lowering one removes nothing; usage carries aggregates only.
 *
 * Tests run in order and share one host whose first community, A, the operator owns.
 */
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assertMemberRoom } from '../host/limits.js';
import { runHostKeyCommand } from '../host-keys.js';
import { responseCookies } from './bootstrap-test-helper.js';
import {
  TENANCY_PASSWORD,
  admit,
  bootstrapHost,
  claimAsNewAccount,
  createChannel,
  createPendingCommunity,
  expectStatus,
  holdingLock,
  pairInstall,
  startTenancyHarness,
  waitForLockWaiters,
  type TenancyHarness,
  type TenancyMember,
} from './tenancy-test-harness.js';
import { drainExports } from './export-test-helpers.js';

const MiB = 1024 * 1024;
let h: TenancyHarness;
let operator: TenancyMember;
let a = '';
let channelA = '';
let keyAll = '';
let keyRead = '';
let otherCommunityMemberId = '';
/** Repeats whichever racing upload landed, with its own key, uploader, and channel. */
let retryOfLanded: () => Promise<Response> = () => Promise.reject(new Error('no upload landed'));

const tenant = (communityId: string) => `/api/v1/communities/${communityId}`;

async function issue(scopes: string[]): Promise<string> {
  const issued = await runHostKeyCommand(h.pool, {
    kind: 'issue',
    label: scopes.join(' '),
    scopes: scopes as never,
    expiresInDays: null,
  });
  if (issued.kind !== 'issue') throw new Error('expected a key');
  return issued.secret;
}

async function usage(communityId: string) {
  const response = await expectStatus(
    await h.call(`/api/v1/host/communities/${communityId}/usage`, { bearer: keyRead }),
    200,
    'usage'
  );
  return response.json();
}

async function setLimits(
  communityId: string,
  limits: { maxActiveMembers: number | null; maxStorageBytes: number | null }
) {
  const { limits: current } = await usage(communityId);
  return expectStatus(
    await h.call(`/api/v1/host/communities/${communityId}/limits`, {
      method: 'PUT',
      bearer: keyAll,
      body: { limitsVersion: current.limitsVersion, ...limits },
    }),
    200,
    'set limits'
  );
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  return (await h.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) t`, params))
    .rows[0].n;
}

async function issueInvite(seats = 1): Promise<string> {
  const issued = await expectStatus(
    await h.call(`${tenant(a)}/invites`, { cookie: operator.cookie, body: { seats } }),
    201,
    'invite'
  );
  return (await issued.json()).token;
}

/** Preflight, sign up, and bind a brand-new account, stopping just before redemption. */
async function boundJoiner(token: string, email: string): Promise<string> {
  const preflight = await expectStatus(
    await h.call(`${tenant(a)}/invites/preflight`, { body: { token } }),
    200,
    `preflight ${email}`
  );
  const admission = responseCookies(preflight);
  const signedUp = await expectStatus(
    await h.call('/api/auth/sign-up/email', {
      body: { name: email.split('@')[0], email, password: TENANCY_PASSWORD },
      cookie: admission,
    }),
    200,
    `sign up ${email}`
  );
  const cookie = `${admission}; ${responseCookies(signedUp)}`;
  await expectStatus(
    await h.call(`${tenant(a)}/invites/bind`, { cookie, body: {} }),
    200,
    `bind ${email}`
  );
  return cookie;
}

const redeem = (cookie: string) => h.call(`${tenant(a)}/invites/redeem`, { cookie, body: {} });

/** Every row of every table, except the ones a limit change is allowed to write. */
async function snapshotOutsideLimits(): Promise<Record<string, unknown>> {
  const tables = (
    await h.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE'
         AND table_name NOT IN ('community_limits','host_audit_events','host_api_keys')
       ORDER BY table_name`
    )
  ).rows.map((row) => row.table_name);
  const result: Record<string, unknown> = {};
  for (const table of tables) {
    result[table] = (
      await h.pool.query(`SELECT to_jsonb(t)::text AS row FROM "${table}" t ORDER BY 1`)
    ).rows;
  }
  return result;
}

function upload(bytes: number, key: string, channelId = channelA, cookie = operator.cookie) {
  return h.call(`${tenant(a)}/channels/${channelId}/attachments`, {
    method: 'POST',
    cookie,
    headers: {
      'content-type': 'text/plain',
      'x-file-name': `${key}.txt`,
      'x-file-size': String(bytes),
      'idempotency-key': key,
    },
    raw: Buffer.alloc(bytes, 'a'),
  });
}

beforeAll(async () => {
  h = await startTenancyHarness('host_limits');
  const host = await bootstrapHost(h, 'Operator', 'operator@limits.test');
  operator = { cookie: host.cookie, memberId: host.memberId };
  a = host.communityId;
  channelA = host.channelId;
  keyAll = await issue([
    'communities:read',
    'communities:write',
    'communities:lifecycle',
    'communities:import',
  ]);
  keyRead = await issue(['communities:read']);
  const other = await createPendingCommunity(h, operator.cookie, 'Other');
  otherCommunityMemberId = (
    await claimAsNewAccount(h, other.token, 'Other Owner', 'other@limits.test')
  ).memberId;
}, 60_000);

afterAll(async () => {
  await h?.close();
});

it('creates a community with limits in one step, and keeps limits in the idempotency key', async () => {
  // Purpose: fails if limits are set outside the creation transaction or left out of the
  // payload hash, so a retry with different limits would silently keep the first ones.
  const body = {
    idempotencyKey: 'create-with-limits',
    name: 'Limited',
    limits: { maxActiveMembers: 5, maxStorageBytes: 1000 },
  };
  const created = await expectStatus(
    await h.call('/api/v1/host/communities', { bearer: keyAll, body }),
    201,
    'create'
  );
  const communityId = (await created.json()).community.id;
  expect((await usage(communityId)).limits).toEqual({
    maxActiveMembers: 5,
    maxStorageBytes: 1000,
    limitsVersion: 1,
  });
  expect((await h.call('/api/v1/host/communities', { bearer: keyAll, body })).status).toBe(200);
  for (const limits of [{ maxActiveMembers: 6, maxStorageBytes: 1000 }, undefined]) {
    const replay = await h.call('/api/v1/host/communities', {
      bearer: keyAll,
      body: { ...body, limits },
    });
    expect(replay.status).toBe(409);
    expect((await replay.json()).code).toBe('IDEMPOTENCY_CONFLICT');
  }
});

it('refuses a fourth member with 409 MEMBER_LIMIT_REACHED, writes nothing, and admits after someone leaves', async () => {
  // Purpose: fails if the cap counts inactive members, runs after the insert, is a rate, or
  // stays refused after a seat frees up.
  await admit(h, a, operator.cookie, { name: 'Second', email: 'second@limits.test' });
  await setLimits(a, { maxActiveMembers: 3, maxStorageBytes: null });
  const fourth = await boundJoiner(await issueInvite(), 'fourth@limits.test');
  const third = await admit(h, a, operator.cookie, { name: 'Third', email: 'third@limits.test' });

  const before = {
    members: await count('SELECT 1 FROM members'),
    handles: await count('SELECT 1 FROM community_handles'),
    uses: await count('SELECT 1 FROM invite_uses'),
  };
  const refused = await redeem(fourth);
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({
    code: 'MEMBER_LIMIT_REACHED',
    message: 'This community is full. Ask its owner to make room.',
  });
  expect({
    members: await count('SELECT 1 FROM members'),
    handles: await count('SELECT 1 FROM community_handles'),
    uses: await count('SELECT 1 FROM invite_uses'),
  }).toEqual(before);

  // A new invitation says so before anyone signs up.
  const preview = await h.call(`${tenant(a)}/invites/preview`, {
    body: { token: await issueInvite() },
  });
  expect(preview.status).toBe(409);
  expect((await preview.json()).code).toBe('MEMBER_LIMIT_REACHED');

  await expectStatus(
    await h.call(`${tenant(a)}/me/leave`, {
      cookie: third.cookie,
      body: { password: TENANCY_PASSWORD, communityName: 'Operator Community' },
    }),
    204,
    'third leaves'
  );
  await expectStatus(await redeem(fourth), 200, 'fourth joins after a seat frees');
});

it('lets exactly one of two admissions racing for the last seat through', async () => {
  // Purpose: fails without the limit row lock, when both would count two seats taken.
  await setLimits(a, { maxActiveMembers: 4, maxStorageBytes: null });
  const token = await issueInvite(2);
  const fifth = await boundJoiner(token, 'fifth@limits.test');
  const sixth = await boundJoiner(token, 'sixth@limits.test');
  const statuses = await holdingLock(
    h,
    'SELECT 1 FROM community_limits WHERE community_id=$1 FOR UPDATE',
    [a],
    async (release) => {
      const racing = [redeem(fifth), redeem(sixth)];
      await waitForLockWaiters(h, 2);
      await release();
      return (await Promise.all(racing)).map((response) => response.status).sort();
    }
  );
  expect(statuses).toEqual([200, 409]);
  expect(await count('SELECT 1 FROM members WHERE community_id=$1 AND active', [a])).toBe(4);
});

it('lets a channel invitation and an upload to that channel commit together without a deadlock', async () => {
  // Purpose: an upload holds its channel and then checks the file limit; a channel invitation
  // holds the member limit and then joins that channel. If the upload locked the limit row too,
  // each would wait on the other and one would fail.
  await setLimits(a, { maxActiveMembers: 100, maxStorageBytes: 1024 * MiB });
  // The uploader is not the inviter: the invitation also locks its issuer's member row, which
  // is a different ordering from the one under test here.
  const uploaderCookie = await signIn('second@limits.test');
  const room = await createChannel(h, a, operator.cookie, 'join-and-upload', [uploaderCookie]);
  const issued = await expectStatus(
    await h.call(`${tenant(a)}/invites`, {
      cookie: operator.cookie,
      body: { seats: 1, channelId: room },
    }),
    201,
    'channel invite'
  );
  const joiner = await boundJoiner((await issued.json()).token, 'channel@limits.test');
  const [joined, uploaded] = await holdingLock(
    h,
    'SELECT 1 FROM community_limits WHERE community_id=$1 FOR UPDATE',
    [a],
    async (release) => {
      const joining = redeem(joiner);
      await waitForLockWaiters(h, 1, 'community_limits');
      const uploading = upload(1, 'during-join', room, uploaderCookie);
      // Before the fix the upload queued behind the join's limit lock; now it never waits there.
      await Promise.race([uploading, waitForLockWaiters(h, 2).catch(() => undefined)]);
      await release();
      return Promise.all([joining, uploading]);
    }
  );
  expect([joined.status, uploaded.status]).toEqual([200, 201]);
  // The joiner took their seat; free it again for the tests that count four.
  await expectStatus(
    await h.call(`${tenant(a)}/me/leave`, {
      cookie: joiner,
      body: { password: TENANCY_PASSWORD, communityName: 'Operator Community' },
    }),
    204,
    'channel joiner leaves'
  );
  await setLimits(a, { maxActiveMembers: 4, maxStorageBytes: null });
});

it('lets a channel invitation and its own issuer uploading to that channel commit without a deadlock', async () => {
  // Purpose: DOR-2277. Redeeming locks the issuer's member row and then the invitation's
  // channel (the channel_members insert needs it); the issuer's upload locks the channel and
  // then its own member row. With the member row held so both queue up behind it, the old
  // opposite order made one of them fail with a deadlock. Both must now commit.
  await setLimits(a, { maxActiveMembers: 100, maxStorageBytes: 1024 * MiB });
  const room = await createChannel(h, a, operator.cookie, 'issuer-uploads');
  const issued = await expectStatus(
    await h.call(`${tenant(a)}/invites`, {
      cookie: operator.cookie,
      body: { seats: 1, channelId: room },
    }),
    201,
    'channel invite'
  );
  const joiner = await boundJoiner((await issued.json()).token, 'issuer-race@limits.test');
  const [joined, uploaded] = await holdingLock(
    h,
    'SELECT 1 FROM members WHERE id=$1 FOR UPDATE',
    [operator.memberId],
    async (release) => {
      // The redemption queues on the issuer's row first, then the upload joins the queue.
      const joining = redeem(joiner);
      await waitForLockWaiters(h, 1);
      const uploading = upload(1, 'issuer-during-join', room, operator.cookie);
      await waitForLockWaiters(h, 2);
      await release();
      return Promise.all([joining, uploading]);
    }
  );
  expect([joined.status, uploaded.status]).toEqual([200, 201]);
  expect(
    await count('SELECT 1 FROM channel_members WHERE channel_id=$1 AND member_id=$2', [
      room,
      (await joined.json()).memberId,
    ])
  ).toBe(1);
  await expectStatus(
    await h.call(`${tenant(a)}/me/leave`, {
      cookie: joiner,
      body: { password: TENANCY_PASSWORD, communityName: 'Operator Community' },
    }),
    204,
    'issuer-race joiner leaves'
  );
  await setLimits(a, { maxActiveMembers: 4, maxStorageBytes: null });
});

it('lets only one of two first limit writes through', async () => {
  // Purpose: with no limit row yet there is nothing to lock, so both would pass the version
  // check; only the write itself can refuse the loser.
  const fresh = await createPendingCommunity(h, operator.cookie, 'Fresh limits');
  const statuses = await holdingLock(
    h,
    'SELECT 1 FROM communities WHERE id=$1 FOR UPDATE',
    [fresh.communityId],
    async (release) => {
      const writes = [1, 2].map((members) =>
        h.call(`/api/v1/host/communities/${fresh.communityId}/limits`, {
          method: 'PUT',
          bearer: keyAll,
          body: { limitsVersion: 1, maxActiveMembers: members, maxStorageBytes: null },
        })
      );
      await waitForLockWaiters(h, 2, 'FOR SHARE');
      await release();
      return (await Promise.all(writes)).map((response) => response.status).sort();
    }
  );
  expect(statuses).toEqual([200, 409]);
  expect((await usage(fresh.communityId)).limits.limitsVersion).toBe(2);
});

it('never counts an already active member twice', async () => {
  // Purpose: fails if re-admitting someone who is already in counts them as a new seat.
  const client = await h.pool.connect();
  try {
    await client.query('BEGIN');
    await expect(assertMemberRoom(client, a, { lock: true })).rejects.toMatchObject({
      code: 'MEMBER_LIMIT_REACHED',
    });
    const operatorUser = await client.query<{ user_id: string }>(
      'SELECT user_id FROM members WHERE id=$1',
      [operator.memberId]
    );
    await assertMemberRoom(client, a, { lock: true, userId: operatorUser.rows[0].user_id });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

it('rows 6, 7, 8, and 16: a key lowers limits without removing anything, overrides one member, and is audited', async () => {
  // Purpose: fails if lowering a limit deletes or disables anything, if the override leaks who
  // the member is, if it reaches a member of another community, or if audit rows lose the key.
  const before = await snapshotOutsideLimits();
  await setLimits(a, { maxActiveMembers: 1, maxStorageBytes: 0 });
  expect(await snapshotOutsideLimits()).toEqual(before);
  const fullToken = await issueInvite();
  for (const step of ['preview', 'preflight']) {
    const refusal = await h.call(`${tenant(a)}/invites/${step}`, { body: { token: fullToken } });
    expect(refusal.status, step).toBe(409);
    expect((await refusal.json()).code, step).toBe('MEMBER_LIMIT_REACHED');
    // Someone already in the community takes no new seat, so their link still opens.
    const member = await h.call(`${tenant(a)}/invites/${step}`, {
      body: { token: fullToken },
      cookie: operator.cookie,
    });
    expect(member.status, `${step} as a member`).toBe(200);
  }
  const refusedUpload = await upload(1, 'below-limit');
  expect(refusedUpload.status).toBe(409);
  expect((await refusedUpload.json()).code).toBe('STORAGE_LIMIT_REACHED');

  const stale = await h.call(`/api/v1/host/communities/${a}/limits`, {
    method: 'PUT',
    bearer: keyAll,
    body: { limitsVersion: 1, maxActiveMembers: null, maxStorageBytes: null },
  });
  expect(stale.status).toBe(409);
  expect((await stale.json()).code).toBe('STATE_CONFLICT');
  const readOnly = await h.call(`/api/v1/host/communities/${a}/limits`, {
    method: 'PUT',
    bearer: keyRead,
    body: { limitsVersion: 1, maxActiveMembers: null, maxStorageBytes: null },
  });
  expect(readOnly.status).toBe(403);
  await setLimits(a, { maxActiveMembers: null, maxStorageBytes: null });

  const override = await expectStatus(
    await h.call(`/api/v1/host/communities/${a}/members/${operator.memberId}/limits`, {
      method: 'PUT',
      bearer: keyAll,
      body: { agentsPerMember: 150 },
    }),
    200,
    'override'
  );
  const overrideBody = await override.json();
  expect(overrideBody).toEqual({
    communityId: a,
    memberId: operator.memberId,
    agentsPerMember: 150,
    effectiveAgentsPerMember: 150,
  });
  const text = JSON.stringify(overrideBody);
  for (const identity of ['Operator', 'operator@limits.test', 'owner']) {
    expect(text).not.toContain(identity);
  }
  for (const memberId of [otherCommunityMemberId, randomUUID(), 'not-a-uuid']) {
    const missing = await h.call(`/api/v1/host/communities/${a}/members/${memberId}/limits`, {
      method: 'PUT',
      bearer: keyAll,
      body: { agentsPerMember: 5 },
    });
    expect(missing.status, memberId).toBe(404);
  }
  const cleared = await expectStatus(
    await h.call(`/api/v1/host/communities/${a}/members/${operator.memberId}/limits`, {
      method: 'PUT',
      bearer: keyAll,
      body: { agentsPerMember: null },
    }),
    200,
    'clear override'
  );
  expect((await cleared.json()).effectiveAgentsPerMember).toBe(20);
  const overrideTooHigh = await h.call(
    `/api/v1/host/communities/${a}/members/${operator.memberId}/limits`,
    { method: 'PUT', bearer: keyAll, body: { agentsPerMember: 1001 } }
  );
  expect(overrideTooHigh.status).toBe(400);

  const audit = await h.pool.query(
    `SELECT action,actor_kind,actor_user_id,actor_api_key_id IS NOT NULL AS has_key,changed_fields
     FROM host_audit_events WHERE community_id=$1 AND action IN ('community.limits','member.limits')
     ORDER BY created_at,id`,
    [a]
  );
  expect(audit.rows.length).toBeGreaterThanOrEqual(5);
  for (const row of audit.rows) {
    expect(row).toMatchObject({ actor_kind: 'api_key', actor_user_id: null, has_key: true });
  }
  expect(audit.rows.filter((row) => row.action === 'member.limits')).toEqual([
    expect.objectContaining({ changed_fields: ['agents_per_member'] }),
    expect.objectContaining({ changed_fields: ['agents_per_member'] }),
  ]);
});

it('lets only one of two concurrent uploads that would jointly pass the storage limit commit', async () => {
  // Purpose: fails without the per-community advisory lock, when both would commit.
  const counted = (await usage(a)).storage.countedBytes;
  await setLimits(a, { maxActiveMembers: null, maxStorageBytes: counted + 10 * MiB });
  // Two people in two channels, so neither the channel nor the uploader's row lock serializes
  // them: only the storage lock can. Holding that lock makes both uploads store their bytes and
  // wait at the final check together.
  const secondCookie = await signIn('second@limits.test');
  const otherChannel = await createChannel(h, a, operator.cookie, 'second-room', [secondCookie]);
  const [first, second] = await holdingLock(
    h,
    "SELECT pg_advisory_xact_lock(hashtext('dorkos:storage:' || $1::text))",
    [a],
    async (release) => {
      const racing = [
        upload(6 * MiB, 'six-a'),
        upload(6 * MiB, 'six-b', otherChannel, secondCookie),
      ];
      await waitForLockWaiters(h, 2, 'pg_advisory_xact_lock');
      await release();
      return Promise.all(racing);
    }
  );
  const statuses = [first.status, second.status].sort();
  expect(statuses).toEqual([201, 409]);
  const refused = first.status === 409 ? first : second;
  retryOfLanded = () =>
    first.status === 201
      ? upload(6 * MiB, 'six-a')
      : upload(6 * MiB, 'six-b', otherChannel, secondCookie);
  expect((await refused.json()).code).toBe('STORAGE_LIMIT_REACHED');
  expect((await usage(a)).storage.countedBytes).toBe(counted + 6 * MiB);
  // The refused reservation is queued for deletion, never left counted or dangling.
  expect(
    await count(
      `SELECT 1 FROM managed_blobs WHERE community_id=$1 AND state IN ('reserved','stored')`,
      [a]
    )
  ).toBe(0);

  // The declared size is refused before any bytes are sent or any file is reserved.
  const reservations = await count('SELECT 1 FROM managed_blobs WHERE community_id=$1', [a]);
  const early = await upload(6 * MiB, 'six-c');
  expect(early.status).toBe(409);
  expect(await count('SELECT 1 FROM managed_blobs WHERE community_id=$1', [a])).toBe(reservations);
});

it('always lets the owner export, refuses a larger icon, and frees space when the icon is removed', async () => {
  // Purpose: fails if exports count against the limit, if bytes queued for deletion do, if an
  // over-limit icon slips past either check, or if a same-size replacement is refused.
  const counted = (await usage(a)).storage.countedBytes;
  await setLimits(a, { maxActiveMembers: null, maxStorageBytes: counted });
  const exported = await expectStatus(
    await h.call(`${tenant(a)}/owner/export`, {
      cookie: operator.cookie,
      body: { password: TENANCY_PASSWORD },
    }),
    202,
    'export at the limit'
  );
  // The background job stores every segment although the community is at its limit.
  await drainExports(h.pool, h.blobStore);
  const ready = await h.pool.query('SELECT state FROM export_archives WHERE id=$1', [
    (await exported.json()).export.id,
  ]);
  expect(ready.rows[0].state).toBe('ready');

  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 1)]);
  await setLimits(a, { maxActiveMembers: null, maxStorageBytes: counted + png.length });
  const settings = await h.call(`${tenant(a)}/settings`, { cookie: operator.cookie });
  const version = (await settings.json()).settingsVersion;
  const icon = await expectStatus(
    await h.call(`${tenant(a)}/settings/icon`, {
      method: 'PUT',
      cookie: operator.cookie,
      headers: { 'if-match': `"${version}"`, 'content-type': 'image/png' },
      raw: png,
    }),
    200,
    'icon'
  );
  let afterIcon = (await icon.json()).settingsVersion;
  expect((await upload(1, 'full')).status).toBe(409);

  // Over the limit, an icon no larger than the current one can still replace it; a larger one
  // is refused on its declared size, and, sent without a size, by the check at commit.
  await setLimits(a, { maxActiveMembers: null, maxStorageBytes: counted });
  const putIcon = (bytes: Buffer, init: { chunked?: boolean } = {}) =>
    fetch(`${h.baseUrl}${tenant(a)}/settings/icon`, {
      method: 'PUT',
      headers: {
        cookie: operator.cookie,
        origin: h.config.publicUrl,
        'if-match': `"${afterIcon}"`,
        'content-type': 'image/png',
      },
      body: init.chunked
        ? new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(bytes));
              controller.close();
            },
          })
        : bytes,
      ...(init.chunked ? { duplex: 'half' } : {}),
    } as RequestInit);
  const same = await putIcon(Buffer.concat([png.subarray(0, 8), Buffer.alloc(64, 2)]));
  expect(same.status).toBe(200);
  afterIcon = (await same.json()).settingsVersion;
  const larger = Buffer.concat([png.subarray(0, 8), Buffer.alloc(128, 3)]);
  // Refused before its body is read, the server closes that connection; send it on a socket of
  // its own so no later request reuses the closed one.
  const refusedDeclared = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = httpRequest(
      `${h.baseUrl}${tenant(a)}/settings/icon`,
      {
        method: 'PUT',
        agent: false,
        headers: {
          cookie: operator.cookie,
          origin: h.config.publicUrl,
          'if-match': `"${afterIcon}"`,
          'content-type': 'image/png',
          'content-length': larger.length,
        },
      },
      (response) => {
        let body = '';
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      }
    );
    outgoing.on('error', reject);
    outgoing.end(larger);
  });
  expect(refusedDeclared.status).toBe(409);
  expect(JSON.parse(refusedDeclared.body).code).toBe('STORAGE_LIMIT_REACHED');
  const blobsBefore = await count(
    "SELECT 1 FROM managed_blobs WHERE community_id=$1 AND state IN ('reserved','stored')",
    [a]
  );
  const refusedAtCommit = await putIcon(larger, { chunked: true });
  expect(refusedAtCommit.status).toBe(409);
  expect((await refusedAtCommit.json()).code).toBe('STORAGE_LIMIT_REACHED');
  expect(
    await count(
      "SELECT 1 FROM managed_blobs WHERE community_id=$1 AND state IN ('reserved','stored')",
      [a]
    )
  ).toBe(blobsBefore);
  await setLimits(a, { maxActiveMembers: null, maxStorageBytes: counted + png.length });
  // A retry of an upload that already landed still gets its receipt while the space is full.
  expect((await retryOfLanded()).status).toBe(200);
  await expectStatus(
    await h.call(`${tenant(a)}/settings/icon`, {
      method: 'DELETE',
      cookie: operator.cookie,
      headers: { 'if-match': `"${afterIcon}"` },
    }),
    200,
    'delete icon'
  );
  await expectStatus(await upload(1, 'freed'), 201, 'upload into freed space');
  await setLimits(a, { maxActiveMembers: null, maxStorageBytes: null });
  // Leave an icon in place, so the usage report below counts one.
  const settingsNow = await h.call(`${tenant(a)}/settings`, { cookie: operator.cookie });
  await expectStatus(
    await h.call(`${tenant(a)}/settings/icon`, {
      method: 'PUT',
      cookie: operator.cookie,
      headers: {
        'if-match': `"${(await settingsNow.json()).settingsVersion}"`,
        'content-type': 'image/png',
      },
      raw: png,
    }),
    200,
    'final icon'
  );
});

it('caps active agents per person with 409 AGENT_LIMIT_REACHED, honouring one member’s override only', async () => {
  // Purpose: fails if the cap is still 429, if the default moved from 20, or if an override
  // is community-wide or ignored.
  const enroll = (bearer: string, id: string) =>
    h.call(`${tenant(a)}/agents`, {
      bearer,
      body: { localAgentId: id, displayName: `Agent ${id}` },
    });
  const operatorGrant = await pairInstall(h, a, operator.cookie);
  for (let index = 1; index <= 20; index++)
    await expectStatus(await enroll(operatorGrant, `op-${index}`), 201, `agent ${index}`);
  const twentyFirst = await enroll(operatorGrant, 'op-21');
  expect(twentyFirst.status).toBe(409);
  expect(await twentyFirst.json()).toEqual({
    code: 'AGENT_LIMIT_REACHED',
    message: 'You have reached your agent limit in this community.',
  });

  h.config.limits.agentsPerOwner = 100;
  try {
    for (let index = 21; index <= 100; index++)
      await expectStatus(await enroll(operatorGrant, `op-${index}`), 201, `agent ${index}`);
    expect((await enroll(operatorGrant, 'op-101')).status).toBe(409);
    await expectStatus(
      await h.call(`/api/v1/host/communities/${a}/members/${operator.memberId}/limits`, {
        method: 'PUT',
        bearer: keyAll,
        body: { agentsPerMember: 150 },
      }),
      200,
      'override'
    );
    await expectStatus(await enroll(operatorGrant, 'op-101'), 201, 'agent 101 with override');

    const secondGrant = await pairInstall(h, a, await signIn('second@limits.test'));
    for (let index = 1; index <= 100; index++)
      await expectStatus(await enroll(secondGrant, `second-${index}`), 201, `second ${index}`);
    expect((await enroll(secondGrant, 'second-101')).status).toBe(409);
  } finally {
    h.config.limits.agentsPerOwner = 20;
  }
}, 120_000);

/** Sign an existing account in and return its session cookie. */
async function signIn(email: string): Promise<string> {
  const signedIn = await expectStatus(
    await h.call('/api/auth/sign-in/email', { body: { email, password: TENANCY_PASSWORD } }),
    200,
    `sign in ${email}`
  );
  return responseCookies(signedIn);
}

it('reports usage equal to independently computed sums, and nothing that names anyone', async () => {
  // Purpose: fails if the usage projection widens to names or content, or its sums drift.
  await expectStatus(
    await h.call(`${tenant(a)}/channels/${channelA}/entries`, {
      cookie: operator.cookie,
      body: { text: 'Quiet words in the general channel', idempotencyKey: 'usage-post' },
    }),
    201,
    'post'
  );
  const report = await usage(a);
  const bytes = async (where: string) =>
    Number(
      (
        await h.pool.query<{ n: string }>(
          `SELECT COALESCE(sum(byte_size),0)::text AS n FROM managed_blobs
           WHERE community_id=$1 AND ${where}`,
          [a]
        )
      ).rows[0].n
    );
  const newest = await h.pool.query<{ created_at: Date }>(
    'SELECT created_at FROM entries WHERE community_id=$1 ORDER BY created_at DESC LIMIT 1',
    [a]
  );
  const attachmentBytes = Number(
    (
      await h.pool.query<{ n: string }>(
        'SELECT COALESCE(sum(byte_size),0)::text AS n FROM attachments WHERE community_id=$1',
        [a]
      )
    ).rows[0].n
  );
  expect(report).toEqual({
    communityId: a,
    measuredAt: expect.any(String),
    activeMembers: await count('SELECT 1 FROM members WHERE community_id=$1 AND active', [a]),
    activeAgents: await count('SELECT 1 FROM agents WHERE community_id=$1 AND active', [a]),
    storage: {
      attachmentBytes,
      iconBytes: await bytes("purpose='icon' AND state IN ('stored','committed')"),
      exportBytes: await bytes("purpose='export' AND state IN ('stored','committed')"),
      importStagingBytes: 0,
      pendingDeleteBytes: await bytes("state='pending_delete'"),
      countedBytes:
        attachmentBytes + (await bytes("purpose='icon' AND state IN ('stored','committed')")),
    },
    limits: { maxActiveMembers: null, maxStorageBytes: null, limitsVersion: expect.any(Number) },
    lastPostDate: newest.rows[0].created_at.toISOString().slice(0, 10),
  });
  expect(report.storage.exportBytes).toBeGreaterThan(0);
  expect(report.storage.iconBytes).toBe(72);
  const text = JSON.stringify(report);
  for (const identity of [
    'Operator',
    'Second',
    'operator@limits.test',
    'general',
    'Quiet words',
    'six-a.txt',
    'Agent op-1',
  ]) {
    expect(text).not.toContain(identity);
  }
});

it('pages usage for every community exactly once, with a day-only last post date', async () => {
  // Purpose: fails if the page cursor skips or repeats a community, or if the date leaks a time.
  await h.pool.query(
    "INSERT INTO communities(name) SELECT 'Bulk '||g FROM generate_series(1,250) g"
  );
  const all = (await h.pool.query<{ id: string }>('SELECT id FROM communities ORDER BY id')).rows;
  const seen: string[] = [];
  let after: string | null = null;
  let pages = 0;
  do {
    const response = await expectStatus(
      await h.call(`/api/v1/host/usage?limit=100${after ? `&after=${after}` : ''}`, {
        bearer: keyRead,
      }),
      200,
      'usage page'
    );
    const page = (await response.json()) as {
      items: { communityId: string; lastPostDate: string | null }[];
      next: string | null;
    };
    pages++;
    for (const item of page.items) {
      seen.push(item.communityId);
      if (item.communityId === a) expect(item.lastPostDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      else expect(item.lastPostDate).toBeNull();
    }
    after = page.next;
  } while (after);
  expect(pages).toBe(3);
  expect(seen).toEqual(all.map((row) => row.id));
  expect((await h.call('/api/v1/host/usage?limit=101', { bearer: keyRead })).status).toBe(400);
  expect(
    (await h.call(`/api/v1/host/communities/${randomUUID()}/usage`, { bearer: keyRead })).status
  ).toBe(404);
});
