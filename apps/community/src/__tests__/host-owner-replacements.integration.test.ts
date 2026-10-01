/**
 * A host requests, lists, cancels, and reissues an owner replacement
 * (specs/community-owner-replacement, task 2.2: AC-1, AC-2, AC-3, AC-7 and AC-10 request halves,
 * AC-13, AC-14, AC-20 request half, AC-21). Real PostgreSQL through the tenancy harness.
 *
 * Four hosts: `h` has mail, stub notice composers, and an injected clock; `sso` has the same and
 * single sign-on; `mailOnly` has mail but no composers, like a server whose worker cannot yet
 * write these notices; `bare` has no mail at all. No test starts a mail worker, so nothing is
 * ever sent: a notice is only queued.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommunityAdminHostCapabilitiesSchema,
  CommunityAdminHostProjectionSchema,
  CommunityAdminOwnerReplacementClaimTokenSchema,
  CommunityAdminOwnerReplacementCreateResponseSchema,
  CommunityAdminOwnerReplacementListSchema,
  CommunityAdminOwnerReplacementSchema,
} from '@dorkos/shared/community-admin-wire';
import { plainTextMail } from '../mail/messages.js';
import { NOTICE_KINDS } from '../mail/outbox.js';
import type { NoticeComposers } from '../mail/worker.js';
import { formatReplacementDate } from '../owner-replacement/dates.js';
import { hashSecret } from '../security.js';
import {
  TENANCY_PASSWORD,
  bootstrapHost,
  claimAsNewAccount,
  createPendingCommunity,
  expectStatus,
  holdingLock,
  startTenancyHarness,
  waitForBlockedBy,
  waitForLockWaiters,
  type TenancyHarness,
} from './tenancy-test-harness.js';

const DAY = 24 * 60 * 60_000;
const COOLDOWN_DAYS = 90;
const SMTP_ENV = {
  COMMUNITY_SMTP_URL: 'smtp://127.0.0.1:2525',
  COMMUNITY_MAIL_FROM: 'notices@community.test',
};
const ISSUER = 'https://issuer.community.test';
const SUBJECT = 'subject-of-the-new-owner-4471';
const REFERENCE = 'CASE-4471';

let h: TenancyHarness;
let sso: TenancyHarness;
let bare: TenancyHarness;
let mailOnly: TenancyHarness;
/** A composer for every kind, as a server whose worker can write every notice would have. */
const STUB_COMPOSERS = Object.fromEntries(
  NOTICE_KINDS.map((kind) => [kind, async () => plainTextMail('Stub', ['Stub notice.'])])
) as NoticeComposers;
/** The server's injected clock. Tests move dates in the database relative to it instead. */
const clock = () => new Date();
const operator = {} as Record<'h' | 'sso' | 'bare' | 'mailOnly', string>;
type Key = { id: string; secret: string; prefix: string };
const keys = {} as Record<
  'ownership' | 'second' | 'everyOther' | 'read' | 'bare' | 'mailOnly',
  Key
>;
let counter = 0;

/** A community owned by a fresh account that is not a host operator. */
interface Owned {
  communityId: string;
  name: string;
  ownerCookie: string;
  ownerMemberId: string;
  ownerName: string;
  ownerEmail: string;
}
const owned: Owned[] = [];

/** Every host response a test read, for the no-member-data scan. */
const seen: { label: string; text: string }[] = [];

async function read(label: string, response: Response): Promise<Response> {
  seen.push({ label, text: await response.clone().text() });
  return response;
}

async function body<T>(response: Response, status: number, step: string): Promise<T> {
  await expectStatus(response, status, step);
  return (await response.json()) as T;
}

async function issueKey(harness: TenancyHarness, cookie: string, scopes: string[]): Promise<Key> {
  const issued = await body<{ key: { id: string; prefix: string }; secret: string }>(
    await harness.call('/api/v1/host/api-keys', {
      cookie,
      body: { label: `Key ${++counter}`, scopes, expiresInDays: null, password: TENANCY_PASSWORD },
    }),
    201,
    'issue key'
  );
  return { id: issued.key.id, secret: issued.secret, prefix: issued.key.prefix };
}

async function ownedCommunity(harness: TenancyHarness, cookie: string): Promise<Owned> {
  const n = ++counter;
  const name = `Replaced Community ${n}`;
  const { communityId, token } = await createPendingCommunity(harness, cookie, name);
  const ownerName = `Owner Person ${n}`;
  const ownerEmail = `owner-${n}-${randomUUID()}@owner.test`;
  const owner = await claimAsNewAccount(harness, token, ownerName, ownerEmail);
  const community = {
    communityId,
    name,
    ownerCookie: owner.cookie,
    ownerMemberId: owner.memberId,
    ownerName,
    ownerEmail,
  };
  owned.push(community);
  return community;
}

async function lifecycleVersion(harness: TenancyHarness, communityId: string): Promise<number> {
  return (
    await harness.pool.query<{ lifecycle_version: number }>(
      'SELECT lifecycle_version FROM communities WHERE id=$1',
      [communityId]
    )
  ).rows[0].lifecycle_version;
}

type Auth = { cookie?: string; bearer?: string };
type RequestBody = Record<string, unknown>;

/** POST a replacement request; a cookie caller sends the right password unless told otherwise. */
async function request(
  harness: TenancyHarness,
  communityId: string,
  auth: Auth,
  overrides: RequestBody = {}
): Promise<Response> {
  const payload: RequestBody = {
    idempotencyKey: `request-${++counter}`,
    lifecycleVersion: await lifecycleVersion(harness, communityId).catch(() => 1),
    reason: 'owner_unreachable',
    reference: REFERENCE,
    claimant: { oidcSubject: null },
    ...(auth.cookie ? { password: TENANCY_PASSWORD } : {}),
    ...overrides,
  };
  for (const [field, value] of Object.entries(payload))
    if (value === undefined) delete payload[field];
  return read(
    `request ${communityId}`,
    await harness.call(`/api/v1/host/communities/${communityId}/owner-replacements`, {
      ...auth,
      body: payload,
    })
  );
}

async function created(response: Response, status = 201) {
  return CommunityAdminOwnerReplacementCreateResponseSchema.parse(
    await body(response, status, 'request replacement')
  );
}

async function hostCall(harness: TenancyHarness, path: string, auth: Auth, payload?: unknown) {
  return read(path, await harness.call(`/api/v1/host${path}`, { ...auth, body: payload }));
}

function cancel(harness: TenancyHarness, communityId: string, id: string, auth: Auth) {
  return hostCall(harness, `/communities/${communityId}/owner-replacements/${id}/cancel`, auth, {});
}

function reissue(harness: TenancyHarness, communityId: string, id: string, auth: Auth) {
  return hostCall(
    harness,
    `/communities/${communityId}/owner-replacements/${id}/claim-token`,
    auth,
    {}
  );
}

