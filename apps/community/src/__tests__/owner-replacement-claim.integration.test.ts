/**
 * The named account takes ownership (specs/community-owner-replacement, task 2.4: AC-6, AC-7
 * claim half, AC-8, AC-12, AC-17 claim half, AC-22, the claim audit of AC-13, and AC-11 and
 * AC-14 for these routes). Real PostgreSQL through the tenancy harness, and single sign-on
 * through the in-process fake issuer; no test reaches a real provider or sends mail.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommunityWireOwnerReplacementClaimResponseSchema,
  CommunityWireOwnerReplacementPreflightResponseSchema,
} from '@dorkos/shared/community-wire';
import { formatReplacementDate } from '../owner-replacement/dates.js';
import { startFakeIssuer, type FakeIssuer } from './fake-oidc-issuer.js';
import { requestOwnerExport, runExport } from './export-jobs-fixture.js';
import {
  COMPOSERS,
  DAY,
  MINUTE,
  TestClock,
  claim,
  cookies,
  identity,
  member,
  moveLifecycle,
  objectToken,
  oidcEnv,
  oidcSignIn,
  ownedCommunity,
  passwordSignUp,
  preflightClaim,
  replacementRow,
  requestReplacement,
  startReplacementHost,
  tick,
  toClaimable,
  toWaiting,
  unique,
  type Owned,
  type ReplacementHost,
} from './owner-replacement-fixture.js';
import {
  TENANCY_PASSWORD,
  admit,
  expectStatus,
  holdingLock,
  pairInstall,
  waitForLockWaiters,
} from './tenancy-test-harness.js';

const clock = new TestClock();
/** No single sign-on. */
let plain: ReplacementHost;
/** The same host as `plain`, restarted with single sign-on turned on. */
let plainNowSso: ReplacementHost;
/** Single sign-on through `issuer`. */
let sso: ReplacementHost;
/** The same host as `sso`, restarted to use another issuer. */
let ssoMoved: ReplacementHost;
/** A host whose owner-replacement links allow very few attempts a minute. */
let limited: ReplacementHost;
let issuer: FakeIssuer;
let otherIssuer: FakeIssuer;

beforeAll(async () => {
  issuer = await startFakeIssuer();
  otherIssuer = await startFakeIssuer();
  plain = await startReplacementHost('claim_plain', clock);
  plainNowSso = await startReplacementHost('claim_plain_sso', clock, {
    env: oidcEnv(issuer),
    sharesDatabaseOf: plain,
  });
  sso = await startReplacementHost('claim_sso', clock, { env: oidcEnv(issuer) });
  ssoMoved = await startReplacementHost('claim_sso_moved', clock, {
    env: oidcEnv(otherIssuer),
    sharesDatabaseOf: sso,
  });
  limited = await startReplacementHost('claim_limited', clock, {
    env: { COMMUNITY_BOOTSTRAP_ATTEMPTS_PER_MINUTE: 4 },
  });
}, 120_000);

afterAll(async () => {
  await plainNowSso?.h.close();
  await ssoMoved?.h.close();
  await plain?.h.close();
  await sso?.h.close();
  await limited?.h.close();
  await issuer?.close();
  await otherIssuer?.close();
});

/**
 * Everything a claim could change in a community, except the two member rows it swaps: every
 * other member, the rows' handles, grants, agents and their credentials, invitations, channels,
 * channel seats, entries, and the lifecycle.
 */
async function snapshot(host: ReplacementHost, communityId: string, except: string[] = []) {
  const { rows } = await host.h.pool.query(
    `SELECT
       (SELECT json_agg(m ORDER BY m.id) FROM (
          SELECT id,user_id,display_name,handle,role,active FROM members
          WHERE community_id=$1 AND NOT (id=ANY($2::uuid[]))) m) AS members,
       (SELECT json_agg(g ORDER BY g.id) FROM (
          SELECT id,member_id,revoked_at,scopes FROM connection_grants WHERE community_id=$1) g)
         AS grants,
       (SELECT json_agg(a ORDER BY a.id) FROM (
          SELECT id,owner_member_id,enrolled_by_grant_id,active,revoked_at FROM agents
          WHERE community_id=$1) a)
         AS agents,
       (SELECT json_agg(k ORDER BY k.id) FROM (
          SELECT id,revoked_at FROM agent_credentials WHERE community_id=$1) k) AS credentials,
       (SELECT json_agg(i ORDER BY i.id) FROM (
          SELECT id,revoked_at,use_count FROM invites WHERE community_id=$1) i) AS invites,
       (SELECT json_agg(ch ORDER BY ch.id) FROM (
          SELECT id,name,archived FROM channels WHERE community_id=$1) ch) AS channels,
       (SELECT count(*)::int FROM channel_members WHERE community_id=$1) AS seats,
       (SELECT count(*)::int FROM entries WHERE community_id=$1) AS entries,
       (SELECT lifecycle FROM communities WHERE id=$1) AS lifecycle`,
    [communityId, except]
  );
  return rows[0];
}

/** Everything a refused claim must leave alone, the two swapped rows included. */
async function everything(host: ReplacementHost, c: Owned, id: string) {
  return {
    community: await snapshot(host, c.communityId),
    replacement: await replacementRow(host, id),
    version: (
      await host.h.pool.query('SELECT lifecycle_version FROM communities WHERE id=$1', [
        c.communityId,
      ])
    ).rows[0],
    audits: (
      await host.h.pool.query(
        `SELECT (SELECT count(*)::int FROM audit_events WHERE community_id=$1) AS tenant,
           (SELECT count(*)::int FROM host_audit_events WHERE community_id=$1) AS host`,
        [c.communityId]
      )
    ).rows[0],
    users: (await host.h.pool.query('SELECT count(*)::int AS n FROM "user"')).rows[0].n,
  };
}

