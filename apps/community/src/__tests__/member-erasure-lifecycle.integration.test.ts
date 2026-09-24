import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCommunityAuth } from '../auth.js';
import { type ErasureHooks } from '../erasure/erasure.js';
import {
  admit,
  bootstrapHost,
  createPendingCommunity,
  preflightOwnerClaim,
  startTenancyHarness,
  type TenancyHarness,
} from './tenancy-test-harness.js';
import { body, hoursFromNow, PASSWORD, post, runErasures } from './member-erasure-fixture.js';
import {
  bindInvite as bindFor,
  communityDigest,
  makeScene,
  requestErasure as requestFor,
  type Scene,
} from './member-erasure-scenes.js';

// Purpose: the erasure window and its cancel (AC-5), who may ask (AC-6), the guards around a
// running erasure (AC-7), and every lifecycle (AC-9). Each scene is its own community.

let h: TenancyHarness;
let host: { cookie: string; communityId: string };
const scene = (label: string) => makeScene(h, host.cookie, label);
const bindInvite = (base: string, ownerCookie: string, cookie: string) =>
  bindFor(h, base, ownerCookie, cookie);
const requestErasure = (cookie: string, communityId: string) => requestFor(h, cookie, communityId);

beforeAll(async () => {
  h = await startTenancyHarness('erasurelife', { reauthAttemptsPerMinute: 5 });
  host = await bootstrapHost(h, 'Hana Host', 'hana@host.test');
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('window and cancel (AC-5)', () => {
  it('schedules 72 hours out, changes nothing until then, and cancels as a full undo', async () => {
    const s = await scene('window');
    const { erasure } = await requestErasure(s.p.cookie, s.communityId);
    expect(erasure.state).toBe('scheduled');
    expect(Date.parse(erasure.executeAfter) - Date.parse(erasure.createdAt)).toBe(72 * 3_600_000);
    const repeat = await h.call('/api/v1/account/erasures', {
      cookie: s.p.cookie,
      body: { kind: 'membership', communityId: s.communityId, password: PASSWORD },
    });
    expect((await body<{ erasure: { id: string } }>(repeat, 200, 'repeat')).erasure.id).toBe(
      erasure.id
    );
    const justAfter = await communityDigest(h.pool, s.communityId, ['erasure_requests']);
    await runErasures(h.pool, hoursFromNow(71));
    expect(await communityDigest(h.pool, s.communityId, ['erasure_requests'])).toBe(justAfter);

    // The person can still post during the window.
    await post(
      h,
      s.communityId,
      s.channelId,
      { cookie: s.p.cookie },
      {
        text: 'still here',
        idempotencyKey: 'window-post',
      }
    );
    const beforeCancel = await communityDigest(h.pool, s.communityId, ['erasure_requests']);
    const cancelled = await body<{ erasure: { state: string; cancelledAt: string } }>(
      await h.call(`/api/v1/account/erasures/${erasure.id}/cancel`, {
        cookie: s.p.cookie,
        body: {},
      }),
      200,
      'cancel'
    );
    expect(cancelled.erasure.state).toBe('cancelled');
    await runErasures(h.pool, hoursFromNow(80));
    expect(await communityDigest(h.pool, s.communityId, ['erasure_requests'])).toBe(beforeCancel);
    const listed = await body<{ erasures: { id: string; state: string }[] }>(
      await h.call('/api/v1/account/erasures', { cookie: s.p.cookie }),
      200,
      'list'
    );
    expect(listed.erasures).toEqual([
      expect.objectContaining({ id: erasure.id, state: 'cancelled' }),
    ]);

    // Once the window has passed, cancel is refused.
    const late = await requestErasure(s.p.cookie, s.communityId);
    await h.pool.query(
      `UPDATE erasure_requests SET created_at=created_at-interval '73 hours',
         execute_after=execute_after-interval '73 hours',next_attempt_at=next_attempt_at-interval '73 hours'
       WHERE id=$1`,
      [late.erasure.id]
    );
    expect(
      (
        await h.call(`/api/v1/account/erasures/${late.erasure.id}/cancel`, {
          cookie: s.p.cookie,
          body: {},
        })
      ).status
    ).toBe(409);
  });
});

describe('authority (AC-6)', () => {
  it('refuses every erasure route to any bearer credential', async () => {
    const s = await scene('bearer');
    const { erasure } = await requestErasure(s.p.cookie, s.communityId);
    const routes = [
      { path: '/api/v1/account/former-memberships' },
      { path: '/api/v1/account/erasures' },
      {
        path: '/api/v1/account/erasures',
        body: { kind: 'membership', communityId: s.communityId, password: PASSWORD },
      },
      { path: `/api/v1/account/erasures/${erasure.id}/cancel`, body: {} },
      { path: `${s.base}/owner/erasures` },
    ];
    // A real host API key, issued by the operator, with every host permission.
    const issued = await body<{ secret: string }>(
      await h.call('/api/v1/host/api-keys', {
        cookie: host.cookie,
        body: {
          label: 'erasure probe',
          scopes: ['communities:read', 'communities:write', 'communities:lifecycle'],
          expiresInDays: 1,
          password: PASSWORD,
        },
      }),
      201,
      'issue host key'
    );
    for (const bearer of [s.grant, s.agent.token, issued.secret, `dkh_${'A'.repeat(43)}`]) {
      for (const route of routes) {
        const response = await h.call(route.path, { bearer, body: route.body });
        // Account routes refuse any bearer (403). Community routes refuse a host key before
        // anything else runs (401), and every other bearer at the erasure route (403).
        const hostKey = bearer.toLowerCase().startsWith('dkh_');
        const expected = route.path.startsWith(s.base) && hostKey ? 401 : 403;
        expect(response.status, `${route.path} with a bearer`).toBe(expected);
      }
      // A bearer beside the person's own cookie is still refused, whatever its case.
      const both = await h.call('/api/v1/account/erasures', {
        cookie: s.p.cookie,
        headers: { authorization: `bearer ${bearer}` },
      });
      expect(both.status).toBe(403);
    }
    // The erasure is exactly as it was.
    expect(
      (await h.pool.query('SELECT state FROM erasure_requests WHERE id=$1', [erasure.id])).rows[0]
        .state
    ).toBe('scheduled');
  });

  it('gives host authority nothing to create, cancel, or read', async () => {
    const s = await scene('host');
    const { erasure } = await requestErasure(s.p.cookie, s.communityId);
    const listed = await body<{ erasures: unknown[] }>(
      await h.call('/api/v1/account/erasures', { cookie: host.cookie }),
      200,
      'operator list'
    );
    expect(listed.erasures).toEqual([]);
    expect(
      (
        await h.call('/api/v1/account/erasures', {
          cookie: host.cookie,
          body: { kind: 'membership', communityId: s.communityId, password: PASSWORD },
        })
      ).status
    ).toBe(404);
    expect(
      (
        await h.call(`/api/v1/account/erasures/${erasure.id}/cancel`, {
          cookie: host.cookie,
          body: {},
        })
      ).status
    ).toBe(404);
    expect((await h.call(`${s.base}/owner/erasures`, { cookie: host.cookie })).status).toBe(403);
    const state = await h.pool.query('SELECT state FROM erasure_requests WHERE id=$1', [
      erasure.id,
    ]);
    expect(state.rows[0].state).toBe('scheduled');
  });

  it('refuses an owner their own membership, and account deletion to operators and owners', async () => {
    const s = await scene('owner');
    expect(
      (
        await h.call('/api/v1/account/erasures', {
          cookie: s.owner.cookie,
          body: { kind: 'membership', communityId: s.communityId, password: PASSWORD },
        })
      ).status
    ).toBe(403);
    const account = (cookie: string, confirmEmail: string) =>
      h.call('/api/v1/account/erasures', {
        cookie,
        body: { kind: 'account', confirmEmail, password: PASSWORD },
      });
    expect((await account(host.cookie, 'hana@host.test')).status).toBe(403);
    // A revoked operator's account still names who acted in host audit rows.
    await h.pool.query('INSERT INTO host_operators(user_id,revoked_at) VALUES($1,now())', [
      s.q.userId,
    ]);
    const email = (await h.pool.query('SELECT email FROM "user" WHERE id=$1', [s.q.userId])).rows[0]
      .email;
    expect((await account(s.q.cookie, email)).status).toBe(403);
    const ownerEmail = (
      await h.pool.query(
        'SELECT u.email FROM "user" u JOIN members m ON m.user_id=u.id WHERE m.id=$1',
        [s.owner.memberId]
      )
    ).rows[0].email;
    const refused = await account(s.owner.cookie, ownerEmail);
    expect(refused.status).toBe(409);
    expect((await refused.json()).message).toContain(`Scene owner`);
    // Suspension does not hide ownership.
    const version = (
      await h.pool.query('SELECT lifecycle_version FROM communities WHERE id=$1', [s.communityId])
    ).rows[0].lifecycle_version;
    await body(
      await h.call(`/api/v1/host/communities/${s.communityId}/lifecycle`, {
        method: 'PATCH',
        cookie: host.cookie,
        body: { action: 'suspend', lifecycleVersion: version },
      }),
      200,
      'suspend'
    );
    expect((await account(s.owner.cookie, ownerEmail)).status).toBe(409);
    // A wrong email is refused before anything else.
    expect((await account(s.p.cookie, 'someone@else.test')).status).toBe(409);
  });

  it('shows the owner completed self-erasures only, and nobody else', async () => {
    const s = await scene('ownerlist');
    const { erasure } = await requestErasure(s.p.cookie, s.communityId);
    const list = async (cookie: string) => h.call(`${s.base}/owner/erasures`, { cookie });
    expect(await body(await list(s.owner.cookie), 200, 'scheduled')).toEqual({ erasures: [] });
    expect((await list(s.q.cookie)).status).toBe(403);
    await runErasures(h.pool, hoursFromNow(73));
    const done = await body<{ erasures: { id: string; memberId: string }[] }>(
      await list(s.owner.cookie),
      200,
      'completed'
    );
    expect(done.erasures).toEqual([
      expect.objectContaining({ id: erasure.id, memberId: s.p.memberId }),
    ]);
    // A completed membership erasure no longer links to the account.
    const mine = await body<{ erasures: unknown[] }>(
      await h.call('/api/v1/account/erasures', { cookie: s.p.cookie }),
      200,
      'mine'
    );
    expect(mine.erasures).toEqual([]);
  });

  // Purpose: erasure spends from the same per-account password budget as every other
  // confirmation (five a minute here), so a stolen session cannot guess the password; once it
  // is spent even the right one waits, and another account is unaffected.
  it('limits wrong passwords per account', async () => {
    const s = await scene('guess');
    const attempt = (cookie: string, password: string) =>
      h.call('/api/v1/account/erasures', {
        cookie,
        body: { kind: 'membership', communityId: s.communityId, password },
      });
    for (let tries = 0; tries < 5; tries++) {
      const wrong = await attempt(s.p.cookie, `wrong-${tries}`);
      expect(wrong.status).toBe(403);
      expect((await wrong.json()).code).toBe('REAUTH_FAILED');
    }
    expect((await attempt(s.p.cookie, 'wrong-again')).status).toBe(429);
    expect((await attempt(s.p.cookie, PASSWORD)).status).toBe(429);
    expect((await attempt(s.q.cookie, PASSWORD)).status).toBe(201);
  });

  it('asks a password account for its password and a provider-only account to sign in again', async () => {
    const s = await scene('reauth');
    expect(
      (
        await h.call('/api/v1/account/erasures', {
          cookie: s.p.cookie,
          body: { kind: 'membership', communityId: s.communityId },
        })
      ).status
    ).toBe(403);
    expect(
      (
        await h.call('/api/v1/account/erasures', {
          cookie: s.p.cookie,
          body: { kind: 'membership', communityId: s.communityId, password: 'wrong-password' },
        })
      ).status
    ).toBe(403);
    // Remove the password: this account now signs in only through a provider.
    await h.pool.query(`DELETE FROM account WHERE "userId"=$1 AND "providerId"='credential'`, [
      s.p.userId,
    ]);
    // Better Auth writes this column from a JavaScript Date, so the test does too.
    await h.pool.query(`UPDATE session SET "createdAt"=$2 WHERE "userId"=$1`, [
      s.p.userId,
      new Date(Date.now() - 10 * 60_000),
    ]);
    const stale = await h.call('/api/v1/account/erasures', {
      cookie: s.p.cookie,
      body: { kind: 'membership', communityId: s.communityId },
    });
    expect(stale.status).toBe(403);
    expect((await stale.json()).code).toBe('REAUTH_REQUIRED');
    await h.pool.query(`UPDATE session SET "createdAt"=$2 WHERE "userId"=$1`, [
      s.p.userId,
      new Date(),
    ]);
    // Without a password, the fresh session is the proof.
    await requestErasure(s.p.cookie, s.communityId);
  });
});

describe('guards (AC-7)', () => {
  it('refuses ownership to a member who is leaving', async () => {
    const s = await scene('transfer');
    await requestErasure(s.p.cookie, s.communityId);
    const version = (
      await h.pool.query('SELECT lifecycle_version FROM communities WHERE id=$1', [s.communityId])
    ).rows[0].lifecycle_version;
    const transfer = await h.call(`${s.base}/owner/transfer`, {
      cookie: s.owner.cookie,
      body: { successorMemberId: s.p.memberId, password: PASSWORD, lifecycleVersion: version },
    });
    expect(transfer.status).toBe(409);
    expect((await transfer.json()).message).toBe('That member is leaving this community.');
  });

  it('refuses re-admission while a membership erasure runs', async () => {
    const s = await scene('readmit');
    await requestErasure(s.p.cookie, s.communityId);
    // Mid-run, after step 1 ended P's access: an invitation P binds now would reactivate the
    // same member row, so the guard must refuse it.
    let redeemed = 0;
    const hooks: ErasureHooks = {
      afterStep: async (step) => {
        if (step !== 'tombstones') return;
        const cookie = await bindInvite(s.base, s.owner.cookie, s.p.cookie);
        redeemed = (await h.call(`${s.base}/invites/redeem`, { cookie, body: {} })).status;
      },
    };
    await runErasures(h.pool, hoursFromNow(73), { hooks });
    expect(redeemed).toBe(409);
    const husk = await h.pool.query('SELECT active,erased_at FROM members WHERE id=$1', [
      s.p.memberId,
    ]);
    expect(husk.rows[0].active).toBe(false);
    expect(husk.rows[0].erased_at).not.toBeNull();
    // Afterwards the same account may join again, as a new person.
    const again = await admit(h, s.communityId, s.owner.cookie, { cookie: s.p.cookie });
    expect(again.memberId).not.toBe(s.p.memberId);
  });

  it('signs the person out and refuses every way back in while an account erasure runs', async () => {
    const s = await scene('account');
    const other = await scene('elsewhere');
    const email = (await h.pool.query('SELECT email FROM "user" WHERE id=$1', [s.p.userId])).rows[0]
      .email as string;
    await body(
      await h.call('/api/v1/account/erasures', {
        cookie: s.p.cookie,
        body: { kind: 'account', confirmEmail: email, password: PASSWORD },
      }),
      201,
      'account erasure'
    );
    // Better Auth's verification rows: this account's (by user id or email, exact shapes) and
    // a neighbour whose email merely contains this one, which must survive.
    const neighbour = `x${email}`;
    await h.pool.query(
      `INSERT INTO verification(id,identifier,value,"expiresAt") VALUES
         ('mine-reset','reset-password:tok-a',$1,now()+interval '1 hour'),
         ('mine-email','email-verification',$2,now()+interval '1 hour'),
         ('mine-otp',$3,'123456',now()+interval '1 hour'),
         ('mine-plain',$2,'654321',now()+interval '1 hour'),
         ('other-email','email-verification',$4,now()+interval '1 hour'),
         ('other-otp',$5,'111111',now()+interval '1 hour'),
         ('other-reset','reset-password:tok-b','some-other-user',now()+interval '1 hour')`,
      [s.p.userId, email, `sign-in-otp-${email}`, neighbour, `sign-in-otp-${neighbour}`]
    );
    // During the window: a pending community cannot be claimed by this account.
    const pending = await createPendingCommunity(h, host.cookie, 'Claim target');
    const claimCookie = `${s.p.cookie}; ${await preflightOwnerClaim(h, pending.token)}`;
    expect(
      (await h.call('/api/v1/owner-claims/claim', { cookie: claimCookie, body: {} })).status
    ).toBe(409);
    // A membership gained during the window is erased with the rest.
    const joined = await admit(h, other.communityId, other.owner.cookie, { cookie: s.p.cookie });
    // A second invitation, bound now, redeemed while the erasure runs.
    const third = await scene('elsewhere');
    const inviteCookie = await bindInvite(third.base, third.owner.cookie, s.p.cookie);

    // A provider-only account (GitHub, stubbed at the session layer every sign-in reaches).
    const githubUser = `gh-${randomUUID()}`;
    await h.pool.query(
      `INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,'Git Hubber',$2,true)`,
      [githubUser, `${githubUser}@x.test`]
    );
    await h.pool.query(
      `INSERT INTO account(id,"accountId","providerId","userId") VALUES($1,'12345','github',$2)`,
      [randomUUID(), githubUser]
    );
    await h.pool.query(
      `INSERT INTO erasure_requests(kind,user_id,state,execute_after,started_at,next_attempt_at)
       VALUES('account',$1,'running',now(),now(),now()+interval '1 hour')`,
      [githubUser]
    );
    const auth = createCommunityAuth(h.pool, h.config);
    const context = await auth.$context;
    await expect(context.internalAdapter.createSession(githubUser)).rejects.toThrow();

    const observed: Record<string, number> = {};
    const hooks: ErasureHooks = {
      afterStep: async (step) => {
        if (step !== 'end-access' || observed.signIn) return;
        observed.session = (await h.call('/api/v1/memberships', { cookie: s.p.cookie })).status;
        observed.signIn = (
          await h.call('/api/auth/sign-in/email', { body: { email, password: PASSWORD } })
        ).status;
        observed.redeem = (
          await h.call(`${third.base}/invites/redeem`, { cookie: inviteCookie, body: {} })
        ).status;
        observed.claim = (
          await h.call('/api/v1/owner-claims/claim', { cookie: claimCookie, body: {} })
        ).status;
      },
    };
    await runErasures(h.pool, hoursFromNow(73), { hooks });
    expect(observed).toEqual({ session: 401, signIn: 403, redeem: 401, claim: 401 });
    // Signed out everywhere: with no session, redemption and claim cannot even start. The
    // guards themselves refuse a live session too, which the direct checks below prove.
    const husks = await h.pool.query('SELECT erased_at FROM members WHERE id=ANY($1::uuid[])', [
      [s.p.memberId, joined.memberId],
    ]);
    expect(husks.rows.every((row) => row.erased_at !== null)).toBe(true);
    expect((await h.pool.query('SELECT 1 FROM "user" WHERE id=$1', [s.p.userId])).rowCount).toBe(0);
    const left = await h.pool.query<{ id: string }>(
      "SELECT id FROM verification WHERE id LIKE 'mine-%' OR id LIKE 'other-%' ORDER BY id"
    );
    expect(left.rows.map((row) => row.id)).toEqual(['other-email', 'other-otp', 'other-reset']);
  });

  it('refuses redemption and owner claim for a live session while its account erasure runs', async () => {
    const s = await scene('liveguard');
    const pending = await createPendingCommunity(h, host.cookie, 'Live claim target');
    const claimCookie = `${s.q.cookie}; ${await preflightOwnerClaim(h, pending.token)}`;
    const other = await scene('liveguard-other');
    const inviteCookie = await bindInvite(other.base, other.owner.cookie, s.q.cookie);
    // Mark Q's account erasure running without the claim step that signs Q out, so the
    // guards, not a missing session, are what refuse.
    await h.pool.query(
      `INSERT INTO erasure_requests(kind,user_id,state,execute_after,started_at,next_attempt_at)
       VALUES('account',$1,'running',now(),now(),now()+interval '1 hour')`,
      [s.q.userId]
    );
    const redeem = await h.call(`${other.base}/invites/redeem`, { cookie: inviteCookie, body: {} });
    expect(redeem.status).toBe(409);
    expect((await redeem.json()).message).toBe(
      'This account is being erased here. Try again later.'
    );
    expect(
      (await h.call('/api/v1/owner-claims/claim', { cookie: claimCookie, body: {} })).status
    ).toBe(409);
    // Control: once the request ends, the same calls go through.
    await h.pool.query(
      `UPDATE erasure_requests SET state='completed',completed_at=now() WHERE user_id=$1`,
      [s.q.userId]
    );
    expect(
      (await h.call(`${other.base}/invites/redeem`, { cookie: inviteCookie, body: {} })).status
    ).toBe(200);
  });
});

describe('every lifecycle (AC-9)', () => {
  async function lifecycleVersion(communityId: string): Promise<number> {
    return (
      await h.pool.query('SELECT lifecycle_version FROM communities WHERE id=$1', [communityId])
    ).rows[0].lifecycle_version;
  }
  async function archive(s: Scene) {
    await body(
      await h.call(`${s.base}/owner/lifecycle`, {
        cookie: s.owner.cookie,
        body: {
          action: 'archive',
          lifecycleVersion: await lifecycleVersion(s.communityId),
          password: PASSWORD,
          confirmName: (
            await h.pool.query('SELECT name FROM communities WHERE id=$1', [s.communityId])
          ).rows[0].name,
        },
      }),
      200,
      'archive'
    );
  }
  async function suspend(s: Scene) {
    await body(
      await h.call(`/api/v1/host/communities/${s.communityId}/lifecycle`, {
        method: 'PATCH',
        cookie: host.cookie,
        body: { action: 'suspend', lifecycleVersion: await lifecycleVersion(s.communityId) },
      }),
      200,
      'suspend'
    );
  }
  async function requestDeletion(s: Scene) {
    const name = (await h.pool.query('SELECT name FROM communities WHERE id=$1', [s.communityId]))
      .rows[0].name;
    return h.call(`${s.base}/owner/deletion`, {
      cookie: s.owner.cookie,
      body: {
        lifecycleVersion: await lifecycleVersion(s.communityId),
        password: PASSWORD,
        confirmName: name,
        confirmIdSuffix: s.communityId.slice(-8),
      },
    });
  }

  it('completes an erasure whatever state the community is in when it runs', async () => {
    for (const [label, transition] of [
      ['archived', archive],
      ['suspended', suspend],
      ['deletion', async (s: Scene) => void (await body(await requestDeletion(s), 200, 'delete'))],
    ] as const) {
      const s = await scene(label);
      await requestErasure(s.p.cookie, s.communityId);
      await transition(s);
      await runErasures(h.pool, hoursFromNow(73));
      const husk = await h.pool.query('SELECT erased_at,display_name FROM members WHERE id=$1', [
        s.p.memberId,
      ]);
      expect(husk.rows[0].display_name, label).toBe('Erased member');
      const texts = await h.pool.query(
        'SELECT DISTINCT text FROM entries WHERE author_member_id=$1',
        [s.p.memberId]
      );
      expect(texts.rows, label).toEqual([{ text: 'This message was erased.' }]);
    }
  });

  it('lets the owner delete a suspended community, and a cancel restores the suspension', async () => {
    const s = await scene('suspendeddelete');
    await archive(s);
    await suspend(s);
    // The carve-out is narrow: other owner routes stay closed while suspended.
    expect((await h.call(`${s.base}/settings`, { cookie: s.owner.cookie })).status).toBe(503);
    const requested = await body<{ lifecycle: string; lifecycleVersion: number }>(
      await requestDeletion(s),
      200,
      'delete suspended'
    );
    expect(requested.lifecycle).toBe('deletion_pending');
    expect(
      (
        await h.pool.query(
          'SELECT deletion_from_state,deletion_from_prior_state,suspended_from_state FROM communities WHERE id=$1',
          [s.communityId]
        )
      ).rows[0]
    ).toEqual({
      deletion_from_state: 'suspended',
      deletion_from_prior_state: 'archived',
      suspended_from_state: null,
    });
    const cancelled = await body<{ lifecycle: string }>(
      await h.call(`${s.base}/owner/deletion/cancel`, {
        cookie: s.owner.cookie,
        body: { lifecycleVersion: requested.lifecycleVersion, password: PASSWORD },
      }),
      200,
      'cancel deletion'
    );
    expect(cancelled.lifecycle).toBe('suspended');
    expect(
      (
        await h.pool.query(
          `SELECT lifecycle,suspended_from_state,suspended_at IS NOT NULL AS suspended,
                  deletion_from_state,deletion_from_prior_state,delete_after
           FROM communities WHERE id=$1`,
          [s.communityId]
        )
      ).rows[0]
    ).toEqual({
      lifecycle: 'suspended',
      suspended_from_state: 'archived',
      suspended: true,
      deletion_from_state: null,
      deletion_from_prior_state: null,
      delete_after: null,
    });
    // The host can still resume it to where the suspension began.
    await body(
      await h.call(`/api/v1/host/communities/${s.communityId}/lifecycle`, {
        method: 'PATCH',
        cookie: host.cookie,
        body: { action: 'resume', lifecycleVersion: await lifecycleVersion(s.communityId) },
      }),
      200,
      'resume'
    );
    expect(
      (await h.pool.query('SELECT lifecycle FROM communities WHERE id=$1', [s.communityId])).rows[0]
        .lifecycle
    ).toBe('archived');
  });
});