async function replacementRow(harness: TenancyHarness, id: string) {
  return (
    await harness.pool.query<Record<string, unknown>>(
      'SELECT * FROM owner_replacements WHERE id=$1',
      [id]
    )
  ).rows[0];
}

async function replacementCount(harness: TenancyHarness, communityId: string) {
  return (
    await harness.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM owner_replacements WHERE community_id=$1',
      [communityId]
    )
  ).rows[0].count;
}

async function outbox(harness: TenancyHarness, subjectId: string) {
  return (
    await harness.pool.query<{ kind: string; recipient_user_id: string; community_id: string }>(
      'SELECT kind,recipient_user_id,community_id FROM notice_outbox WHERE subject_id=$1 ORDER BY created_at,kind',
      [subjectId]
    )
  ).rows;
}

async function userIdOf(harness: TenancyHarness, memberId: string) {
  return (
    await harness.pool.query<{ user_id: string }>('SELECT user_id FROM members WHERE id=$1', [
      memberId,
    ])
  ).rows[0].user_id;
}

async function hostAudits(
  harness: TenancyHarness,
  communityId: string,
  prefix = 'owner_replacement'
) {
  return (
    await harness.pool.query<{
      action: string;
      actor_kind: string;
      actor_user_id: string | null;
      actor_api_key_id: string | null;
    }>(
      `SELECT action,actor_kind,actor_user_id,actor_api_key_id FROM host_audit_events
       WHERE community_id=$1 AND action LIKE $2 ORDER BY created_at,id`,
      [communityId, `${prefix}%`]
    )
  ).rows;
}

async function tenantAudits(harness: TenancyHarness, communityId: string) {
  return (
    await harness.pool.query<{
      action: string;
      actor_kind: string;
      actor_member_id: string | null;
      subject_id: string | null;
    }>(
      `SELECT action,actor_kind,actor_member_id,subject_id FROM audit_events
       WHERE community_id=$1 AND action LIKE 'owner.replacement.%' ORDER BY created_at,id`,
      [communityId]
    )
  ).rows;
}

/** Close a replacement directly, as a later task's owner, worker, or transfer would. */
async function closeDirectly(
  harness: TenancyHarness,
  id: string,
  state: 'objected' | 'superseded' | 'expired',
  endedAt: Date
) {
  const expired =
    state === 'expired'
      ? `,notice_state='accepted',notice_resolved_at=$2::timestamptz - interval '40 days',
         claimable_after=$2::timestamptz - interval '20 days',
         claim_expires_at=$2::timestamptz - interval '6 days'`
      : '';
  await harness.pool.query(
    `UPDATE owner_replacements SET state=$3,ended_at=$2,claim_token_hash=NULL,
       claimant_oidc_issuer=NULL,claimant_oidc_subject=NULL${expired}
     WHERE id=$1`,
    [id, endedAt, state]
  );
}

/** Open a replacement directly, for a host whose request route refuses to open one. */
async function seedOpenReplacement(harness: TenancyHarness, c: Owned, key: Key) {
  const id = randomUUID();
  const token = randomUUID();
  await harness.pool.query(
    `INSERT INTO owner_replacements(id,community_id,reason,claimant_named,claim_token_hash,
       requested_by_host_actor,idempotency_key,payload_hash,after_objection,after_withdrawal,
       prior_owner_member_id,requested_at)
     VALUES($1,$2,'other',false,$3,$4,'seeded',$5,false,false,$6,now())`,
    [
      id,
      c.communityId,
      hashSecret(token),
      `api_key:${key.id}`,
      createHash('sha256').update(id).digest('hex'),
      c.ownerMemberId,
    ]
  );
  return { id, token };
}

beforeAll(async () => {
  h = await startTenancyHarness('owner_replace', {
    now: clock,
    env: SMTP_ENV,
    noticeComposers: STUB_COMPOSERS,
  });
  sso = await startTenancyHarness('owner_replace_sso', {
    env: {
      ...SMTP_ENV,
      COMMUNITY_OIDC_ISSUER_URL: ISSUER,
      COMMUNITY_OIDC_CLIENT_ID: 'community-client',
      COMMUNITY_OIDC_CLIENT_SECRET: 'community-client-secret',
    },
    noticeComposers: STUB_COMPOSERS,
  });
  bare = await startTenancyHarness('owner_replace_bare');
  mailOnly = await startTenancyHarness('owner_replace_mailonly', {
    env: SMTP_ENV,
  });
  operator.h = (await bootstrapHost(h, 'Hana Host', 'hana@host.test')).cookie;
  operator.sso = (await bootstrapHost(sso, 'Sora Host', 'sora@host.test')).cookie;
  operator.bare = (await bootstrapHost(bare, 'Bo Host', 'bo@host.test')).cookie;
  operator.mailOnly = (await bootstrapHost(mailOnly, 'Mo Host', 'mo@host.test')).cookie;
  keys.ownership = await issueKey(h, operator.h, ['communities:ownership']);
  keys.second = await issueKey(h, operator.h, ['communities:ownership']);
  keys.everyOther = await issueKey(h, operator.h, [
    'communities:read',
    'communities:write',
    'communities:lifecycle',
    'communities:import',
    'communities:legal_hold',
    'communities:takedown',
  ]);
  keys.read = await issueKey(h, operator.h, ['communities:read']);
  keys.bare = await issueKey(bare, operator.bare, ['communities:ownership', 'communities:read']);
  keys.mailOnly = await issueKey(mailOnly, operator.mailOnly, ['communities:ownership']);
}, 120_000);

afterAll(async () => {
  await h?.close();
  await sso?.close();
  await bare?.close();
  await mailOnly?.close();
});