/** Whether a response deleted the claim cookie. */
function droppedCookie(response: Response): boolean {
  return response.headers
    .getSetCookie()
    .some((value) => value.startsWith('community_owner_replacement=;') && /Max-Age=0/i.test(value));
}

/** A claimable request with a signed-in claimant account holding its claim cookie. */
async function claimableWithClaimant(host: ReplacementHost = plain) {
  const c = await ownedCommunity(host);
  const { replacementId, claimToken } = await requestReplacement(host, c);
  await toClaimable(host, replacementId);
  const { cookie: claimCookie } = await preflightClaim(host, claimToken);
  // A person with no account signs up with the claim cookie (OIDC off: any account may claim).
  const claimant = await passwordSignUp(host, claimCookie);
  await expectStatus(claimant.response, 200, 'claimant sign-up');
  return { c, replacementId, claimToken, cookie: claimant.cookie };
}

describe('claim preflight', () => {
  it('trades a live claim token for a 30-minute cookie and names only the community', async () => {
    // Purpose: fails if the preflight leaks more than the community's name and dates, sets a
    // cookie a script can read or that outlives 30 minutes, or lets a cache keep the answer.
    const c = await ownedCommunity(plain);
    const { claimToken } = await requestReplacement(plain, c);
    const { response } = await preflightClaim(plain, claimToken);
    await expectStatus(response, 200, 'preflight');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = CommunityWireOwnerReplacementPreflightResponseSchema.parse(await response.json());
    expect(body).toEqual({
      communityId: c.communityId,
      communityName: c.name,
      state: 'notifying',
      claimableAfter: null,
      claimExpiresAt: null,
      requiresSingleSignOn: false,
    });
    const [set] = response.headers.getSetCookie();
    expect(set).toMatch(/^community_owner_replacement=[^;]+/u);
    expect(set).toMatch(/Max-Age=1800/u);
    expect(set).toMatch(/HttpOnly/u);
    expect(set).toMatch(/SameSite=Lax/u);
  });

  it('says a single sign-on host needs the named account', async () => {
    // Purpose: fails if the claim page cannot tell the person to use the host's sign-in service.
    const c = await ownedCommunity(sso);
    const { claimToken } = await requestReplacement(sso, c, {
      claimant: { oidcSubject: `named-${unique()}` },
    });
    const { response } = await preflightClaim(sso, claimToken);
    expect((await response.json()).requiresSingleSignOn).toBe(true);
  });

  it('answers one identical 403 for every token that no longer works', async () => {
    // Purpose: fails if an unknown, replaced, cancelled, expired, completed, or object-only
    // token can be told apart, which would let someone probe for live requests.
    const answers: { name: string; status: number; body: string; cookie: string[] }[] = [];
    const ask = async (name: string, token: string) => {
      const response = await plain.h.call('/api/v1/owner-replacements/preflight', {
        body: { token },
      });
      answers.push({
        name,
        status: response.status,
        body: await response.text(),
        cookie: response.headers.getSetCookie(),
      });
    };
    await ask('unknown', randomBytes(32).toString('base64url'));

    const reissued = await ownedCommunity(plain);
    const first = await requestReplacement(plain, reissued);
    await expectStatus(
      await plain.h.call(
        `/api/v1/host/communities/${reissued.communityId}/owner-replacements/${first.replacementId}/claim-token`,
        { bearer: plain.ownershipKey, body: {} }
      ),
      200,
      'reissue'
    );
    await ask('replaced by a new link', first.claimToken);

    const cancelled = await ownedCommunity(plain);
    const withdrawn = await requestReplacement(plain, cancelled);
    await expectStatus(
      await plain.h.call(
        `/api/v1/host/communities/${cancelled.communityId}/owner-replacements/${withdrawn.replacementId}/cancel`,
        { bearer: plain.ownershipKey, body: {} }
      ),
      200,
      'cancel'
    );
    await ask('cancelled', withdrawn.claimToken);
    await ask('object-only link', await objectToken(plain, reissued, first.replacementId));

    const lapsing = await ownedCommunity(plain);
    const lapsed = await requestReplacement(plain, lapsing);
    await toClaimable(plain, lapsed.replacementId);
    clock.advance(14 * DAY);
    await ask('claim window over, before the timeline ran', lapsed.claimToken);
    await tick(plain);
    expect((await replacementRow(plain, lapsed.replacementId)).state).toBe('expired');
    await ask('expired', lapsed.claimToken);

    const done = await claimableWithClaimant();
    await expectStatus(await claim(plain, done.cookie), 200, 'claim');
    await ask('completed', done.claimToken);

    expect(answers).toHaveLength(7);
    for (const answer of answers)
      expect(answer, answer.name).toEqual({
        name: answer.name,
        status: 403,
        body: JSON.stringify({
          code: 'FORBIDDEN',
          message: 'This ownership claim is unavailable.',
        }),
        cookie: [],
      });
  });

  it('never answers a GET, so opening a link changes nothing', async () => {
    // Purpose: fails if a link scanner's GET can set the cookie or move anything.
    const c = await ownedCommunity(plain);
    const { replacementId, claimToken } = await requestReplacement(plain, c);
    const before = await replacementRow(plain, replacementId);
    for (const path of [
      '/api/v1/owner-replacements/preflight',
      '/api/v1/owner-replacements/claim',
    ]) {
      const response = await plain.h.call(`${path}?token=${claimToken}`);
      expect(response.status, path).toBe(404);
      expect(response.headers.getSetCookie(), path).toEqual([]);
    }
    expect(await replacementRow(plain, replacementId)).toEqual(before);
  });
});

