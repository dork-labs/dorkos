/**
 * A host closing someone else's account (DOR-2557): the `accounts:close` scope, the reasons,
 * idempotency, the host audit row, the person's access ending at once, the erasure after the
 * ordinary window, cancelling it, legal holds, owners and host operators, the sign-on lookup, and
 * a cancel that races the worker, the per-actor daily limit and its log line, and the cleanup of
 * finished closures. Every test drives the real routes on a real server and
 * database; the worker runs at an injected clock.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CommunityAdminAccountClosureCreateResponseSchema,
  CommunityAdminAccountClosureSchema,
  CommunityAdminHostApiKeyScopeSchema,
} from '@dorkos/shared/community-admin-wire';
import { pruneErasureRequests, sweepErasures } from '../erasure/worker.js';
import { runHostKeyCommand } from '../host-keys.js';
import { hoursFromNow, PASSWORD, runErasures } from './member-erasure-fixture.js';
import { bindInvite, makeScene, type Scene } from './member-erasure-scenes.js';
import {
  bootstrapHost,
  expectStatus,
  holdingLock,
  startTenancyHarness,
  waitForBlockedBy,
  waitForLockWaiters,
  type TenancyHarness,
} from './tenancy-test-harness.js';

const SCOPE = 'accounts:close';
const ISSUER = 'https://issuer.community.test';

let h: TenancyHarness;
let other: TenancyHarness;
let operator: { cookie: string; communityId: string };
let operatorUserId = '';
let closeKey = { id: '', secret: '' };

type Closure = ReturnType<typeof CommunityAdminAccountClosureSchema.parse>;
type Auth = { bearer?: string; cookie?: string };

async function issueKey(target: TenancyHarness, scopes: string[]) {
  const issued = await runHostKeyCommand(target.pool, {
    kind: 'issue',
    label: scopes.join(' ').slice(0, 80),
    scopes: scopes as never,
    expiresInDays: null,
  });
  if (issued.kind !== 'issue') throw new Error('expected a key');
  return { id: issued.key.id, secret: issued.secret };
}

const path = (accountId: string) => `/api/v1/host/accounts/${accountId}/closure`;

function close(
  accountId: string,
  body: Record<string, unknown> = {},
  auth: Auth = { bearer: closeKey.secret },
  target: TenancyHarness = h
) {
  return target.call(path(accountId), {
    ...auth,
    body: { idempotencyKey: randomUUID(), reason: 'under_minimum_age', reference: null, ...body },
  });
}

const cancel = (accountId: string, auth: Auth = { bearer: closeKey.secret }) =>
  h.call(`${path(accountId)}/cancel`, { ...auth, body: {} });
const read = (accountId: string, auth: Auth = { bearer: closeKey.secret }) =>
  h.call(path(accountId), auth);
const lookup = (body: unknown, auth: Auth = { bearer: closeKey.secret }, target = h) =>
  target.call('/api/v1/host/accounts/lookup', { ...auth, body });

async function closed(response: Response, status = 201) {
  await expectStatus(response, status, 'close');
  return CommunityAdminAccountClosureCreateResponseSchema.parse(await response.json());
}

async function closureOf(response: Response, status = 200): Promise<Closure> {
  await expectStatus(response, status, 'closure');
  return CommunityAdminAccountClosureSchema.parse(await response.json());
}

async function errorOf(response: Response, status: number) {
  await expectStatus(response, status, 'refusal');
  return (await response.json()) as { code: string; message: string };
}

async function emailOf(userId: string): Promise<string> {
  return (await h.pool.query<{ email: string }>('SELECT email FROM "user" WHERE id=$1', [userId]))
    .rows[0].email;
}

const signIn = async (email: string) =>
  (await h.call('/api/auth/sign-in/email', { body: { email, password: PASSWORD } })).status;

async function erasureRequest(closure: Closure) {
  return (
    await h.pool.query<{ id: string; state: string; execute_after: Date; created_at: Date }>(
      `SELECT r.id,r.state,r.execute_after,r.created_at FROM erasure_requests r
       JOIN account_closures ac ON ac.erasure_request_id=r.id WHERE ac.id=$1`,
      [closure.closureId]
    )
  ).rows[0];
}

async function legalHold(method: 'PUT' | 'DELETE', communityId: string) {
  await expectStatus(
    await h.call(`/api/v1/host/communities/${communityId}/legal-hold`, {
      method,
      cookie: operator.cookie,
      ...(method === 'PUT' ? { body: { reference: 'Case 7' } } : {}),
    }),
    200,
    `legal hold ${method}`
  );
}

beforeAll(async () => {
  h = await startTenancyHarness('closeacct', {
    env: {
      COMMUNITY_OIDC_ISSUER_URL: ISSUER,
      COMMUNITY_OIDC_CLIENT_ID: 'community-client',
      COMMUNITY_OIDC_CLIENT_SECRET: 'community-client-secret',
      // One key closes many accounts across these tests; the limit is tested on `other`.
      COMMUNITY_ACCOUNT_CLOSURES_PER_DAY: 1000,
    },
  });
  // A low daily limit here, so the limit test can reach it; the main host never does.
  other = await startTenancyHarness('closeacct_other', {
    env: { COMMUNITY_ACCOUNT_CLOSURES_PER_DAY: 2 },
  });
  operator = await bootstrapHost(h, 'Hana Host', 'hana@host.test');
  await bootstrapHost(other, 'Otto Host', 'otto@host.test');
  operatorUserId = (
    await h.pool.query<{ user_id: string }>('SELECT user_id FROM host_operators LIMIT 1')
  ).rows[0].user_id;
  closeKey = await issueKey(h, [SCOPE]);
}, 120_000);

afterAll(async () => {
  await h?.close();
  await other?.close();
});

// Each test's erasures are its own: anything an earlier test left open waits a year, so the
// worker at an injected clock only ever reaches the request the test is about.
beforeEach(async () => {
  await h.pool.query(
    `UPDATE erasure_requests SET execute_after=now()+interval '365 days',
       next_attempt_at=now()+interval '365 days'
     WHERE state IN ('scheduled','running')`
  );
});

describe('who may close an account', () => {
  // Purpose: fails if any other scope, alone or all together, reaches a closure route, if the
  // scope itself is refused, or if a key from another host or a revoked key is accepted.
  it('needs accounts:close, which no other scope implies', async () => {
    const s = await makeScene(h, operator.cookie, 'scope');
    const others = CommunityAdminHostApiKeyScopeSchema.options.filter((scope) => scope !== SCOPE);
    const keys = [
      ...(await Promise.all(others.map((scope) => issueKey(h, [scope])))),
      await issueKey(h, others),
    ];
    for (const key of keys) {
      const auth = { bearer: key.secret };
      expect((await close(s.p.userId, {}, auth)).status).toBe(403);
      expect((await read(s.p.userId, auth)).status).toBe(403);
      expect((await cancel(s.p.userId, auth)).status).toBe(403);
      expect((await lookup({ issuer: ISSUER, subject: 'x' }, auth)).status).toBe(403);
    }
    expect((await close(s.p.userId, {}, {})).status).toBe(401);

    const elsewhere = await issueKey(other, [SCOPE]);
    expect((await close(s.p.userId, {}, { bearer: elsewhere.secret })).status).toBe(401);
    const revoked = await issueKey(h, [SCOPE]);
    await h.pool.query('UPDATE host_api_keys SET revoked_at=now() WHERE id=$1', [revoked.id]);
    expect((await close(s.p.userId, {}, { bearer: revoked.secret })).status).toBe(401);

    expect(
      (await h.pool.query('SELECT 1 FROM account_closures WHERE user_id=$1', [s.p.userId])).rowCount
    ).toBe(0);
    await closed(await close(s.p.userId));
  });

  // Purpose: fails if a host person can close without their password, or a key can send one.
  it('asks a host person for their password, and never a key', async () => {
    const s = await makeScene(h, operator.cookie, 'person');
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      (await errorOf(await close(s.p.userId, {}, { cookie: operator.cookie }), 403)).code
    ).toBe('REAUTH_REQUIRED');
    expect(
      (
        await errorOf(
          await close(s.p.userId, { password: 'wrong-password' }, { cookie: operator.cookie }),
          403
        )
      ).code
    ).toBe('REAUTH_FAILED');
    expect((await close(s.p.userId, { password: PASSWORD })).status).toBe(400);
    expect(
      (await close('bad%20id', { password: PASSWORD }, { cookie: operator.cookie })).status
    ).toBe(404);
    // Every refusal before the closure is decided is logged too: a wrong password from a stolen
    // session is what a host most needs to hear about.
    const refusals = warned.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('community.account.close'))
      .map((line) => JSON.parse(line) as Record<string, string | null>);
    warned.mockRestore();
    expect(refusals.map((line) => [line.outcome, line.code, line.accountId, line.actorId])).toEqual(
      [
        ['refused', 'REAUTH_REQUIRED', s.p.userId, operatorUserId],
        ['refused', 'REAUTH_FAILED', s.p.userId, operatorUserId],
        ['refused', 'STATE_CONFLICT', s.p.userId, closeKey.id],
        ['refused', 'NOT_FOUND', null, operatorUserId],
      ]
    );
    const { closure } = await closed(
      await close(s.p.userId, { password: PASSWORD }, { cookie: operator.cookie })
    );
    expect(closure.actor).toEqual({ kind: 'person', id: operatorUserId });
  });
});

describe('reasons', () => {
  // Purpose: fails if an unknown reason, `other` without the host's reference, or a reference
  // that is free text (a link, a sentence with punctuation) is accepted.
  it('takes the three reasons, and other only with a reference', async () => {
    const s = await makeScene(h, operator.cookie, 'reason');
    for (const body of [
      { reason: 'spam' },
      { reason: 'other', reference: null },
      { reason: 'legal_order', reference: 'https://example.test/order' },
      { reason: 'legal_order', reference: 'x'.repeat(81) },
    ])
      expect((await close(s.p.userId, body)).status, JSON.stringify(body)).toBe(400);
    expect(
      (await h.pool.query('SELECT 1 FROM erasure_requests WHERE user_id=$1', [s.p.userId])).rowCount
    ).toBe(0);
    const { closure } = await closed(
      await close(s.p.userId, { reason: 'other', reference: 'TICKET-42' })
    );
    expect(closure).toMatchObject({ reason: 'other', reference: 'TICKET-42' });
  });
});

describe('closing an account', () => {
  let s: Scene;
  let closure: Closure;
  let idempotencyKey = '';

  beforeAll(async () => {
    s = await makeScene(h, operator.cookie, 'main');
  });

  // Purpose: fails if the person's browser session, installation grant, or agent keeps working
  // after the closure, if they can sign in again, if anything of theirs is erased before the
  // window ends, or if the audit row names the account rather than the closure.
  it('ends the person’s access at once and schedules the ordinary erasure', async () => {
    // Positive controls: every way in works before the closure.
    expect((await h.call('/api/v1/memberships', { cookie: s.p.cookie })).status).toBe(200);
    expect((await h.call(`${s.base}/channels`, { bearer: s.grant })).status).toBe(200);
    expect((await h.call(`${s.base}/channels`, { bearer: s.agent.token })).status).toBe(200);

    idempotencyKey = randomUUID();
    const result = await closed(
      await close(s.p.userId, { idempotencyKey, reason: 'legal_order', reference: 'Order 7' })
    );
    closure = result.closure;
    expect(result.replayed).toBe(false);
    expect(closure).toMatchObject({
      accountId: s.p.userId,
      state: 'closed',
      reason: 'legal_order',
      reference: 'Order 7',
      personRequested: false,
      actor: { kind: 'api_key', id: closeKey.id },
      waitingOn: null,
      cancelledAt: null,
      erasedAt: null,
    });
    expect(Date.parse(closure.eraseAfter!) - Date.parse(closure.closedAt)).toBe(72 * 3_600_000);

    expect((await h.call('/api/v1/memberships', { cookie: s.p.cookie })).status).toBe(401);
    expect((await h.call(`${s.base}/channels`, { bearer: s.grant })).status).toBe(401);
    expect((await h.call(`${s.base}/channels`, { bearer: s.agent.token })).status).toBe(401);
    const refused = await h.call('/api/auth/sign-in/email', {
      body: { email: await emailOf(s.p.userId), password: PASSWORD },
    });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('This account has been closed.');
    expect(
      (await h.pool.query('SELECT 1 FROM session WHERE "userId"=$1', [s.p.userId])).rowCount
    ).toBe(0);

    // Nothing erased yet: the membership and what P wrote are still there.
    const member = await h.pool.query('SELECT active,erased_at FROM members WHERE id=$1', [
      s.p.memberId,
    ]);
    expect(member.rows[0]).toEqual({ active: true, erased_at: null });
    expect(
      (await h.pool.query('SELECT erased_at FROM entries WHERE id=$1', [s.pEntryId])).rows[0]
        .erased_at
    ).toBeNull();

    const audit = await h.pool.query(
      `SELECT actor_kind,actor_api_key_id,community_id,next_state,subject_account_closure_id,
              to_jsonb(e)::text AS raw
       FROM host_audit_events e WHERE action='account.close' AND subject_account_closure_id=$1`,
      [closure.closureId]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor_kind: 'api_key',
      actor_api_key_id: closeKey.id,
      community_id: null,
      next_state: 'closed',
    });
    expect(audit.rows[0].raw).not.toContain(s.p.userId);
  });

  // Purpose: fails if a replay makes a second closure, if the same key with other inputs or for
  // another account replays, or if a second close of a closed account is accepted.
  it('replays the same key, and refuses a changed one or a second closure', async () => {
    const replay = await closed(
      await close(s.p.userId, { idempotencyKey, reason: 'legal_order', reference: 'Order 7' }),
      200
    );
    expect(replay.replayed).toBe(true);
    // The worker's clock is parked between tests, so only the erasure's date may differ.
    expect({ ...replay.closure, eraseAfter: null }).toEqual({ ...closure, eraseAfter: null });
    expect(
      (
        await errorOf(
          await close(s.p.userId, { idempotencyKey, reason: 'other', reference: 'X' }),
          409
        )
      ).code
    ).toBe('IDEMPOTENCY_CONFLICT');
    expect(
      (
        await errorOf(
          await close(s.q.userId, { idempotencyKey, reason: 'legal_order', reference: 'Order 7' }),
          409
        )
      ).code
    ).toBe('IDEMPOTENCY_CONFLICT');
    expect((await errorOf(await close(s.p.userId), 409)).code).toBe('STATE_CONFLICT');
    expect(
      (await h.pool.query('SELECT 1 FROM account_closures WHERE user_id=$1', [s.p.userId])).rowCount
    ).toBe(1);
    expect((await closureOf(await read(s.p.userId))).closureId).toBe(closure.closureId);
  });

  // Purpose: fails if the erasure runs before its window, does not run after it, or finishes
  // without its journal line, or if the closure does not say it finished.
  it('erases the account after the window and journals it', async () => {
    const request = await erasureRequest(closure);
    await h.pool.query(
      `UPDATE erasure_requests SET execute_after=$2,next_attempt_at=$2 WHERE id=$1`,
      [request.id, new Date(closure.eraseAfter!)]
    );
    expect(await runErasures(h.pool, hoursFromNow(71))).toBe(0);
    expect((await h.pool.query('SELECT 1 FROM "user" WHERE id=$1', [s.p.userId])).rowCount).toBe(1);
    await runErasures(h.pool, hoursFromNow(73));
    expect((await h.pool.query('SELECT 1 FROM "user" WHERE id=$1', [s.p.userId])).rowCount).toBe(0);
    expect(
      (await h.pool.query('SELECT erased_at FROM members WHERE id=$1', [s.p.memberId])).rows[0]
        .erased_at
    ).not.toBeNull();
    expect(
      (
        await h.pool.query(`SELECT 1 FROM erasure_journal WHERE kind='account' AND user_id=$1`, [
          s.p.userId,
        ])
      ).rowCount
    ).toBe(1);
    const after = await closureOf(await read(s.p.userId));
    expect(after).toMatchObject({ closureId: closure.closureId, state: 'erased' });
    expect(after.erasedAt).not.toBeNull();
  });

  // Purpose: fails if a replay stops answering once the account is gone, or if an erased
  // account can be cancelled or closed again.
  it('still answers a replay after the erasure, and refuses anything else', async () => {
    const replay = await closed(
      await close(s.p.userId, { idempotencyKey, reason: 'legal_order', reference: 'Order 7' }),
      200
    );
    expect(replay.closure.state).toBe('erased');
    expect((await errorOf(await cancel(s.p.userId), 409)).code).toBe('STATE_CONFLICT');
    expect((await errorOf(await close(s.p.userId), 404)).code).toBe('NOT_FOUND');
  });
});

describe('cancelling a closure', () => {
  // Purpose: fails if cancelling leaves the person locked out, leaves the erasure scheduled,
  // is not audited, or is not idempotent; or if the account cannot be closed again afterwards.
  it('lets the person sign in again and cancels the erasure', async () => {
    const s = await makeScene(h, operator.cookie, 'cancel');
    const email = await emailOf(s.p.userId);
    const { closure } = await closed(await close(s.p.userId));
    expect(await signIn(email)).toBe(403);

    const cancelled = await closureOf(await cancel(s.p.userId));
    expect(cancelled).toMatchObject({ closureId: closure.closureId, state: 'cancelled' });
    expect(cancelled.cancelledAt).not.toBeNull();
    expect((await erasureRequest(closure)).state).toBe('cancelled');
    expect(await signIn(email)).toBe(200);
    expect(await runErasures(h.pool, hoursFromNow(73))).toBe(0);
    expect((await h.pool.query('SELECT 1 FROM "user" WHERE id=$1', [s.p.userId])).rowCount).toBe(1);

    expect(await closureOf(await cancel(s.p.userId))).toEqual(cancelled);
    expect(
      (
        await h.pool.query(
          `SELECT 1 FROM host_audit_events
           WHERE action='account.close.cancel' AND subject_account_closure_id=$1`,
          [closure.closureId]
        )
      ).rowCount
    ).toBe(1);

    const again = await closed(await close(s.p.userId));
    expect(again.closure.closureId).not.toBe(closure.closureId);
    expect((await closureOf(await read(s.p.userId))).closureId).toBe(again.closure.closureId);
  });

  // Purpose: fails if cancelling an account that was never closed answers anything but 404.
  it('answers 404 for an account that was never closed', async () => {
    const s = await makeScene(h, operator.cookie, 'never');
    expect((await errorOf(await cancel(s.p.userId), 404)).code).toBe('NOT_FOUND');
    expect((await errorOf(await read(s.p.userId), 404)).code).toBe('NOT_FOUND');
  });

  // Purpose: fails if a cancel that waits behind the worker's claim cancels an erasure that has
  // already started, or if the two deadlock. The account row is held so the cancel queues
  // first, then the real worker claims the request and runs to its last step, which queues
  // behind the cancel on the same account row.
  it('refuses a cancel that loses the race to the worker, and the erasure finishes', async () => {
    const s = await makeScene(h, operator.cookie, 'race');
    const { closure } = await closed(await close(s.p.userId));
    const request = await erasureRequest(closure);
    await h.pool.query(
      `UPDATE erasure_requests SET execute_after=created_at,next_attempt_at=created_at WHERE id=$1`,
      [request.id]
    );
    const [cancelResponse] = await holdingLock(
      h,
      'SELECT 1 FROM "user" WHERE id=$1 FOR UPDATE',
      [s.p.userId],
      async (release, holderPid) => {
        const pendingCancel = cancel(s.p.userId);
        await waitForBlockedBy(h, holderPid, 1);
        const pendingSweep = sweepErasures(h.pool, { now: new Date() });
        // The cancel and the erasure's last step both wait on the account row: the second
        // queues behind the first, so it is not blocked by the holder directly.
        await waitForLockWaiters(h, 2, 'FROM "user" WHERE id=$1 FOR UPDATE');
        expect((await erasureRequest(closure)).state).toBe('running');
        await release();
        return Promise.all([pendingCancel, pendingSweep]);
      }
    );
    expect((await errorOf(cancelResponse, 409)).message).toMatch(/already started/);
    expect((await closureOf(await read(s.p.userId))).state).toBe('erased');
  });
});

describe('the person had already asked to delete their account', () => {
  // Purpose: fails if the closure makes a second erasure, or if cancelling the closure also
  // cancels the person's own request.
  it('joins their request, and a cancel leaves it waiting', async () => {
    const s = await makeScene(h, operator.cookie, 'own');
    const email = await emailOf(s.p.userId);
    const own = (await (
      await expectStatus(
        await h.call('/api/v1/account/erasures', {
          cookie: s.p.cookie,
          body: { kind: 'account', confirmEmail: email, password: PASSWORD },
        }),
        201,
        'own erasure'
      )
    ).json()) as { erasure: { id: string; executeAfter: string } };
    const { closure } = await closed(await close(s.p.userId));
    expect(closure.personRequested).toBe(true);
    expect((await erasureRequest(closure)).id).toBe(own.erasure.id);
    expect(closure.eraseAfter).toBe(own.erasure.executeAfter);
    expect(await signIn(email)).toBe(403);

    await closureOf(await cancel(s.p.userId));
    expect((await erasureRequest(closure)).state).toBe('scheduled');
    expect(await signIn(email)).toBe(200);
  });

  // Purpose: fails if the host can close an account whose erasure is already running.
  it('refuses while the person’s own erasure is running', async () => {
    const s = await makeScene(h, operator.cookie, 'running');
    await h.pool.query(
      `INSERT INTO erasure_requests(kind,user_id,state,execute_after,started_at,next_attempt_at)
       VALUES('account',$1,'running',now(),now(),now()+interval '365 days')`,
      [s.p.userId]
    );
    expect((await errorOf(await close(s.p.userId), 409)).message).toMatch(/already being erased/);
    expect(
      (await h.pool.query('SELECT 1 FROM account_closures WHERE user_id=$1', [s.p.userId])).rowCount
    ).toBe(0);
  });
});

describe('legal holds', () => {
  // Purpose: fails if a host closure erases content in a community under a legal hold, if the
  // host is not told why it waits, or if releasing the hold does not let it finish. The person's
  // own erasure in the same held community is not held, as before.
  it('waits for the hold to be released; a person’s own erasure does not', async () => {
    const s = await makeScene(h, operator.cookie, 'hold');
    await legalHold('PUT', s.communityId);
    const { closure } = await closed(await close(s.p.userId));
    const qEmail = await emailOf(s.q.userId);
    await expectStatus(
      await h.call('/api/v1/account/erasures', {
        cookie: s.q.cookie,
        body: { kind: 'account', confirmEmail: qEmail, password: PASSWORD },
      }),
      201,
      'own erasure'
    );
    await h.pool.query(
      `UPDATE erasure_requests SET execute_after=created_at,next_attempt_at=created_at
       WHERE kind='account' AND user_id=ANY($1::text[])`,
      [[s.p.userId, s.q.userId]]
    );
    expect((await closureOf(await read(s.p.userId))).waitingOn).toBe('legal_hold');

    await runErasures(h.pool, new Date());
    expect((await h.pool.query('SELECT 1 FROM "user" WHERE id=$1', [s.q.userId])).rowCount).toBe(0);
    expect((await h.pool.query('SELECT 1 FROM "user" WHERE id=$1', [s.p.userId])).rowCount).toBe(1);
    expect(
      (await h.pool.query('SELECT erased_at FROM entries WHERE id=$1', [s.pEntryId])).rows[0]
        .erased_at
    ).toBeNull();
    expect((await erasureRequest(closure)).state).toBe('scheduled');

    await legalHold('DELETE', s.communityId);
    expect((await closureOf(await read(s.p.userId))).waitingOn).toBeNull();
    await runErasures(h.pool, new Date());
    expect((await closureOf(await read(s.p.userId))).state).toBe('erased');
  });

  // Purpose: fails if a closure that joined the person's own request makes that request wait
  // on a legal hold: it is still the person's own erasure.
  it('does not hold the person’s own request when the closure joined it', async () => {
    const s = await makeScene(h, operator.cookie, 'ownhold');
    await legalHold('PUT', s.communityId);
    await expectStatus(
      await h.call('/api/v1/account/erasures', {
        cookie: s.p.cookie,
        body: { kind: 'account', confirmEmail: await emailOf(s.p.userId), password: PASSWORD },
      }),
      201,
      'own erasure'
    );
    const { closure } = await closed(await close(s.p.userId));
    expect(closure).toMatchObject({ personRequested: true, waitingOn: null });
    await h.pool.query(
      `UPDATE erasure_requests SET execute_after=created_at,next_attempt_at=created_at WHERE id=$1`,
      [(await erasureRequest(closure)).id]
    );
    await runErasures(h.pool, new Date());
    expect((await closureOf(await read(s.p.userId))).state).toBe('erased');
    await legalHold('DELETE', s.communityId);
  });

  // Purpose: fails if a hold placed after the worker started a closure's erasure does not stop
  // it before the next community, or if the erasure does not finish once the hold is released.
  it('stops a running erasure before the next community', async () => {
    const first = await makeScene(h, operator.cookie, 'midrun');
    const second = await makeScene(h, operator.cookie, 'midrun2');
    const bound = await bindInvite(h, second.base, second.owner.cookie, first.p.cookie);
    const joined = (await (
      await expectStatus(
        await h.call(`${second.base}/invites/redeem`, { cookie: bound, body: {} }),
        200,
        'join second'
      )
    ).json()) as { memberId: string };
    const { closure } = await closed(await close(first.p.userId));
    const request = await erasureRequest(closure);
    await h.pool.query(
      `UPDATE erasure_requests SET execute_after=created_at,next_attempt_at=created_at WHERE id=$1`,
      [request.id]
    );
    let held = false;
    const result = await sweepErasures(h.pool, {
      now: new Date(),
      hooks: {
        afterStep: async (step) => {
          if (step !== 'end-access' || held) return;
          held = true;
          await legalHold('PUT', first.communityId);
          await legalHold('PUT', second.communityId);
        },
      },
    });
    expect(result).toEqual({ claimed: 1, completed: 0, failed: 1 });
    const state = await h.pool.query<{ state: string; last_error_class: string }>(
      'SELECT state,last_error_class FROM erasure_requests WHERE id=$1',
      [request.id]
    );
    expect(state.rows[0]).toEqual({ state: 'running', last_error_class: 'LEGAL_HOLD' });
    const husks = await h.pool.query<{ erased: boolean }>(
      'SELECT erased_at IS NOT NULL AS erased FROM members WHERE id=ANY($1::uuid[])',
      [[first.p.memberId, joined.memberId]]
    );
    // The community it had started on finished; the other was not touched.
    expect(husks.rows.map((row) => row.erased).sort()).toEqual([false, true]);
    expect((await sweepErasures(h.pool, { now: hoursFromNow(2) })).claimed).toBe(0);

    await legalHold('DELETE', first.communityId);
    await legalHold('DELETE', second.communityId);
    await runErasures(h.pool, hoursFromNow(2));
    expect((await closureOf(await read(first.p.userId))).state).toBe('erased');
  });
});

describe('accounts that cannot be closed', () => {
  // Purpose: fails if an owner can be closed (and so vanish from a community they own), or if
  // the refusal leaves a closure, an erasure, or a signed-out owner behind.
  it('refuses an owner by name, and changes nothing', async () => {
    const s = await makeScene(h, operator.cookie, 'owner');
    const ownerId = (
      await h.pool.query<{ user_id: string }>(
        `SELECT user_id FROM members WHERE community_id=$1 AND role='owner'`,
        [s.communityId]
      )
    ).rows[0].user_id;
    const refusal = await errorOf(await close(ownerId), 409);
    expect(refusal.code).toBe('ACCOUNT_OWNS_COMMUNITY');
    expect(refusal.message).toContain(s.communityId);
    expect(
      (await h.pool.query('SELECT 1 FROM account_closures WHERE user_id=$1', [ownerId])).rowCount
    ).toBe(0);
    expect(
      (await h.pool.query('SELECT 1 FROM erasure_requests WHERE user_id=$1', [ownerId])).rowCount
    ).toBe(0);
    expect((await h.call('/api/v1/memberships', { cookie: s.owner.cookie })).status).toBe(200);
  });

  // Purpose: fails if the account that runs the host can be closed.
  it('refuses a host operator', async () => {
    expect((await errorOf(await close(operatorUserId), 409)).message).toMatch(
      /operated this server/
    );
  });

  // Purpose: fails if an unknown, malformed, or already-erased account answers anything but 404.
  it('answers 404 for an account that is not here', async () => {
    const s = await makeScene(h, operator.cookie, 'gone');
    await h.pool.query(
      `INSERT INTO erasure_requests(kind,user_id,execute_after,next_attempt_at)
       VALUES('account',$1,now(),now())`,
      [s.p.userId]
    );
    await runErasures(h.pool, hoursFromNow(1));
    expect((await h.pool.query('SELECT 1 FROM "user" WHERE id=$1', [s.p.userId])).rowCount).toBe(0);
    for (const id of [s.p.userId, 'nobody-here', 'bad%20id'])
      expect((await close(id)).status, id).toBe(404);
  });
});

describe('finding an account by its sign-in identity', () => {
  // Purpose: fails if the lookup finds an account by anything but an exact single sign-on
  // identity from this host's own issuer: another provider's id, a password account's id, or
  // another issuer must not answer.
  it('answers only an exact identity from this host’s issuer', async () => {
    const s = await makeScene(h, operator.cookie, 'lookup');
    const subject = `sub-${randomUUID()}`;
    await h.pool.query(
      `INSERT INTO account(id,"accountId","providerId","userId") VALUES($1,$2,'oidc',$3),
         ($4,$2,'github',$5)`,
      [randomUUID(), subject, s.p.userId, randomUUID(), s.q.userId]
    );
    const found = await expectStatus(await lookup({ issuer: ISSUER, subject }), 200, 'lookup');
    expect(await found.json()).toEqual({ accountId: s.p.userId });
    expect((await lookup({ issuer: `${ISSUER}/`, subject })).status).toBe(200);

    // Q signs in with a password: Better Auth stores the account id as the credential's id.
    for (const miss of [subject.toUpperCase(), `${subject} `, s.q.userId, 'sub-'])
      expect((await lookup({ issuer: ISSUER, subject: miss })).status, miss).toBe(404);
    expect((await lookup({ issuer: 'https://other.test', subject })).status).toBe(409);
    expect((await lookup({ issuer: ISSUER })).status).toBe(400);

    const bare = await issueKey(other, [SCOPE]);
    expect((await lookup({ issuer: ISSUER, subject }, { bearer: bare.secret }, other)).status).toBe(
      409
    );
  });
});

describe('what the closure ends', () => {
  // Purpose: fails if an installation the person approved but had not finished connecting can
  // still collect its grant after the closure, or if an invitation link the person issued still
  // lets someone join.
  it('cancels an approved, unredeemed pairing and revokes the person’s invitations', async () => {
    const s = await makeScene(h, operator.cookie, 'pairing');
    const local = { origin: '' };
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const { pairingId } = (await (
      await expectStatus(
        await h.call(`${s.base}/pairings/start`, {
          headers: local,
          body: { installName: 'late laptop', challenge, scopes: ['read'] },
        }),
        201,
        'pairing start'
      )
    ).json()) as { pairingId: string };
    await expectStatus(
      await h.call(`${s.base}/pairings/approve`, { cookie: s.p.cookie, body: { pairingId } }),
      200,
      'pairing approve'
    );
    const { code } = (await (
      await expectStatus(
        await h.call(`${s.base}/pairings/poll`, { headers: local, body: { pairingId, verifier } }),
        200,
        'pairing poll'
      )
    ).json()) as { code: string };
    // P may invite here only as an admin; promote them so the link is theirs.
    await h.pool.query(`UPDATE members SET role='admin' WHERE id=$1`, [s.p.memberId]);
    const invite = (await (
      await expectStatus(
        await h.call(`${s.base}/invites`, { cookie: s.p.cookie, body: { seats: 1 } }),
        201,
        'invite'
      )
    ).json()) as { token: string };
    const grants = async () =>
      Number(
        (
          await h.pool.query<{ count: string }>(
            'SELECT count(*) FROM connection_grants WHERE member_id=$1',
            [s.p.memberId]
          )
        ).rows[0].count
      );
    const before = await grants();
    // Another admin's link, which the closure must leave alone.
    const owners = (await (
      await expectStatus(
        await h.call(`${s.base}/invites`, { cookie: s.owner.cookie, body: { seats: 1 } }),
        201,
        'owner invite'
      )
    ).json()) as { token: string };
    const preview = async (token = invite.token) =>
      (await h.call(`${s.base}/invites/preview`, { body: { token } })).status;
    expect(await preview()).toBe(200);
    expect(await preview(owners.token)).toBe(200);

    await closed(await close(s.p.userId));
    const polled = await expectStatus(
      await h.call(`${s.base}/pairings/poll`, { headers: local, body: { pairingId, verifier } }),
      200,
      'poll after closure'
    );
    expect(await polled.json()).toMatchObject({ status: 'cancelled' });
    expect(
      (
        await h.call(`${s.base}/pairings/exchange`, {
          headers: local,
          body: { pairingId, code, verifier },
        })
      ).status
    ).toBe(409);
    expect(await grants()).toBe(before);
    expect(await preview()).toBe(403);
    expect(await preview(owners.token)).toBe(200);
  });
});

describe('the daily limit and the alert line', () => {
  // Purpose: fails if one actor can close more accounts in a day than the host allows, if a
  // refused closure writes anything, if the limit is shared between actors, or if a closure or a
  // refusal is not logged with ids only.
  it('stops an actor at the limit and logs every closure and refusal', async () => {
    const key = await issueKey(other, [SCOPE]);
    const second = await issueKey(other, [SCOPE]);
    const users: string[] = [];
    for (let index = 0; index < 4; index++) {
      const id = `bare-${randomUUID()}`;
      await other.pool.query(
        `INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,'Bare Person',$2,true)`,
        [id, `${id}@x.test`]
      );
      users.push(id);
    }
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const first = await closed(await close(users[0], {}, { bearer: key.secret }, other));
      const replayKey = randomUUID();
      await closed(
        await close(users[1], { idempotencyKey: replayKey }, { bearer: key.secret }, other)
      );
      // A replay is not a new closure: it neither counts against the limit nor logs a line.
      await closed(
        await close(users[1], { idempotencyKey: replayKey }, { bearer: key.secret }, other),
        200
      );
      // Cancelling does not give the actor its closure back.
      await expectStatus(
        await other.call(`${path(users[1])}/cancel`, { bearer: key.secret, body: {} }),
        200,
        'cancel'
      );
      const limited = await close(users[2], {}, { bearer: key.secret }, other);
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(
        (await other.pool.query('SELECT 1 FROM account_closures WHERE user_id=$1', [users[2]]))
          .rowCount
      ).toBe(0);
      await closed(await close(users[2], {}, { bearer: second.secret }, other));
      expect((await close('nobody-here', {}, { bearer: second.secret }, other)).status).toBe(404);

      const lines = warned.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes('community.account.close'))
        .map((line) => JSON.parse(line) as Record<string, string>);
      expect(lines).toHaveLength(5);
      expect(lines[0]).toEqual({
        event: 'community.account.close',
        outcome: 'closed',
        accountId: users[0],
        actorKind: 'api_key',
        actorId: key.id,
        closureId: first.closure.closureId,
      });
      expect(lines.map((line) => [line.outcome, line.code ?? null])).toEqual([
        ['closed', null],
        ['closed', null],
        ['refused', 'RATE_LIMITED'],
        ['closed', null],
        ['refused', 'NOT_FOUND'],
      ]);
      for (const line of lines)
        expect(Object.keys(line).sort()).toEqual(
          [
            'accountId',
            'actorId',
            'actorKind',
            'event',
            'outcome',
            line.code ? 'code' : 'closureId',
          ].sort()
        );
    } finally {
      warned.mockRestore();
    }
  });

  // Purpose: fails if one key reused for two accounts at the same moment answers 500 rather
  // than one closure and one idempotency conflict.
  it('decides a key reused for two accounts at once one at a time', async () => {
    const a = await makeScene(h, operator.cookie, 'samekey');
    const idempotencyKey = randomUUID();
    const responses = await holdingLock(
      h,
      'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`account-closure:api_key:${closeKey.id}`],
      async (release, holderPid) => {
        const pending = [
          close(a.p.userId, { idempotencyKey }),
          close(a.q.userId, { idempotencyKey }),
        ];
        await waitForBlockedBy(h, holderPid, 2);
        await release();
        return Promise.all(pending);
      }
    );
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const conflict = responses.find((response) => response.status === 409)!;
    expect((await conflict.json()).code).toBe('IDEMPOTENCY_CONFLICT');
  });
});

// Last: it ages every closure in this database by a month.
describe('cleaning up finished closures', () => {
  // Purpose: fails if a finished or cancelled closure outlives its 30 days, if an open one is
  // deleted, or if the host audit rows go with them.
  it('deletes finished and cancelled closures after 30 days and keeps their audit rows', async () => {
    const done = await makeScene(h, operator.cookie, 'prune1');
    const kept = await makeScene(h, operator.cookie, 'prune2');
    const erased = (await closed(await close(done.p.userId))).closure;
    await h.pool.query(
      `UPDATE erasure_requests SET execute_after=created_at,next_attempt_at=created_at WHERE id=$1`,
      [(await erasureRequest(erased)).id]
    );
    await runErasures(h.pool, new Date());
    const cancelled = (await closed(await close(done.q.userId))).closure;
    await closureOf(await cancel(done.q.userId));
    const open = (await closed(await close(kept.p.userId))).closure;
    const ids = [erased.closureId, cancelled.closureId, open.closureId];
    const states = async () =>
      (
        await h.pool.query<{ id: string; state: string }>(
          'SELECT id,state FROM account_closures WHERE id=ANY($1::uuid[]) ORDER BY state',
          [ids]
        )
      ).rows;
    expect((await states()).map((row) => row.state)).toEqual(['cancelled', 'closed', 'completed']);

    await pruneErasureRequests(h.pool, new Date(Date.now() + 29 * 24 * 3_600_000));
    expect(await states()).toHaveLength(3);
    await pruneErasureRequests(h.pool, new Date(Date.now() + 31 * 24 * 3_600_000));
    expect(await states()).toEqual([{ id: open.closureId, state: 'closed' }]);
    expect((await closureOf(await read(kept.p.userId))).state).toBe('closed');
    const audit = await h.pool.query<{ subject_account_closure_id: string; action: string }>(
      `SELECT subject_account_closure_id,action FROM host_audit_events
       WHERE subject_account_closure_id=ANY($1::uuid[]) ORDER BY created_at`,
      [ids]
    );
    expect(audit.rows.map((row) => [row.subject_account_closure_id, row.action])).toEqual([
      [erased.closureId, 'account.close'],
      [cancelled.closureId, 'account.close'],
      [cancelled.closureId, 'account.close.cancel'],
      [open.closureId, 'account.close'],
    ]);
  });
});