describe('who may ask (AC-1)', () => {
  it('needs communities:ownership, which no other scope implies, on every route', async () => {
    // Purpose: fails if lifecycle (or any other scope) implies ownership, or if one route
    // forgets the scope.
    const c = await ownedCommunity(h, operator.h);
    const open = await created(await request(h, c.communityId, { bearer: keys.ownership.secret }));
    const id = open.replacement.replacementId;
    const other = { bearer: keys.everyOther.secret };
    const refused = [
      await request(h, c.communityId, other),
      await hostCall(h, `/communities/${c.communityId}/owner-replacements`, other),
      await cancel(h, c.communityId, id, other),
      await reissue(h, c.communityId, id, other),
    ];
    for (const response of refused) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(await replacementCount(h, c.communityId)).toBe(1);
    const row = await replacementRow(h, id);
    expect(row.state).toBe('notifying');
    expect(row.claim_token_hash).toBe(hashSecret(open.claimToken!));
    expect(await outbox(h, id)).toHaveLength(1);
  });

  it('makes a person confirm their password, and a key never send one', async () => {
    // Purpose: fails if a person skips reauthentication, if a missing password is not the
    // takedowns' REAUTH_REQUIRED, if a wrong password is anything but
    // REAUTH_FAILED, or if a key's password is silently accepted.
    const c = await ownedCommunity(h, operator.h);
    const missing = await request(
      h,
      c.communityId,
      { cookie: operator.h },
      { password: undefined }
    );
    expect(missing.status).toBe(403);
    expect(await missing.json()).toMatchObject({ code: 'REAUTH_REQUIRED' });
    const wrong = await request(h, c.communityId, { cookie: operator.h }, { password: 'not-it' });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toMatchObject({ code: 'REAUTH_FAILED' });
    const keyWithPassword = await request(
      h,
      c.communityId,
      { bearer: keys.ownership.secret },
      { password: TENANCY_PASSWORD }
    );
    expect(keyWithPassword.status).toBe(400);
    expect(await replacementCount(h, c.communityId)).toBe(0);

    const person = await created(await request(h, c.communityId, { cookie: operator.h }));
    const hanaId = (
      await h.pool.query<{ id: string }>(`SELECT id FROM "user" WHERE email='hana@host.test'`)
    ).rows[0].id;
    expect(
      (await replacementRow(h, person.replacement.replacementId)).requested_by_host_actor
    ).toBe(`person:${hanaId}`);
    expect(person.replacement.requestedBy).toEqual({ kind: 'person', label: 'Hana Host' });
  });

  it('tells an operator who signs in only through single sign-on to use a key', async () => {
    // Purpose: fails if an operator with no password can start a replacement from a session, or
    // is told their non-existent password is wrong.
    const c = await ownedCommunity(h, operator.h);
    const ssoOnly = await ownedCommunity(h, operator.h);
    // Make that community's owner a host operator whose account has no password.
    const userId = await userIdOf(h, ssoOnly.ownerMemberId);
    await h.pool.query('INSERT INTO host_operators(user_id) VALUES($1)', [userId]);
    await h.pool.query(`DELETE FROM account WHERE "userId"=$1 AND "providerId"='credential'`, [
      userId,
    ]);
    // Told on the first try, whether or not they typed something into the password field.
    for (const password of [undefined, 'anything-at-all']) {
      const refused = await request(
        h,
        c.communityId,
        { cookie: ssoOnly.ownerCookie },
        { password }
      );
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({
        code: 'PASSWORD_REQUIRED',
        message: 'Set a password in your account to do this.',
      });
    }
    expect(await replacementCount(h, c.communityId)).toBe(0);
  });

  it('refuses a key revoked while its request waits on the community lock, and writes nothing', async () => {
    // Purpose: fails if the scope check at the door is the only one, so a revocation that commits
    // while the request waits does not win.
    const c = await ownedCommunity(h, operator.h);
    const doomed = await issueKey(h, operator.h, ['communities:ownership']);
    const response = await holdingLock(
      h,
      'SELECT 1 FROM communities WHERE id=$1 FOR UPDATE',
      [c.communityId],
      async (release, holderPid) => {
        const pending = request(h, c.communityId, { bearer: doomed.secret });
        await waitForBlockedBy(h, holderPid, 1);
        await expectStatus(
          await h.call(`/api/v1/host/api-keys/${doomed.id}/revoke`, {
            cookie: operator.h,
            body: {},
          }),
          200,
          'revoke key'
        );
        await release();
        return pending;
      }
    );
    expect(response.status).toBe(401);
    expect(await replacementCount(h, c.communityId)).toBe(0);
    expect(await hostAudits(h, c.communityId)).toEqual([]);
  });

  it.each(['cancel', 'claim-token'] as const)(
    'refuses a key revoked while its %s waits on the community lock, and changes nothing',
    async (route) => {
      // Purpose: fails if cancel or reissue trust the key check at the door, so a revocation
      // that commits while the change waits on the community does not win.
      const c = await ownedCommunity(h, operator.h);
      const doomed = await issueKey(h, operator.h, ['communities:ownership']);
      const open = await created(await request(h, c.communityId, { bearer: doomed.secret }));
      const id = open.replacement.replacementId;
      const before = await replacementRow(h, id);
      const response = await holdingLock(
        h,
        'SELECT 1 FROM communities WHERE id=$1 FOR UPDATE',
        [c.communityId],
        async (release, holderPid) => {
          const pending = (route === 'cancel' ? cancel : reissue)(h, c.communityId, id, {
            bearer: doomed.secret,
          });
          await waitForBlockedBy(h, holderPid, 1);
          await expectStatus(
            await h.call(`/api/v1/host/api-keys/${doomed.id}/revoke`, {
              cookie: operator.h,
              body: {},
            }),
            200,
            'revoke key'
          );
          await release();
          return pending;
        }
      );
      expect(response.status).toBe(401);
      expect(await replacementRow(h, id)).toEqual(before);
      expect(await outbox(h, id)).toHaveLength(1);
      expect(await hostAudits(h, c.communityId)).toHaveLength(1);
    }
  );
});