describe('no early claim (AC-6)', () => {
  it('refuses while notifying and waiting, with the date, and succeeds a minute after it', async () => {
    // Purpose: fails if a claim lands before the owner's wait is over, if the refusal changes
    // anything or drops the cookie, or if the claim still fails once the wait has run out.
    const c = await ownedCommunity(plain);
    const { replacementId, claimToken } = await requestReplacement(plain, c);
    const { cookie: claimCookie } = await preflightClaim(plain, claimToken);
    // Signing up needs a claimable request; this claimant is an existing member instead.
    const claimant = await member(plain, c);
    const session = cookies(claimant.cookie, claimCookie);

    const before = await everything(plain, c, replacementId);
    const notifying = await claim(plain, session);
    expect(notifying.status).toBe(409);
    expect(await notifying.json()).toEqual({
      code: 'STATE_CONFLICT',
      message:
        "You can't take ownership yet. The waiting period starts once the owner has been told.",
    });
    expect(droppedCookie(notifying)).toBe(false);
    expect(await everything(plain, c, replacementId)).toEqual(before);

    const claimableAfter = await toWaiting(plain, replacementId);
    const waitingBefore = await everything(plain, c, replacementId);
    const waiting = await claim(plain, session);
    expect(waiting.status).toBe(409);
    expect(await waiting.json()).toEqual({
      code: 'STATE_CONFLICT',
      message: `You can take ownership after ${formatReplacementDate(claimableAfter)}.`,
    });
    expect(droppedCookie(waiting)).toBe(false);
    expect(await everything(plain, c, replacementId)).toEqual(waitingBefore);

    clock.ms = Math.max(clock.ms, claimableAfter.getTime() + MINUTE);
    await tick(plain);
    const claimed = await claim(plain, session);
    await expectStatus(claimed, 200, 'claim after the wait');
    expect(droppedCookie(claimed)).toBe(true);
    expect(claimed.headers.get('cache-control')).toBe('no-store');
    expect(CommunityWireOwnerReplacementClaimResponseSchema.parse(await claimed.json())).toEqual({
      community: { id: c.communityId, name: c.name },
      memberId: claimant.memberId,
    });
  });
});