describe('the owner erasing their account at the same moment', () => {
  it('lets the real erasure route wait out a request paused after the owner lock, then refuses it', async () => {
    // Purpose: fails if a request paused after it locked the owner's member row can deadlock
    // with the owner's account erasure through its real route (account row, then member rows),
    // or if the erasure slips through and the owner erases themselves mid-request (review
    // probe P3). The request is paused by holding the host audit table it writes to next.
    const c = await ownedCommunity(h, operator.h);
    const outcome = await holdingLock(
      h,
      'LOCK TABLE host_audit_events IN EXCLUSIVE MODE',
      [],
      async (release, holderPid) => {
        const pending = request(h, c.communityId, { bearer: keys.ownership.secret });
        await waitForBlockedBy(h, holderPid, 1);
        const erasing = h.call('/api/v1/account/erasures', {
          cookie: c.ownerCookie,
          body: { kind: 'account', confirmEmail: c.ownerEmail, password: TENANCY_PASSWORD },
        });
        // The erasure holds the account and waits on the owner's member row, behind the request.
        await waitForLockWaiters(h, 2);
        await release();
        const [requested, erased] = await Promise.all([pending, erasing]);
        return { requested: requested.status, erased: erased.status };
      }
    );
    expect(outcome).toEqual({ requested: 201, erased: 409 });
    expect(await replacementCount(h, c.communityId)).toBe(1);
    const erasures = await h.pool.query('SELECT 1 FROM erasure_requests WHERE user_id=$1', [
      await userIdOf(h, c.ownerMemberId),
    ]);
    expect(erasures.rowCount).toBe(0);
  });

  it('neither deadlocks with a request nor lets the owner erase their account', async () => {
    // Purpose: fails if the request locks the owner's account row after their member row. An
    // account erasure locks the account and then its member rows, so that order deadlocks
    // (review probe P3). The request must win or wait, never kill the erasure's transaction.
    const c = await ownedCommunity(h, operator.h);
    const ownerUser = await userIdOf(h, c.ownerMemberId);
    const eraser = await h.pool.connect();
    try {
      await eraser.query('BEGIN');
      // Erasure's first step (routes/account/erasures.ts): the account row.
      await eraser.query('SELECT 1 FROM "user" WHERE id=$1 FOR UPDATE', [ownerUser]);
      const pid = (await eraser.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        .pid;
      const pending = request(h, c.communityId, { bearer: keys.ownership.secret });
      // The request either finishes without the account row or waits on this session.
      const settled = await Promise.race([
        pending.then(() => 'done'),
        waitForBlockedBy(h, pid, 1).then(
          () => 'blocked',
          () => 'never blocked'
        ),
      ]);
      // Erasure's second step: its memberships, in the same order the route takes them.
      const members = await eraser.query<{ role: string; active: boolean }>(
        `SELECT m.role,m.active FROM members m JOIN communities c ON c.id=m.community_id
         WHERE m.user_id=$1 ORDER BY m.community_id,m.id FOR UPDATE OF m`,
        [ownerUser]
      );
      // Still the owner, so the route would refuse the erasure here.
      expect(members.rows).toEqual([{ role: 'owner', active: true }]);
      await eraser.query('COMMIT');
      expect(settled).toBe('done');
      const response = await pending;
      expect(response.status).toBe(201);
    } finally {
      eraser.release();
    }
  });
});

describe('no mail, no replacement (AC-2)', () => {
  it('refuses on a host without mail, writes nothing, and says mail is off', async () => {
    // Purpose: fails if a replacement can start with no way to reach the owner.
    const c = await ownedCommunity(bare, operator.bare);
    const refused = await request(bare, c.communityId, { bearer: keys.bare.secret });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      code: 'NOTICE_DELIVERY_UNAVAILABLE',
      message: "This host can't send email, so it can't give the owner notice. Set up mail first.",
    });
    expect(await replacementCount(bare, c.communityId)).toBe(0);
    const queued = await bare.pool.query('SELECT 1 FROM notice_outbox');
    expect(queued.rowCount).toBe(0);
    expect(await hostAudits(bare, c.communityId)).toEqual([]);
    const off = CommunityAdminHostCapabilitiesSchema.parse(
      await body(await hostCall(bare, '/capabilities', { bearer: keys.bare.secret }), 200, 'caps')
    );
    expect(off).toEqual({ mail: false, oidc: false });
    const on = CommunityAdminHostCapabilitiesSchema.parse(
      await body(await hostCall(h, '/capabilities', { bearer: keys.read.secret }), 200, 'caps')
    );
    expect(on).toEqual({ mail: true, oidc: false });
  });

  it('refuses to reissue a claim it cannot announce', async () => {
    // Purpose: fails if a new claim link can be issued on a host that cannot tell the owner.
    const c = await ownedCommunity(bare, operator.bare);
    const { id, token } = await seedOpenReplacement(bare, c, keys.bare);
    const refused = await reissue(bare, c.communityId, id, { bearer: keys.bare.secret });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'NOTICE_DELIVERY_UNAVAILABLE' });
    expect((await replacementRow(bare, id)).claim_token_hash).toBe(hashSecret(token));
    expect((await bare.pool.query('SELECT 1 FROM notice_outbox')).rowCount).toBe(0);
  });

  it('refuses while mail is set up but the notices cannot be written yet, and cancel still works', async () => {
    // Purpose: fails if a replacement can start, or a claim be reissued, on a server whose mail
    // worker has no composer for the notice, so the owner would never be told (the worker would
    // fail it as NOTICE_KIND_UNSUPPORTED). The stub-composer host `h` proves the accepted side.
    const c = await ownedCommunity(mailOnly, operator.mailOnly);
    const auth = { bearer: keys.mailOnly.secret };
    const refused = await request(mailOnly, c.communityId, auth);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      code: 'NOTICE_DELIVERY_UNAVAILABLE',
      message: "This server can't send the owner's notice yet, so it can't replace an owner.",
    });
    expect(await replacementCount(mailOnly, c.communityId)).toBe(0);
    expect(await hostAudits(mailOnly, c.communityId)).toEqual([]);

    const { id, token } = await seedOpenReplacement(mailOnly, c, keys.mailOnly);
    const noReissue = await reissue(mailOnly, c.communityId, id, auth);
    expect(noReissue.status).toBe(409);
    expect(await noReissue.json()).toMatchObject({ code: 'NOTICE_DELIVERY_UNAVAILABLE' });
    expect((await replacementRow(mailOnly, id)).claim_token_hash).toBe(hashSecret(token));
    expect((await mailOnly.pool.query('SELECT 1 FROM notice_outbox')).rowCount).toBe(0);

    // A request that somehow opened can always be withdrawn.
    await expectStatus(await cancel(mailOnly, c.communityId, id, auth), 200, 'cancel');
    expect((await replacementRow(mailOnly, id)).state).toBe('withdrawn');
  });
});

describe('a request (AC-3, AC-13, AC-14)', () => {
  it('stores only the claim token hash, queues one notice to the owner, and audits both planes', async () => {
    // Purpose: fails if the token is stored in the clear or leaks into a log line, if the notice
    // goes to anyone but the owner, or if an audit row names a member, the reference, or the
    // subject.
    const c = await ownedCommunity(h, operator.h);
    const response = await request(h, c.communityId, { bearer: keys.ownership.secret });
    expect(response.headers.get('cache-control')).toBe('no-store');
    const result = await created(response);
    const id = result.replacement.replacementId;
    expect(result.replayed).toBe(false);
    expect(result.claimUrl).toBe(`${h.config.publicUrl}/owner-replacement#${result.claimToken}`);
    expect(result.replacement).toMatchObject({
      communityId: c.communityId,
      state: 'notifying',
      reason: 'owner_unreachable',
      reference: REFERENCE,
      claimantNamed: false,
      requestedBy: { kind: 'api_key', label: keys.ownership.prefix },
      notice: { state: 'pending', resolvedAt: null, verifiedAddress: null },
      wait: null,
      afterObjection: false,
      afterWithdrawal: false,
      claimableAfter: null,
      claimExpiresAt: null,
      claimReissuedAt: null,
      endedAt: null,
      withdrawnBecause: null,
      cooldownUntil: null,
    });
    const row = await replacementRow(h, id);
    expect(row).toMatchObject({
      state: 'notifying',
      claim_token_hash: hashSecret(result.claimToken!),
      prior_owner_member_id: c.ownerMemberId,
      after_objection: false,
      after_withdrawal: false,
      claimant_oidc_issuer: null,
      claimant_oidc_subject: null,
    });
    const dump = JSON.stringify(
      (await h.pool.query('SELECT * FROM owner_replacements WHERE id=$1', [id])).rows
    );
    expect(dump).not.toContain(result.claimToken);
    expect(await outbox(h, id)).toEqual([
      {
        kind: 'owner_replacement.notice',
        recipient_user_id: await userIdOf(h, c.ownerMemberId),
        community_id: c.communityId,
      },
    ]);
    expect(await hostAudits(h, c.communityId)).toEqual([
      {
        action: 'owner_replacement.request',
        actor_kind: 'api_key',
        actor_user_id: null,
        actor_api_key_id: keys.ownership.id,
      },
    ]);
    expect(await tenantAudits(h, c.communityId)).toEqual([
      {
        action: 'owner.replacement.requested',
        actor_kind: 'host',
        actor_member_id: null,
        subject_id: id,
      },
    ]);

    // The host projection shows the open replacement to any host actor.
    const projection = CommunityAdminHostProjectionSchema.parse(
      await body(
        await hostCall(h, `/communities/${c.communityId}`, { bearer: keys.read.secret }),
        200,
        'read community'
      )
    );
    expect(projection.ownerReplacement).toEqual({
      replacementId: id,
      state: 'notifying',
      claimableAfter: null,
    });
  });

  it('replays one key and body, is independent in another community, and refuses a changed body', async () => {
    // Purpose: fails if a replay mints a second token or notice, if idempotency is global rather
    // than per community, or if a replayed key can change what was asked.
    const a = await ownedCommunity(h, operator.h);
    const b = await ownedCommunity(h, operator.h);
    const auth = { bearer: keys.ownership.secret };
    const fixed = { idempotencyKey: 'one-key-two-communities' };
    const first = await created(await request(h, a.communityId, auth, fixed));
    const replay = await request(h, a.communityId, auth, fixed);
    expect(replay.headers.get('cache-control')).toBe('no-store');
    const replayed = await created(replay, 200);
    expect(replayed).toMatchObject({ replayed: true, claimToken: null, claimUrl: null });
    expect(replayed.replacement).toEqual(first.replacement);
    expect(await outbox(h, first.replacement.replacementId)).toHaveLength(1);
    expect(await replacementCount(h, a.communityId)).toBe(1);
    expect(await hostAudits(h, a.communityId)).toHaveLength(1);

    const elsewhere = await created(await request(h, b.communityId, auth, fixed));
    expect(elsewhere.replacement.replacementId).not.toBe(first.replacement.replacementId);
    expect(elsewhere.replacement.communityId).toBe(b.communityId);

    const changed = await request(h, a.communityId, auth, { ...fixed, reason: 'other' });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await replacementRow(h, first.replacement.replacementId)).reason).toBe(
      'owner_unreachable'
    );

    // The same key from another actor is its own request, refused only because one is open.
    const otherActor = await request(h, a.communityId, { bearer: keys.second.secret }, fixed);
    expect(otherActor.status).toBe(409);
    expect(await otherActor.json()).toMatchObject({ code: 'OWNER_REPLACEMENT_OPEN' });
    expect(await replacementCount(h, a.communityId)).toBe(1);
  });

  it('keeps one open request per community, even for two requests at the same moment', async () => {
    // Purpose: fails if two concurrent requests can both open a replacement, or if the loser of
    // the race writes anything.
    const c = await ownedCommunity(h, operator.h);
    const auth = { bearer: keys.ownership.secret };
    const statuses = await holdingLock(
      h,
      'SELECT 1 FROM communities WHERE id=$1 FOR UPDATE',
      [c.communityId],
      async (release) => {
        const racing = [request(h, c.communityId, auth), request(h, c.communityId, auth)];
        await waitForLockWaiters(h, 2, 'lifecycle_version FROM communities');
        await release();
        return Promise.all(racing);
      }
    );
    const codes = await Promise.all(
      statuses.map(async (response) => [response.status, (await response.json()).code])
    );
    expect(codes.map(([status]) => status).sort()).toEqual([201, 409]);
    expect(codes.find(([status]) => status === 409)?.[1]).toBe('OWNER_REPLACEMENT_OPEN');
    expect(await replacementCount(h, c.communityId)).toBe(1);
    expect(await hostAudits(h, c.communityId)).toHaveLength(1);
    const queued = await h.pool.query('SELECT 1 FROM notice_outbox WHERE community_id=$1', [
      c.communityId,
    ]);
    expect(queued.rowCount).toBe(1);
  });

  it('answers one request for a key sent twice at the same moment', async () => {
    // Purpose: fails if a retried request that races its original creates a second row.
    const c = await ownedCommunity(h, operator.h);
    const auth = { bearer: keys.ownership.secret };
    const statuses = await holdingLock(
      h,
      'SELECT 1 FROM communities WHERE id=$1 FOR UPDATE',
      [c.communityId],
      async (release) => {
        const version = await lifecycleVersion(h, c.communityId);
        const same = { idempotencyKey: 'retried-at-once', lifecycleVersion: version };
        const racing = [
          request(h, c.communityId, auth, same),
          request(h, c.communityId, auth, same),
        ];
        await waitForLockWaiters(h, 2, 'lifecycle_version FROM communities');
        await release();
        return Promise.all(racing);
      }
    );
    expect(statuses.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(await replacementCount(h, c.communityId)).toBe(1);
  });

  it('refuses an unknown or malformed community, and a stale lifecycle version', async () => {
    // Purpose: fails if a request can land without naming a real community at its current
    // version.
    const auth = { bearer: keys.ownership.secret };
    for (const communityId of [randomUUID(), 'not-a-uuid']) {
      const response = await request(h, communityId, auth, { lifecycleVersion: 1 });
      expect(response.status).toBe(404);
    }
    const c = await ownedCommunity(h, operator.h);
    const stale = await request(h, c.communityId, auth, {
      lifecycleVersion: (await lifecycleVersion(h, c.communityId)) + 1,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'STATE_CONFLICT' });
    expect(await replacementCount(h, c.communityId)).toBe(0);
  });
});

describe('naming the new owner (AC-7, request half)', () => {
  it('needs a subject when single sign-on is on, and stores it with the configured issuer', async () => {
    // Purpose: fails if an SSO host accepts an unnamed claimant, stores a subject without its
    // issuer, or echoes the subject back to the host.
    const c = await ownedCommunity(sso, operator.sso);
    const unnamed = await request(sso, c.communityId, { cookie: operator.sso });
    expect(unnamed.status).toBe(400);
    expect(await replacementCount(sso, c.communityId)).toBe(0);

    const response = await request(
      sso,
      c.communityId,
      { cookie: operator.sso },
      { claimant: { oidcSubject: SUBJECT } }
    );
    const text = await response.clone().text();
    const result = await created(response);
    expect(result.replacement.claimantNamed).toBe(true);
    expect(text).not.toContain(SUBJECT);
    const row = await replacementRow(sso, result.replacement.replacementId);
    expect(row).toMatchObject({
      claimant_named: true,
      claimant_oidc_issuer: ISSUER,
      claimant_oidc_subject: SUBJECT,
    });
    expect(sso.config.oidc?.issuer).toBe(ISSUER);

    // Cancelling clears the named account; the list still says one was named.
    const cancelled = CommunityAdminOwnerReplacementSchema.parse(
      await body(
        await cancel(sso, c.communityId, result.replacement.replacementId, {
          cookie: operator.sso,
        }),
        200,
        'cancel'
      )
    );
    expect(cancelled).toMatchObject({ claimantNamed: true, state: 'withdrawn' });
    expect(await replacementRow(sso, result.replacement.replacementId)).toMatchObject({
      claimant_named: true,
      claimant_oidc_issuer: null,
      claimant_oidc_subject: null,
    });
    const listed = await hostCall(sso, `/communities/${c.communityId}/owner-replacements`, {
      cookie: operator.sso,
    });
    expect(await listed.clone().text()).not.toContain(SUBJECT);
  });

  it('refuses a subject on a host without single sign-on', async () => {
    // Purpose: fails if a host with no issuer can store a subject nothing could ever match.
    const c = await ownedCommunity(h, operator.h);
    const refused = await request(
      h,
      c.communityId,
      { bearer: keys.ownership.secret },
      { claimant: { oidcSubject: SUBJECT } }
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      code: 'STATE_CONFLICT',
      message: 'This host has no single sign-on to name an account with.',
    });
    expect(await replacementCount(h, c.communityId)).toBe(0);
  });
});