describe('completion equals a transfer (AC-8)', () => {
  it.each(['active', 'archived', 'held'] as const)(
    'swaps only the two roles, in an %s community, and leaves everything else as it was',
    async (lifecycle) => {
      // Purpose: fails if the claim touches any other member, grant, agent (or which installation
      // enrolled it), invitation, channel, or entry, moves the lifecycle, forgets to bump its version, leaves two owners or none,
      // or takes away the old owner's membership, handle, connection, or agent.
      const c = await ownedCommunity(plain);
      const channel = await plain.h.call(`${c.base}/channels`, {
        cookie: c.owner.cookie,
        body: { name: `general-${unique()}`, visibility: 'public' },
      });
      await expectStatus(channel, 201, 'channel');
      const claimant = await member(plain, c);
      const bystander = await member(plain, c);
      const ownerGrant = await pairInstall(plain.h, c.communityId, c.owner.cookie);
      await pairInstall(plain.h, c.communityId, bystander.cookie);
      const enrolled = await plain.h.call(`${c.base}/agents`, {
        bearer: ownerGrant,
        body: { localAgentId: `agent-${unique()}`, displayName: 'Owner Agent' },
      });
      await expectStatus(enrolled, 201, 'enroll the owner agent');
      await expectStatus(
        await plain.h.call(`${c.base}/invites`, { cookie: c.owner.cookie, body: { seats: 3 } }),
        201,
        'invite'
      );
      const oldOwnerRow = (
        await plain.h.pool.query('SELECT handle,display_name,user_id FROM members WHERE id=$1', [
          c.owner.memberId,
        ])
      ).rows[0];
      if (lifecycle !== 'active') await moveLifecycle(plain, c, lifecycle);

      const { replacementId, claimToken } = await requestReplacement(plain, c);
      await toClaimable(plain, replacementId);
      const { cookie: claimCookie } = await preflightClaim(plain, claimToken);
      const before = await snapshot(plain, c.communityId, [c.owner.memberId, claimant.memberId]);
      const version = (
        await plain.h.pool.query('SELECT lifecycle_version FROM communities WHERE id=$1', [
          c.communityId,
        ])
      ).rows[0].lifecycle_version;

      const claimed = await claim(plain, cookies(claimant.cookie, claimCookie));
      await expectStatus(claimed, 200, 'claim');
      expect((await claimed.json()).memberId).toBe(claimant.memberId);

      expect(await snapshot(plain, c.communityId, [c.owner.memberId, claimant.memberId])).toEqual(
        before
      );
      const owners = await plain.h.pool.query(
        "SELECT id FROM members WHERE community_id=$1 AND role='owner' AND active",
        [c.communityId]
      );
      expect(owners.rows).toEqual([{ id: claimant.memberId }]);
      expect(
        (
          await plain.h.pool.query(
            'SELECT role,active,handle,display_name,user_id FROM members WHERE id=$1',
            [c.owner.memberId]
          )
        ).rows[0]
      ).toEqual({ role: 'member', active: true, ...oldOwnerRow });
      const community = (
        await plain.h.pool.query(
          'SELECT lifecycle,lifecycle_version FROM communities WHERE id=$1',
          [c.communityId]
        )
      ).rows[0];
      expect(community).toEqual({ lifecycle, lifecycle_version: version + 1 });
      // The old owner's connection still reads as a member; their session does too. (Archiving
      // revoked every connection that could post, before the claim; the snapshot shows the claim
      // changed none.)
      if (lifecycle !== 'archived') {
        const read = await plain.h.call(`${c.base}/owner-replacement`, { bearer: ownerGrant });
        await expectStatus(read, 200, 'old owner connection');
      }
      const me = await plain.h.call(`${c.base}/me`, { cookie: c.owner.cookie });
      expect((await me.json()).member.role).toBe('member');
      // Their agent is still theirs to remove, as after a transfer. It stays with the installation
      // that enrolled it: the new owner's own installation cannot reach it, since a connection
      // never moderates.
      if (lifecycle === 'active') {
        const agentId = (await enrolled.json()).agent.memberId as string;
        const claimantGrant = await pairInstall(plain.h, c.communityId, claimant.cookie);
        expect(
          (
            await plain.h.call(`${c.base}/agents/${agentId}`, {
              method: 'DELETE',
              bearer: claimantGrant,
            })
          ).status
        ).toBe(404);
        expect(
          (
            await plain.h.call(`${c.base}/agents/${agentId}`, {
              method: 'DELETE',
              bearer: ownerGrant,
            })
          ).status
        ).toBe(204);
      }
    }
  );

  it('gives a claimant with no membership a new one, with a handle of its own', async () => {
    // Purpose: fails if a new owner row reuses an existing handle or skips its handle record.
    const c = await ownedCommunity(plain);
    const name = `Sam Lee ${unique().split('-')[0]}`;
    const namesake = await member(plain, c, name);
    const { replacementId, claimToken } = await requestReplacement(plain, c);
    await toClaimable(plain, replacementId);
    const { cookie: claimCookie } = await preflightClaim(plain, claimToken);
    const claimant = await passwordSignUp(plain, claimCookie, name);
    await expectStatus(claimant.response, 200, 'sign-up');
    const claimed = await claim(plain, claimant.cookie);
    await expectStatus(claimed, 200, 'claim');
    const { memberId } = await claimed.json();
    expect(memberId).not.toBe(namesake.memberId);
    const rows = await plain.h.pool.query<{ id: string; handle: string; role: string }>(
      'SELECT id,handle,role FROM members WHERE id=ANY($1::uuid[]) ORDER BY role',
      [[memberId, namesake.memberId]]
    );
    expect(new Set(rows.rows.map((row) => row.handle)).size).toBe(2);
    expect(rows.rows.find((row) => row.id === memberId)?.role).toBe('owner');
    const handle = await plain.h.pool.query(
      'SELECT 1 FROM community_handles WHERE community_id=$1 AND member_id=$2',
      [c.communityId, memberId]
    );
    expect(handle.rowCount).toBe(1);
  });

  it('brings back a former member as owner in the same row, with none of their old access', async () => {
    // Purpose: fails if a removed member gets a second row, or an old grant comes back with them.
    const c = await ownedCommunity(plain);
    const former = await member(plain, c);
    const grant = await pairInstall(plain.h, c.communityId, former.cookie);
    await expectStatus(
      await plain.h.call(`${c.base}/members/${former.memberId}`, {
        method: 'DELETE',
        cookie: c.owner.cookie,
      }),
      204,
      'remove'
    );
    // Removal already revoked that grant, so a claim that forgot to clear the old membership
    // would pass unseen. Leave one live on the inactive row, as a row from before removal
    // revoked grants would be, so only the claim's own clearing can revoke it.
    const planted = await plain.h.pool.query(
      'UPDATE connection_grants SET revoked_at=NULL WHERE member_id=$1 AND community_id=$2',
      [former.memberId, c.communityId]
    );
    expect(planted.rowCount).toBe(1);
    const { replacementId, claimToken } = await requestReplacement(plain, c);
    await toClaimable(plain, replacementId);
    const { cookie: claimCookie } = await preflightClaim(plain, claimToken);
    const claimed = await claim(plain, cookies(former.cookie, claimCookie));
    await expectStatus(claimed, 200, 'claim');
    expect((await claimed.json()).memberId).toBe(former.memberId);
    expect(
      (await plain.h.pool.query('SELECT role,active FROM members WHERE id=$1', [former.memberId]))
        .rows[0]
    ).toEqual({ role: 'owner', active: true });
    expect((await plain.h.call(`${c.base}/channels`, { bearer: grant })).status).toBe(401);
  });

  it("cancels the old owner's unfinished community export and refuses their ready one", async () => {
    // Purpose: fails if the former owner can still receive a whole-community export.
    const ready = await ownedCommunity(plain);
    const readyExport = await requestOwnerExport(plain.h, { ...ready, channelId: '' });
    expect(await runExport(plain.h)).toBe(readyExport.export.id);
    const pending = await ownedCommunity(plain);
    const queued = await requestOwnerExport(plain.h, { ...pending, channelId: '' });
    expect(queued.export.state).toBe('queued');

    for (const c of [ready, pending]) {
      const claimant = await member(plain, c);
      const { replacementId, claimToken } = await requestReplacement(plain, c);
      await toClaimable(plain, replacementId);
      const { cookie: claimCookie } = await preflightClaim(plain, claimToken);
      await expectStatus(await claim(plain, cookies(claimant.cookie, claimCookie)), 200, 'claim');
    }
    const download = await plain.h.call(`${ready.base}/exports/${readyExport.export.id}/archive`, {
      cookie: ready.owner.cookie,
    });
    expect(download.status).toBe(403);
    expect(
      (
        await plain.h.pool.query('SELECT state FROM export_archives WHERE id=$1', [
          queued.export.id,
        ])
      ).rows[0].state
    ).toBe('cancelled');
  });

  it('ends the request completed, writes one row on each audit trail, and tells the old owner', async () => {
    // Purpose: fails if completion leaves a live claim token or named account behind, writes
    // the wrong audit rows or actors, names a member on the host trail, or forgets the email.
    const done = await claimableWithClaimant();
    const claimed = await claim(plain, done.cookie);
    await expectStatus(claimed, 200, 'claim');
    const { memberId } = await claimed.json();
    const row = await replacementRow(plain, done.replacementId);
    expect(row).toMatchObject({
      state: 'completed',
      new_owner_member_id: memberId,
      claim_token_hash: null,
      claimant_oidc_issuer: null,
      claimant_oidc_subject: null,
      ended_at: clock.now(),
    });
    const host = await plain.h.pool.query(
      `SELECT * FROM host_audit_events WHERE community_id=$1 AND action LIKE 'owner_replacement.%'
       ORDER BY created_at,id`,
      [done.c.communityId]
    );
    expect(host.rows.map((audit) => [audit.action, audit.actor_kind])).toEqual([
      ['owner_replacement.request', 'api_key'],
      ['owner_replacement.complete', 'system'],
    ]);
    const hostText = JSON.stringify(host.rows);
    for (const secret of [memberId, done.c.owner.memberId, done.c.ownerUserId, 'CASE-2541'])
      expect(hostText).not.toContain(secret);
    const tenant = await plain.h.pool.query(
      `SELECT actor_kind,actor_member_id,subject_id,prior_state,next_state,changed_fields
       FROM audit_events WHERE community_id=$1 AND action='owner.replace'`,
      [done.c.communityId]
    );
    expect(tenant.rows).toEqual([
      {
        actor_kind: 'host',
        actor_member_id: null,
        subject_id: memberId,
        prior_state: done.c.owner.memberId,
        next_state: memberId,
        changed_fields: ['owner_member_id'],
      },
    ]);
    const outbox = await plain.h.pool.query(
      `SELECT kind,recipient_user_id FROM notice_outbox WHERE subject_id=$1
       AND kind='owner_replacement.completed'`,
      [done.replacementId]
    );
    expect(outbox.rows).toEqual([
      { kind: 'owner_replacement.completed', recipient_user_id: done.c.ownerUserId },
    ]);
    const displayName = (
      await plain.h.pool.query('SELECT display_name FROM members WHERE id=$1', [memberId])
    ).rows[0].display_name;
    const mail = await COMPOSERS['owner_replacement.completed']!({
      pool: plain.h.pool,
      notice: {
        id: 'unused',
        communityId: done.c.communityId,
        kind: 'owner_replacement.completed',
        subjectId: done.replacementId,
        recipientUserId: done.c.ownerUserId,
      } as never,
      now: clock.now(),
    });
    expect(JSON.stringify(mail)).toContain(`${displayName} is now the owner of ${done.c.name}`);
  });
});

describe('refused claims change nothing and keep the cookie', () => {
  it('refuses the current owner', async () => {
    // Purpose: fails if the owner can "claim" their own community and churn its audit trail.
    const c = await ownedCommunity(plain);
    const { replacementId, claimToken } = await requestReplacement(plain, c);
    await toClaimable(plain, replacementId);
    const { cookie: claimCookie } = await preflightClaim(plain, claimToken);
    const before = await everything(plain, c, replacementId);
    const refused = await claim(plain, cookies(c.owner.cookie, claimCookie));
    expect(refused.status).toBe(409);
    expect((await refused.json()).message).toBe('You already own this community.');
    expect(droppedCookie(refused)).toBe(false);
    expect(await everything(plain, c, replacementId)).toEqual(before);
  });

  it('refuses an account being deleted and a member who is leaving', async () => {
    // Purpose: fails if ownership can move to someone the erasure is about to remove.
    for (const kind of ['account', 'membership'] as const) {
      const c = await ownedCommunity(plain);
      const name = `Leaving ${unique()}`;
      const email = `${name.toLowerCase().replaceAll(' ', '-')}@member.test`;
      const leaving = await admit(plain.h, c.communityId, c.owner.cookie, { name, email });
      const { replacementId, claimToken } = await requestReplacement(plain, c);
      await toClaimable(plain, replacementId);
      await expectStatus(
        await plain.h.call('/api/v1/account/erasures', {
          cookie: leaving.cookie,
          body:
            kind === 'account'
              ? { kind, confirmEmail: email, password: TENANCY_PASSWORD }
              : { kind, communityId: c.communityId, password: TENANCY_PASSWORD },
        }),
        201,
        `${kind} erasure`
      );
      const { cookie: claimCookie } = await preflightClaim(plain, claimToken);
      const before = await everything(plain, c, replacementId);
      const refused = await claim(plain, cookies(leaving.cookie, claimCookie));
      expect(refused.status, kind).toBe(409);
      expect((await refused.json()).message, kind).toBe(
        kind === 'account'
          ? "This account is being deleted, so it can't take ownership."
          : "You are leaving this community, so you can't take ownership."
      );
      expect(droppedCookie(refused)).toBe(false);
      expect(await everything(plain, c, replacementId)).toEqual(before);
    }
  });

  it('asks a person with no session to sign in, and keeps the cookie', async () => {
    // Purpose: fails if a missing session spends or drops the claim.
    const c = await ownedCommunity(plain);
    const { replacementId, claimToken } = await requestReplacement(plain, c);
    await toClaimable(plain, replacementId);
    const { cookie: claimCookie } = await preflightClaim(plain, claimToken);
    const refused = await claim(plain, claimCookie);
    expect(refused.status).toBe(401);
    expect(droppedCookie(refused)).toBe(false);
    expect((await replacementRow(plain, replacementId)).state).toBe('claimable');
  });

  it('refuses a forged or missing cookie with the unavailable answer and drops it', async () => {
    // Purpose: fails if an unsigned cookie holding a real token can claim.
    const done = await claimableWithClaimant();
    const session = done.cookie
      .split('; ')
      .filter((part) => !part.startsWith('community_owner_replacement='))
      .join('; ');
    for (const cookie of [
      session,
      `${session}; community_owner_replacement=${done.claimToken}.x`,
    ]) {
      const refused = await claim(plain, cookie);
      expect(refused.status).toBe(403);
      expect((await refused.json()).message).toBe('This ownership claim is unavailable.');
    }
    expect((await replacementRow(plain, done.replacementId)).state).toBe('claimable');
  });

  it('refuses a claim once its window has closed, even before the timeline marks it expired', async () => {
    // Purpose: fails if a claim lands after its 14 days because the worker has not run yet.
    const done = await claimableWithClaimant();
    const window = (await replacementRow(plain, done.replacementId)).claim_expires_at as Date;
    clock.ms = Math.max(clock.ms, window.getTime());
    const before = await everything(plain, done.c, done.replacementId);
    const refused = await claim(plain, done.cookie);
    expect(refused.status).toBe(403);
    expect((await refused.json()).message).toBe('This ownership claim is unavailable.');
    expect(droppedCookie(refused)).toBe(true);
    expect(await everything(plain, done.c, done.replacementId)).toEqual(before);
  });

  it('refuses a second claim with a spent token and drops the cookie', async () => {
    // Purpose: fails if a claim token can be redeemed twice.
    const done = await claimableWithClaimant();
    await expectStatus(await claim(plain, done.cookie), 200, 'first claim');
    const again = await claim(plain, done.cookie);
    expect(again.status).toBe(403);
    expect(droppedCookie(again)).toBe(true);
  });
});