describe('which communities (AC-10, request half)', () => {
  const auth = () => ({ bearer: keys.ownership.secret });

  async function expectRefused(communityId: string, message?: string) {
    const refused = await request(h, communityId, auth());
    expect(refused.status).toBe(409);
    const error = await refused.json();
    expect(error.code).toBe('STATE_CONFLICT');
    if (message) expect(error.message).toBe(message);
    expect(await replacementCount(h, communityId)).toBe(0);
  }

  it('refuses a community with no owner yet, and names the owner-claim reissue', async () => {
    const { communityId } = await createPendingCommunity(h, operator.h, `Unclaimed ${++counter}`);
    await expectRefused(
      communityId,
      'This community has no owner yet. Reissue its owner claim instead.'
    );
  });

  it('refuses a suspended community', async () => {
    const c = await ownedCommunity(h, operator.h);
    await expectStatus(
      await h.call(`/api/v1/host/communities/${c.communityId}/lifecycle`, {
        method: 'PATCH',
        cookie: operator.h,
        body: { action: 'suspend', lifecycleVersion: await lifecycleVersion(h, c.communityId) },
      }),
      200,
      'suspend'
    );
    await expectRefused(c.communityId);
  });

  it('refuses a community whose owner asked to delete it', async () => {
    const c = await ownedCommunity(h, operator.h);
    await expectStatus(
      await h.call(`/api/v1/communities/${c.communityId}/owner/deletion`, {
        cookie: c.ownerCookie,
        body: {
          lifecycleVersion: await lifecycleVersion(h, c.communityId),
          password: TENANCY_PASSWORD,
          confirmName: c.name,
          confirmIdSuffix: c.communityId.slice(-8),
        },
      }),
      200,
      'owner deletion'
    );
    const state = await h.pool.query<{ lifecycle: string }>(
      'SELECT lifecycle FROM communities WHERE id=$1',
      [c.communityId]
    );
    expect(state.rows[0].lifecycle).toBe('deletion_pending');
    await expectRefused(c.communityId);
  });

  it('refuses a community the host took down', async () => {
    // Purpose: fails if a takedown's pending deletion (DOR-2293) can be joined by a replacement.
    const c = await ownedCommunity(h, operator.h);
    await expectStatus(
      await h.call(`/api/v1/host/communities/${c.communityId}/takedowns`, {
        cookie: operator.h,
        body: {
          idempotencyKey: `takedown-${++counter}`,
          target: {
            kind: 'community',
            lifecycleVersion: await lifecycleVersion(h, c.communityId),
            confirmIdSuffix: c.communityId.slice(-8),
          },
          category: 'terms_violation',
          reference: null,
          password: TENANCY_PASSWORD,
        },
      }),
      201,
      'take down'
    );
    const state = await h.pool.query<{ lifecycle: string; takedown_id: string | null }>(
      'SELECT lifecycle,takedown_id FROM communities WHERE id=$1',
      [c.communityId]
    );
    expect(state.rows[0].takedown_id).not.toBeNull();
    await expectRefused(c.communityId);
  });

  it('accepts an active, an archived, and a held community', async () => {
    // Purpose: fails if the lifecycle gate is tighter than the spec (an owner who left often
    // leaves an archived or held community behind).
    const active = await ownedCommunity(h, operator.h);
    const archived = await ownedCommunity(h, operator.h);
    const held = await ownedCommunity(h, operator.h);
    await expectStatus(
      await h.call(`/api/v1/communities/${archived.communityId}/owner/lifecycle`, {
        cookie: archived.ownerCookie,
        body: {
          action: 'archive',
          lifecycleVersion: await lifecycleVersion(h, archived.communityId),
          password: TENANCY_PASSWORD,
          confirmName: archived.name,
        },
      }),
      200,
      'archive'
    );
    await expectStatus(
      await h.call(`/api/v1/host/communities/${held.communityId}/lifecycle`, {
        method: 'PATCH',
        cookie: operator.h,
        body: {
          action: 'hold',
          lifecycleVersion: await lifecycleVersion(h, held.communityId),
          deletionNoticeAt: null,
        },
      }),
      200,
      'hold'
    );
    for (const [c, lifecycle] of [
      [active, 'active'],
      [archived, 'archived'],
      [held, 'held'],
    ] as const) {
      const state = await h.pool.query<{ lifecycle: string }>(
        'SELECT lifecycle FROM communities WHERE id=$1',
        [c.communityId]
      );
      expect(state.rows[0].lifecycle).toBe(lifecycle);
      await created(await request(h, c.communityId, auth()));
    }
  });
});