describe('the named account (AC-7, claim half)', () => {
  async function namedRequest(host: ReplacementHost = sso) {
    const subject = `named-${unique()}`;
    const c = await ownedCommunity(host);
    const { replacementId, claimToken } = await requestReplacement(host, c, {
      claimant: { oidcSubject: subject },
    });
    await toClaimable(host, replacementId);
    const { cookie: claimCookie } = await preflightClaim(host, claimToken);
    return { c, subject, replacementId, claimCookie };
  }

  /** An account made through an invitation into `c`, signed in through the issuer. */
  async function oidcAccount(c: Owned, sub: string) {
    const invite = await sso.h.call(`${c.base}/invites`, {
      cookie: c.owner.cookie,
      body: { seats: 1 },
    });
    const { token } = await invite.json();
    const preflight = await sso.h.call(`${c.base}/invites/preflight`, { body: { token } });
    const admission = preflight.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const signedIn = await oidcSignIn(sso, issuer, identity(sub), admission);
    expect(signedIn.location.pathname).toBe('/signed-in');
    return signedIn.cookie;
  }

  it('refuses an account with no sign-in link, another subject, or a subject two accounts share, and changes nothing', async () => {
    // Purpose: fails if anyone but the one account the host named can take ownership.
    const { c, subject, replacementId, claimCookie } = await namedRequest();
    const password = await member(sso, c);
    const otherSubject = await oidcAccount(c, `other-${unique()}`);
    const named = await oidcAccount(c, subject);
    const cases: [string, string, () => Promise<void>][] = [
      ['a password account', password.cookie, async () => undefined],
      ['another subject', otherSubject, async () => undefined],
      [
        'a subject two account rows share',
        named,
        async () => {
          const otherUser = (
            await sso.h.pool.query<{ id: string }>(
              'SELECT id FROM "user" WHERE id<>(SELECT "userId" FROM account WHERE "accountId"=$1) LIMIT 1',
              [subject]
            )
          ).rows[0].id;
          await sso.h.pool.query(
            `INSERT INTO account(id,"accountId","providerId","userId","createdAt","updatedAt")
             VALUES(gen_random_uuid()::text,$1,'oidc',$2,now(),now())`,
            [subject, otherUser]
          );
        },
      ],
    ];
    for (const [name, session, prepare] of cases) {
      await prepare();
      const before = await everything(sso, c, replacementId);
      const refused = await claim(sso, cookies(session, claimCookie));
      expect(refused.status, name).toBe(403);
      expect(await refused.json(), name).toEqual({
        code: 'FORBIDDEN',
        message: 'Sign in with the account named in the request, then try again.',
      });
      expect(droppedCookie(refused), name).toBe(false);
      expect(await everything(sso, c, replacementId), name).toEqual(before);
    }
    await sso.h.pool.query(
      `DELETE FROM account WHERE "providerId"='oidc' AND "accountId"=$1
       AND "userId"<>(SELECT "userId" FROM account WHERE "accountId"=$1 ORDER BY "createdAt" LIMIT 1)`,
      [subject]
    );
    await expectStatus(await claim(sso, cookies(named, claimCookie)), 200, 'the named account');
  });

  it("refuses the named account once the host's sign-in service changed", async () => {
    // Purpose: fails if a subject from one issuer is honoured after the host moved to another.
    const { c, subject, replacementId, claimCookie } = await namedRequest();
    const named = await oidcAccount(c, subject);
    const before = await everything(sso, c, replacementId);
    const refused = await claim(ssoMoved, cookies(named, claimCookie));
    expect(refused.status).toBe(409);
    expect((await refused.json()).message).toBe(
      "This host's sign-in service changed, so this claim can't be used. Ask the host for a new request."
    );
    expect(droppedCookie(refused)).toBe(false);
    expect(await everything(sso, c, replacementId)).toEqual(before);
    await expectStatus(await claim(sso, cookies(named, claimCookie)), 200, 'same issuer');
  });

  it('refuses a request that named nobody once the host turns single sign-on on, and a new one waits again', async () => {
    // Purpose: fails if a link made before single sign-on lets anyone claim afterwards.
    const done = await claimableWithClaimant(plain);
    const before = await everything(plain, done.c, done.replacementId);
    const refused = await claim(plainNowSso, done.cookie);
    expect(refused.status).toBe(409);
    expect((await refused.json()).message).toBe(
      'This host now uses a sign-in service, so the host must ask again.'
    );
    expect(await everything(plain, done.c, done.replacementId)).toEqual(before);

    await expectStatus(
      await plainNowSso.h.call(
        `/api/v1/host/communities/${done.c.communityId}/owner-replacements/${done.replacementId}/cancel`,
        { bearer: plainNowSso.ownershipKey, body: {} }
      ),
      200,
      'cancel'
    );
    const again = await requestReplacement(plainNowSso, done.c, {
      claimant: { oidcSubject: `named-${unique()}` },
    });
    expect(await replacementRow(plainNowSso, again.replacementId)).toMatchObject({
      state: 'notifying',
      claimable_after: null,
    });
  });
});

describe('signing up through the claim (AC-22)', () => {
  it('admits the named person through the issuer, who then takes ownership', async () => {
    // Purpose: fails if a named person with no account cannot get one through the claim.
    const subject = `newcomer-${unique()}`;
    const c = await ownedCommunity(sso);
    const { replacementId, claimToken } = await requestReplacement(sso, c, {
      claimant: { oidcSubject: subject },
    });
    await toClaimable(sso, replacementId);
    const { cookie: claimCookie } = await preflightClaim(sso, claimToken);
    const signedUp = await oidcSignIn(sso, issuer, identity(subject), claimCookie);
    expect(signedUp.location.pathname).toBe('/signed-in');
    const claimed = await claim(sso, signedUp.cookie);
    await expectStatus(claimed, 200, 'claim');
    expect((await replacementRow(sso, replacementId)).state).toBe('completed');
  });

  it('refuses a password sign-up and a different subject, and creates no account', async () => {
    // Purpose: fails if the named claim admits any account but the named identity: the new
    // user row must roll back with the refused account row.
    const subject = `named-${unique()}`;
    const c = await ownedCommunity(sso);
    const { replacementId, claimToken } = await requestReplacement(sso, c, {
      claimant: { oidcSubject: subject },
    });
    await toClaimable(sso, replacementId);
    const { cookie: claimCookie } = await preflightClaim(sso, claimToken);
    const users = async () =>
      (await sso.h.pool.query('SELECT count(*)::int AS n FROM "user"')).rows[0].n;
    const before = await users();
    const password = await passwordSignUp(sso, claimCookie);
    expect(password.response.status).toBe(403);
    const stranger = identity(`stranger-${unique()}`);
    const refused = await oidcSignIn(sso, issuer, stranger, claimCookie);
    expect(refused.location.pathname).toBe('/sign-in-failed');
    expect(refused.location.searchParams.get('error')).toBe('claim_account_mismatch');
    // The host restarted with another sign-in service: even the named subject, through it, is
    // not the identity the request named.
    const moved = await oidcSignIn(ssoMoved, otherIssuer, identity(subject), claimCookie);
    expect(moved.location.pathname).toBe('/sign-in-failed');
    expect(moved.location.searchParams.get('error')).toBe('single_sign_on_required');
    expect(await users()).toBe(before);
    expect((await replacementRow(sso, replacementId)).state).toBe('claimable');
  });

  it('admits nobody with the cookie of a request that is waiting, expired, or kept', async () => {
    // Purpose: fails if a claim cookie creates accounts outside the claim window.
    const refused = async (name: string, cookie: string) =>
      expect((await passwordSignUp(plain, cookie)).response.status, name).toBe(403);
    const waiting = await ownedCommunity(plain);
    const w = await requestReplacement(plain, waiting);
    const waitingCookie = (await preflightClaim(plain, w.claimToken)).cookie;
    await refused('notifying', waitingCookie);
    await toWaiting(plain, w.replacementId);
    await refused('waiting', waitingCookie);

    const kept = await ownedCommunity(plain);
    const k = await requestReplacement(plain, kept);
    await toClaimable(plain, k.replacementId);
    const keptCookie = (await preflightClaim(plain, k.claimToken)).cookie;
    await expectStatus(
      await plain.h.call(`${kept.base}/owner-replacement/objection`, {
        cookie: kept.owner.cookie,
        body: { replacementId: k.replacementId },
      }),
      204,
      'keep'
    );
    await refused('kept', keptCookie);

    const lapsing = await ownedCommunity(plain);
    const l = await requestReplacement(plain, lapsing);
    await toClaimable(plain, l.replacementId);
    const lapsingCookie = (await preflightClaim(plain, l.claimToken)).cookie;
    clock.advance(14 * DAY);
    await refused('window over, not yet marked expired', lapsingCookie);
    await tick(plain);
    await refused('expired', lapsingCookie);
    await refused('no cookie', '');
  });

  it('admits a password sign-up with a live claimable cookie when the host has no single sign-on', async () => {
    // Purpose: fails if a host without single sign-on cannot hand a community to a newcomer.
    const done = await claimableWithClaimant(plain);
    await expectStatus(await claim(plain, done.cookie), 200, 'claim');
  });
});