describe('the cooling-off after an objection (AC-20, request half)', () => {
  it('refuses within the cooling-off with its end date, and accepts after it with the long wait marked', async () => {
    // Purpose: fails if a host can wear an owner down with repeated requests, or if the request
    // after the cooling-off forgets the earlier objection.
    const c = await ownedCommunity(h, operator.h);
    const auth = { bearer: keys.ownership.secret };
    const first = await created(await request(h, c.communityId, auth));
    const objectedAt = new Date(clock().getTime() - (COOLDOWN_DAYS * DAY - 60 * 60_000));
    await closeDirectly(h, first.replacement.replacementId, 'objected', objectedAt);

    const refused = await request(h, c.communityId, auth);
    expect(refused.status).toBe(409);
    const until = new Date(objectedAt.getTime() + COOLDOWN_DAYS * DAY);
    expect(await refused.json()).toEqual({
      code: 'OWNER_REPLACEMENT_COOLDOWN',
      message: `The owner kept ownership on ${formatReplacementDate(objectedAt)}. You can ask again after ${formatReplacementDate(until)}.`,
    });
    expect(await replacementCount(h, c.communityId)).toBe(1);

    // The list says when the host may ask again.
    const list = CommunityAdminOwnerReplacementListSchema.parse(
      await body(
        await hostCall(h, `/communities/${c.communityId}/owner-replacements`, auth),
        200,
        'list'
      )
    );
    expect(list.replacements[0]).toMatchObject({
      state: 'objected',
      cooldownUntil: until.toISOString(),
    });

    // One minute past the cooling-off.
    await h.pool.query('UPDATE owner_replacements SET ended_at=$2 WHERE id=$1', [
      first.replacement.replacementId,
      new Date(clock().getTime() - COOLDOWN_DAYS * DAY - 60_000),
    ]);
    const second = await created(await request(h, c.communityId, auth));
    expect(await replacementRow(h, second.replacement.replacementId)).toMatchObject({
      after_objection: true,
      after_withdrawal: false,
    });
    // The host's list says why this request has the longer wait.
    expect(second.replacement).toMatchObject({ afterObjection: true, afterWithdrawal: false });
  });

  it('starts no cooling-off after a withdrawal, an expiry, or a supersession', async () => {
    // Purpose: fails if anything but the owner's objection blocks the host from asking again.
    const auth = { bearer: keys.ownership.secret };
    for (const ending of ['withdrawn', 'expired', 'superseded'] as const) {
      const c = await ownedCommunity(h, operator.h);
      const first = await created(await request(h, c.communityId, auth));
      const id = first.replacement.replacementId;
      if (ending === 'withdrawn')
        await expectStatus(await cancel(h, c.communityId, id, auth), 200, 'cancel');
      else await closeDirectly(h, id, ending, clock());
      const again = await created(await request(h, c.communityId, auth));
      expect(again.replacement).toMatchObject({
        afterObjection: false,
        afterWithdrawal: ending === 'withdrawn',
      });
      expect(await replacementRow(h, again.replacement.replacementId)).toMatchObject({
        after_objection: false,
        // Only a withdrawal in the last 30 days forces the long wait.
        after_withdrawal: ending === 'withdrawn',
      });
    }
  });

  it('marks a request within 30 days of a withdrawal, and not one after', async () => {
    // Purpose: fails if cancel-and-ask-again can dodge the long wait, or if an old withdrawal
    // lengthens every later wait forever.
    const auth = { bearer: keys.ownership.secret };
    const c = await ownedCommunity(h, operator.h);
    const first = await created(await request(h, c.communityId, auth));
    await expectStatus(
      await cancel(h, c.communityId, first.replacement.replacementId, auth),
      200,
      'cancel'
    );
    await h.pool.query('UPDATE owner_replacements SET ended_at=$2 WHERE id=$1', [
      first.replacement.replacementId,
      new Date(clock().getTime() - 29 * DAY),
    ]);
    const within = await created(await request(h, c.communityId, auth));
    expect((await replacementRow(h, within.replacement.replacementId)).after_withdrawal).toBe(true);
    await h.pool.query('DELETE FROM notice_outbox WHERE subject_id=$1', [
      within.replacement.replacementId,
    ]);
    await h.pool.query('DELETE FROM owner_replacements WHERE id=$1', [
      within.replacement.replacementId,
    ]);
    await h.pool.query('UPDATE owner_replacements SET ended_at=$2 WHERE id=$1', [
      first.replacement.replacementId,
      new Date(clock().getTime() - 31 * DAY),
    ]);
    const after = await created(await request(h, c.communityId, auth));
    expect((await replacementRow(h, after.replacement.replacementId)).after_withdrawal).toBe(false);
  });
});

describe('cancelling (and AC-13 for it)', () => {
  it('withdraws an open request, tells the owner, audits both planes, and cannot run twice', async () => {
    // Purpose: fails if a cancelled request keeps a live claim token, is not told to the owner,
    // or can be cancelled into a second withdrawal.
    const c = await ownedCommunity(h, operator.h);
    const open = await created(await request(h, c.communityId, { cookie: operator.h }));
    const id = open.replacement.replacementId;
    const cancelled = CommunityAdminOwnerReplacementSchema.parse(
      await body(await cancel(h, c.communityId, id, { cookie: operator.h }), 200, 'cancel')
    );
    expect(cancelled).toMatchObject({
      state: 'withdrawn',
      withdrawnBecause: 'cancelled',
      cooldownUntil: null,
    });
    expect(cancelled.endedAt).not.toBeNull();
    expect(await replacementRow(h, id)).toMatchObject({
      state: 'withdrawn',
      withdrawn_cause: 'cancelled',
      claim_token_hash: null,
    });
    expect((await outbox(h, id)).map((message) => message.kind)).toEqual([
      'owner_replacement.notice',
      'owner_replacement.ended',
    ]);
    const hanaId = (
      await h.pool.query<{ id: string }>(`SELECT id FROM "user" WHERE email='hana@host.test'`)
    ).rows[0].id;
    expect(await hostAudits(h, c.communityId)).toEqual([
      {
        action: 'owner_replacement.request',
        actor_kind: 'person',
        actor_user_id: hanaId,
        actor_api_key_id: null,
      },
      {
        action: 'owner_replacement.cancel',
        actor_kind: 'person',
        actor_user_id: hanaId,
        actor_api_key_id: null,
      },
    ]);
    expect(await tenantAudits(h, c.communityId)).toEqual([
      {
        action: 'owner.replacement.requested',
        actor_kind: 'host',
        actor_member_id: null,
        subject_id: id,
      },
      {
        action: 'owner.replacement.withdrawn',
        actor_kind: 'host',
        actor_member_id: null,
        subject_id: id,
      },
    ]);

    const again = await cancel(h, c.communityId, id, { cookie: operator.h });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'STATE_CONFLICT' });
    const refusedReissue = await reissue(h, c.communityId, id, { cookie: operator.h });
    expect(refusedReissue.status).toBe(409);
    expect(await outbox(h, id)).toHaveLength(2);
    expect(await hostAudits(h, c.communityId)).toHaveLength(2);
  });
});

describe('reissuing the claim link (AC-21)', () => {
  it('replaces the token, tells the owner once, audits both planes, and moves no date', async () => {
    // Purpose: fails if the old link keeps working, if the owner is not told, or if a reissue
    // restarts or shortens the wait.
    const c = await ownedCommunity(h, operator.h);
    const auth = { bearer: keys.ownership.secret };
    const open = await created(await request(h, c.communityId, auth));
    const id = open.replacement.replacementId;
    // Give it dates, as the timeline would, so a reissue that moves one is caught.
    await h.pool.query(
      `UPDATE owner_replacements SET state='waiting',notice_state='accepted',
         notice_resolved_at=$2,verified_address=true,claimable_after=$3 WHERE id=$1`,
      [id, clock(), new Date(clock().getTime() + 14 * DAY)]
    );
    const before = await replacementRow(h, id);
    const response = await reissue(h, c.communityId, id, auth);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const reissued = CommunityAdminOwnerReplacementClaimTokenSchema.parse(
      await body(response, 200, 'reissue')
    );
    expect(reissued.replacementId).toBe(id);
    expect(reissued.claimToken).not.toBe(open.claimToken);
    expect(reissued.claimUrl).toBe(
      `${h.config.publicUrl}/owner-replacement#${reissued.claimToken}`
    );
    const after = await replacementRow(h, id);
    expect(after.claim_token_hash).toBe(hashSecret(reissued.claimToken));
    expect(after.claim_token_hash).not.toBe(hashSecret(open.claimToken!));
    expect(after.claim_reissued_at).toBeInstanceOf(Date);
    const { claim_token_hash: _a, claim_reissued_at: _b, ...unchangedAfter } = after;
    const { claim_token_hash: _c, claim_reissued_at: _d, ...unchangedBefore } = before;
    expect(unchangedAfter).toEqual(unchangedBefore);
    expect(
      (await outbox(h, id)).filter((m) => m.kind === 'owner_replacement.claim_reissued')
    ).toEqual([
      {
        kind: 'owner_replacement.claim_reissued',
        recipient_user_id: await userIdOf(h, c.ownerMemberId),
        community_id: c.communityId,
      },
    ]);
    expect(
      (await hostAudits(h, c.communityId)).map((row) => [
        row.action,
        row.actor_kind,
        row.actor_api_key_id,
      ])
    ).toEqual([
      ['owner_replacement.request', 'api_key', keys.ownership.id],
      ['owner_replacement.claim_token.reissue', 'api_key', keys.ownership.id],
    ]);
    expect(await tenantAudits(h, c.communityId)).toEqual([
      {
        action: 'owner.replacement.requested',
        actor_kind: 'host',
        actor_member_id: null,
        subject_id: id,
      },
      {
        action: 'owner.replacement.claim_reissued',
        actor_kind: 'host',
        actor_member_id: null,
        subject_id: id,
      },
    ]);
    const listed = CommunityAdminOwnerReplacementListSchema.parse(
      await body(
        await hostCall(h, `/communities/${c.communityId}/owner-replacements`, auth),
        200,
        'list'
      )
    );
    expect(listed.replacements[0]).toMatchObject({
      claimReissuedAt: (after.claim_reissued_at as Date).toISOString(),
      claimableAfter: (before.claimable_after as Date).toISOString(),
      wait: 'standard',
    });
  });
});

describe('tenancy', () => {
  it("never reaches another community's replacement through this community's path", async () => {
    // Purpose: fails if cancel or reissue look a replacement up by id alone.
    const a = await ownedCommunity(h, operator.h);
    const b = await ownedCommunity(h, operator.h);
    const auth = { bearer: keys.ownership.secret };
    const inA = await created(await request(h, a.communityId, auth));
    const id = inA.replacement.replacementId;
    const before = await replacementRow(h, id);
    for (const response of [
      await cancel(h, b.communityId, id, auth),
      await reissue(h, b.communityId, id, auth),
      await cancel(h, a.communityId, 'not-a-uuid', auth),
      await reissue(h, 'not-a-uuid', id, auth),
      await cancel(h, randomUUID(), id, auth),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(await replacementRow(h, id)).toEqual(before);
    expect(await outbox(h, id)).toHaveLength(1);
    const listB = CommunityAdminOwnerReplacementListSchema.parse(
      await body(
        await hostCall(h, `/communities/${b.communityId}/owner-replacements`, auth),
        200,
        'list'
      )
    );
    expect(listB.replacements).toEqual([]);
    expect(
      (await hostCall(h, `/communities/${randomUUID()}/owner-replacements`, auth)).status
    ).toBe(404);
  });
});

describe('the list', () => {
  it('shows at most 50, newest first, labelled by who asked, with no member data', async () => {
    // Purpose: fails if the list is unbounded, out of order, or names anyone inside the community.
    const c = await ownedCommunity(h, operator.h);
    const base = clock().getTime() - 400 * DAY;
    await h.pool.query(
      `INSERT INTO owner_replacements(community_id,state,reason,claimant_named,
         requested_by_host_actor,idempotency_key,payload_hash,after_objection,after_withdrawal,
         withdrawn_cause,prior_owner_member_id,requested_at,ended_at)
       SELECT $1,'withdrawn','other',false,$2,'old-'||n,$3,false,false,'cancelled',$4,
         $5::timestamptz + n * interval '1 day',$5::timestamptz + n * interval '1 day'
       FROM generate_series(1,55) AS n`,
      [
        c.communityId,
        `api_key:${keys.second.id}`,
        createHash('sha256').update('old').digest('hex'),
        c.ownerMemberId,
        new Date(base),
      ]
    );
    const newest = await created(await request(h, c.communityId, { cookie: operator.h }));
    const list = CommunityAdminOwnerReplacementListSchema.parse(
      await body(
        await hostCall(h, `/communities/${c.communityId}/owner-replacements`, {
          bearer: keys.ownership.secret,
        }),
        200,
        'list'
      )
    );
    expect(list.replacements).toHaveLength(50);
    expect(list.replacements[0].replacementId).toBe(newest.replacement.replacementId);
    expect(list.replacements[0].requestedBy).toEqual({ kind: 'person', label: 'Hana Host' });
    expect(list.replacements[1].requestedBy).toEqual({
      kind: 'api_key',
      label: keys.second.prefix,
    });
    const times = list.replacements.map((row) => Date.parse(row.requestedAt));
    expect(times).toEqual([...times].sort((x, y) => y - x));
    // The newest request and the 49 newest of the 55 older ones: the six oldest fall off.
    expect(Math.min(...times)).toBe(base + 7 * DAY);
  });
});

describe('what the host sees and records (AC-13, AC-14)', () => {
  it('no host response or host audit row carries member data, the subject, or the reference', async () => {
    // Purpose: fails if any route in this feature leaks a member id, name, handle, or email, the
    // named subject, or writes the reference or a member into the host audit trail.
    expect(seen.length).toBeGreaterThan(20);
    const needles: string[] = [SUBJECT];
    for (const harness of [h, sso, bare]) {
      const members = await harness.pool.query<{
        id: string;
        display_name: string;
        handle: string;
        email: string;
      }>(
        `SELECT m.id,m.display_name,m.handle,u.email FROM members m JOIN "user" u ON u.id=m.user_id
         WHERE u.email LIKE 'owner-%@owner.test'`
      );
      for (const member of members.rows)
        needles.push(member.id, member.display_name, member.handle, member.email);
    }
    expect(needles.length).toBeGreaterThan(20);
    for (const { label, text } of seen)
      for (const needle of needles) expect(text, `${label} leaks ${needle}`).not.toContain(needle);

    for (const harness of [h, sso, bare]) {
      const audits = JSON.stringify(
        (
          await harness.pool.query(
            "SELECT * FROM host_audit_events WHERE action LIKE 'owner_replacement%'"
          )
        ).rows
      );
      for (const needle of [...needles, REFERENCE, ...owned.map((c) => c.ownerEmail)])
        expect(audits).not.toContain(needle);
    }
  });
});