describe('races', () => {
  it('lets exactly one of two claims with one token complete', async () => {
    // Purpose: fails if two concurrent claims both swap the owner, or deadlock.
    const done = await claimableWithClaimant();
    const [first, second] = await holdingLock(
      plain.h,
      'SELECT 1 FROM communities WHERE id=$1 FOR UPDATE',
      [done.c.communityId],
      async (release) => {
        const claims = [claim(plain, done.cookie), claim(plain, done.cookie)];
        await waitForLockWaiters(plain.h, 2);
        await release();
        return Promise.all(claims);
      }
    );
    expect([first.status, second.status].sort()).toEqual([200, 403]);
    const audits = await plain.h.pool.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE community_id=$1 AND action='owner.replace'",
      [done.c.communityId]
    );
    expect(audits.rows[0].n).toBe(1);
  });

  it.each(['objection', 'object-only link'] as const)(
    'serialises a claim and an owner keeping ownership (%s): exactly one wins',
    async (how) => {
      // Purpose: fails if the owner's "keep" and the claim can both succeed, or deadlock.
      const done = await claimableWithClaimant();
      const token = await objectToken(plain, done.c, done.replacementId);
      const [claimed, kept] = await holdingLock(
        plain.h,
        'SELECT 1 FROM communities WHERE id=$1 FOR UPDATE',
        [done.c.communityId],
        async (release) => {
          const racing = [
            claim(plain, done.cookie),
            how === 'objection'
              ? plain.h.call(`${done.c.base}/owner-replacement/objection`, {
                  cookie: done.c.owner.cookie,
                  body: { replacementId: done.replacementId },
                })
              : plain.h.call('/api/v1/owner-replacements/object', { body: { token } }),
          ];
          await waitForLockWaiters(plain.h, 2);
          await release();
          return Promise.all(racing);
        }
      );
      const state = (await replacementRow(plain, done.replacementId)).state;
      const owner = (
        await plain.h.pool.query(
          "SELECT id FROM members WHERE community_id=$1 AND role='owner' AND active",
          [done.c.communityId]
        )
      ).rows;
      expect(owner).toHaveLength(1);
      if (claimed.status === 200) {
        expect(state).toBe('completed');
        expect(owner[0].id).not.toBe(done.c.owner.memberId);
        expect(kept.status).toBe(how === 'objection' ? 403 : 200);
        if (how === 'object-only link') expect(await kept.json()).toEqual({ outcome: 'ended' });
      } else {
        expect(claimed.status).toBe(403);
        expect(state).toBe('objected');
        expect(owner[0].id).toBe(done.c.owner.memberId);
        expect(kept.status).toBe(how === 'objection' ? 204 : 200);
      }
    }
  );

  it.each(['claim first', 'erasure first'] as const)(
    "never leaves two owners or none when the claimant's account erasure races the claim (%s)",
    async (order) => {
      // Purpose: fails if the claim and the claimant's account erasure can both pass their checks
      // (an owner being deleted) or deadlock on the account and member rows.
      const c = await ownedCommunity(plain);
      const name = `Racer ${unique()}`;
      const email = `${name.toLowerCase().replaceAll(' ', '-')}@member.test`;
      const racer = await admit(plain.h, c.communityId, c.owner.cookie, { name, email });
      const { replacementId, claimToken } = await requestReplacement(plain, c);
      await toClaimable(plain, replacementId);
      const { cookie: claimCookie } = await preflightClaim(plain, claimToken);
      const userId = (
        await plain.h.pool.query('SELECT user_id FROM members WHERE id=$1', [racer.memberId])
      ).rows[0].user_id;
      const erase = () =>
        plain.h.call('/api/v1/account/erasures', {
          cookie: racer.cookie,
          body: { kind: 'account', confirmEmail: email, password: TENANCY_PASSWORD },
        });
      const doClaim = () => claim(plain, cookies(racer.cookie, claimCookie));
      const [claimed, erased] = await holdingLock(
        plain.h,
        'SELECT 1 FROM "user" WHERE id=$1 FOR UPDATE',
        [userId],
        async (release) => {
          const first = order === 'claim first' ? doClaim() : erase();
          await waitForLockWaiters(plain.h, 1);
          const second = order === 'claim first' ? erase() : doClaim();
          await waitForLockWaiters(plain.h, 2);
          await release();
          const [a, b] = await Promise.all([first, second]);
          return order === 'claim first' ? [a, b] : [b, a];
        }
      );
      const owners = await plain.h.pool.query(
        "SELECT id FROM members WHERE community_id=$1 AND role='owner' AND active",
        [c.communityId]
      );
      expect(owners.rows).toHaveLength(1);
      const open = await plain.h.pool.query(
        "SELECT 1 FROM erasure_requests WHERE user_id=$1 AND state='scheduled'",
        [userId]
      );
      if (claimed.status === 200) {
        expect(owners.rows[0].id).toBe(racer.memberId);
        expect(erased.status).toBe(409);
        expect(open.rowCount).toBe(0);
      } else {
        expect(claimed.status).toBe(409);
        expect(erased.status).toBe(201);
        expect(owners.rows[0].id).toBe(c.owner.memberId);
        expect(open.rowCount).toBe(1);
      }
    }
  );

  it('lets the old owner delete their account only after the claim', async () => {
    // Purpose: fails if the owner can erase while they own it, or stays stuck once they do not.
    const c = await ownedCommunity(plain);
    const email = (
      await plain.h.pool.query('SELECT email FROM "user" WHERE id=$1', [c.ownerUserId])
    ).rows[0].email;
    const erase = () =>
      plain.h.call('/api/v1/account/erasures', {
        cookie: c.owner.cookie,
        body: { kind: 'account', confirmEmail: email, password: TENANCY_PASSWORD },
      });
    expect((await erase()).status).toBe(409);
    const claimant = await member(plain, c);
    const { replacementId, claimToken } = await requestReplacement(plain, c);
    await toClaimable(plain, replacementId);
    const { cookie: claimCookie } = await preflightClaim(plain, claimToken);
    await expectStatus(await claim(plain, cookies(claimant.cookie, claimCookie)), 200, 'claim');
    expect((await erase()).status).toBe(201);
  });
});

describe('tenant binding (AC-17)', () => {
  it("changes only the claim token's own community", async () => {
    // Purpose: fails if a claim in A touches B, or a token could be pointed at another community.
    const a = await claimableWithClaimant();
    const b = await ownedCommunity(plain);
    const other = await requestReplacement(plain, b);
    await toClaimable(plain, other.replacementId);
    const before = {
      community: await snapshot(plain, b.communityId),
      replacement: await replacementRow(plain, other.replacementId),
    };
    await expectStatus(await claim(plain, a.cookie), 200, 'claim A');
    expect({
      community: await snapshot(plain, b.communityId),
      replacement: await replacementRow(plain, other.replacementId),
    }).toEqual(before);
    expect(
      (
        await plain.h.pool.query(
          "SELECT id FROM members WHERE community_id=$1 AND role='owner' AND active",
          [b.communityId]
        )
      ).rows
    ).toEqual([{ id: b.owner.memberId }]);
  });
});

describe('rate limits', () => {
  it("counts every owner-replacement link against the caller's attempts", async () => {
    // Purpose: fails if tokens can be guessed without limit through any of the link routes.
    const token = randomBytes(32).toString('base64url');
    const paths = [
      '/api/v1/owner-replacements/preflight',
      '/api/v1/owner-replacements/object-preflight',
      '/api/v1/owner-replacements/object',
      '/api/v1/owner-replacements/preflight',
    ];
    for (const path of paths)
      expect((await limited.h.call(path, { body: { token } })).status, path).toBe(403);
    for (const path of [...new Set(paths), '/api/v1/owner-replacements/claim']) {
      const refused = await limited.h.call(path, { body: path.endsWith('claim') ? {} : { token } });
      expect(refused.status, path).toBe(429);
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    }
  });
});
