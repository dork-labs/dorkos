/**
 * The owner says no, and the community hears about a replacement
 * (specs/community-owner-replacement, task 2.4: AC-9 objection half, AC-10, AC-11 and AC-14 for
 * these routes, AC-13 for objections, AC-17 object-link half, AC-18, AC-19 route half, and
 * AC-20's start). Real PostgreSQL through the tenancy harness; no test sends mail.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommunityWireOwnerReplacementNoticeResponseSchema } from '@dorkos/shared/community-wire';
import { signValue } from '../security.js';
import {
  DAY,
  MINUTE,
  TestClock,
  claim,
  cookies,
  lifecycleVersion,
  member,
  moveLifecycle,
  objectToken,
  ownedCommunity,
  passwordSignUp,
  preflightClaim,
  promote,
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
import { TENANCY_PASSWORD, expectStatus, pairInstall } from './tenancy-test-harness.js';

const clock = new TestClock();
let host: ReplacementHost;

beforeAll(async () => {
  host = await startReplacementHost('objection', clock);
}, 120_000);

afterAll(async () => {
  await host?.h.close();
});

const OPEN_STATES = ['notifying', 'waiting', 'claimable'] as const;
/** Words no member-facing answer about a replacement may contain. */
const NEVER_SAID = /legal|hold|host operator|api[_ ]key|oidc|subject|CASE-2541(?!")/iu;

async function openIn(state: (typeof OPEN_STATES)[number], c?: Owned) {
  const community = c ?? (await ownedCommunity(host));
  const request = await requestReplacement(host, community);
  if (state === 'waiting') await toWaiting(host, request.replacementId);
  if (state === 'claimable') await toClaimable(host, request.replacementId);
  return { c: community, ...request };
}

function readNotice(c: Owned, auth: { cookie?: string; bearer?: string }) {
  return host.h.call(`${c.base}/owner-replacement`, auth);
}

function object(c: Owned, cookie: string, replacementId: string, headers?: Record<string, string>) {
  return host.h.call(`${c.base}/owner-replacement/objection`, {
    cookie,
    body: { replacementId },
    headers,
  });
}

async function audits(communityId: string) {
  const hostRows = await host.h.pool.query(
    `SELECT action,actor_kind FROM host_audit_events
     WHERE community_id=$1 AND action LIKE 'owner_replacement.%' ORDER BY created_at,id`,
    [communityId]
  );
  const tenantRows = await host.h.pool.query(
    `SELECT action,actor_kind,actor_member_id,changed_fields FROM audit_events
     WHERE community_id=$1 AND action LIKE 'owner.replacement.%' ORDER BY created_at,id`,
    [communityId]
  );
  return { host: hostRows.rows, tenant: tenantRows.rows };
}

/** Whether a claim token and an object-only link of this request still work. */
async function linksAlive(claimToken: string, objectTokenValue: string) {
  const claimPreflight = await host.h.call('/api/v1/owner-replacements/preflight', {
    body: { token: claimToken },
  });
  const objectPreflight = await host.h.call('/api/v1/owner-replacements/object-preflight', {
    body: { token: objectTokenValue },
  });
  return { claim: claimPreflight.status, object: objectPreflight.status };
}

/** Ask again for the same community; after an objection this is inside the cooling-off. */
function askAgain(c: Owned) {
  return lifecycleVersion(host, c.communityId).then((version) =>
    host.h.call(`/api/v1/host/communities/${c.communityId}/owner-replacements`, {
      bearer: host.ownershipKey,
      body: {
        idempotencyKey: `again-${unique()}`,
        lifecycleVersion: version,
        reason: 'owner_unreachable',
        reference: null,
        claimant: { oidcSubject: null },
      },
    })
  );
}

describe('what members read (GET /owner-replacement)', () => {
  it('shows the owner the request, its reference, and their options; admins less; members nothing', async () => {
    // Purpose: fails if an admin or member sees the host's reference or the owner's options, if
    // the owner's options offer what they cannot do, or if any answer names the host's side.
    const { c, replacementId } = await openIn('waiting');
    const admin = await member(host, c);
    await promote(host, c, admin.memberId);
    const plainMember = await member(host, c);
    await expectStatus(
      await host.h.call(
        `/api/v1/host/communities/${c.communityId}/owner-replacements/${replacementId}/claim-token`,
        { bearer: host.ownershipKey, body: {} }
      ),
      200,
      'reissue'
    );
    const row = await replacementRow(host, replacementId);

    const owner = await readNotice(c, { cookie: c.owner.cookie });
    await expectStatus(owner, 200, 'owner read');
    expect(owner.headers.get('cache-control')).toBe('no-store');
    const ownerBody = await owner.json();
    expect(CommunityWireOwnerReplacementNoticeResponseSchema.parse(ownerBody)).toEqual({
      open: {
        role: 'owner',
        replacementId,
        state: 'waiting',
        reason: 'owner_unreachable',
        requestedAt: (row.requested_at as Date).toISOString(),
        claimableAfter: (row.claimable_after as Date).toISOString(),
        noticeState: 'accepted',
        reference: 'CASE-2541',
        claimReissuedAt: (row.claim_reissued_at as Date).toISOString(),
        options: { keep: true, transfer: true, delete: true, needsPassword: false },
        objectionCooldownDays: 90,
      },
      completed: null,
    });

    const adminBody = await (await readNotice(c, { cookie: admin.cookie })).json();
    expect(adminBody).toEqual({
      open: {
        role: 'admin',
        replacementId,
        state: 'waiting',
        reason: 'owner_unreachable',
        requestedAt: (row.requested_at as Date).toISOString(),
        claimableAfter: (row.claimable_after as Date).toISOString(),
        noticeState: 'accepted',
      },
      completed: null,
    });
    expect(await (await readNotice(c, { cookie: plainMember.cookie })).json()).toEqual({
      open: null,
      completed: null,
    });
    expect(JSON.stringify(adminBody)).not.toMatch(NEVER_SAID);
    expect(JSON.stringify(ownerBody).replace('"CASE-2541"', '')).not.toMatch(NEVER_SAID);
  });

  it('offers only what the owner can do: no transfer while held, nothing but keep without a password', async () => {
    // Purpose: fails if the owner is offered a transfer the route would refuse, or a transfer or
    // deletion their account has no password for.
    const held = await ownedCommunity(host);
    await moveLifecycle(host, held, 'held');
    await openIn('notifying', held);
    const heldBody = await (await readNotice(held, { cookie: held.owner.cookie })).json();
    expect(heldBody.open.options).toEqual({
      keep: true,
      transfer: false,
      delete: true,
      needsPassword: false,
    });

    const sso = await ownedCommunity(host);
    await openIn('notifying', sso);
    await host.h.pool.query(`DELETE FROM account WHERE "userId"=$1 AND "providerId"='credential'`, [
      sso.ownerUserId,
    ]);
    const ssoBody = await (await readNotice(sso, { cookie: sso.owner.cookie })).json();
    expect(ssoBody.open.options).toEqual({
      keep: true,
      transfer: false,
      delete: false,
      needsPassword: true,
    });
  });

  it("answers the owner's own DorkOS connection, and refuses an agent", async () => {
    // Purpose: fails if the DorkOS app cannot read the owner's notice, or an agent can.
    const { c } = await openIn('notifying');
    const grant = await pairInstall(host.h, c.communityId, c.owner.cookie);
    const read = await readNotice(c, { bearer: grant });
    await expectStatus(read, 200, 'grant read');
    expect((await read.json()).open.role).toBe('owner');
    const enrolled = await host.h.call(`${c.base}/agents`, {
      bearer: grant,
      body: { localAgentId: `agent-${unique()}`, displayName: 'Reader Agent' },
    });
    await expectStatus(enrolled, 201, 'enroll');
    const agentToken = (await enrolled.json()).token as string;
    expect((await readNotice(c, { bearer: agentToken })).status).toBe(403);
  });

  it('tells every member about a completion for 7 days, and not before', async () => {
    // Purpose: fails if members learn of a request before it completes, never learn of the new
    // owner, or keep being told after a week.
    const { c, replacementId, claimToken } = await openIn('claimable');
    const bystander = await member(host, c);
    expect(await (await readNotice(c, { cookie: bystander.cookie })).json()).toEqual({
      open: null,
      completed: null,
    });
    const { cookie: claimCookie } = await preflightClaim(host, claimToken);
    const claimant = await passwordSignUp(host, claimCookie, `New Owner ${unique()}`);
    await expectStatus(await claim(host, claimant.cookie), 200, 'claim');
    const completedAt = (await replacementRow(host, replacementId)).ended_at as Date;
    const newOwner = (
      await host.h.pool.query(
        'SELECT display_name FROM members WHERE id=(SELECT new_owner_member_id FROM owner_replacements WHERE id=$1)',
        [replacementId]
      )
    ).rows[0].display_name;
    // Only the owner it replaced is told it was theirs (DOR-2543): their own DorkOS announces it
    // from that, so it fails if the new owner or a bystander were marked, or the prior owner not.
    for (const [reader, wasYours] of [
      [bystander.cookie, false],
      [c.owner.cookie, true],
      [claimant.cookie, false],
    ] as const)
      expect(await (await readNotice(c, { cookie: reader })).json()).toEqual({
        open: null,
        completed: {
          replacementId,
          newOwnerDisplayName: newOwner,
          completedAt: completedAt.toISOString(),
          wasYours,
        },
      });
    // The prior owner's own DorkOS connection reads the same, through its grant.
    const priorOwnerGrant = await pairInstall(host.h, c.communityId, c.owner.cookie);
    expect((await (await readNotice(c, { bearer: priorOwnerGrant })).json()).completed).toEqual(
      expect.objectContaining({ replacementId, wasYours: true })
    );
    clock.ms = completedAt.getTime() + 7 * DAY - MINUTE;
    expect((await (await readNotice(c, { cookie: bystander.cookie })).json()).completed).not.toBe(
      null
    );
    clock.ms = completedAt.getTime() + 7 * DAY + MINUTE;
    expect(await (await readNotice(c, { cookie: bystander.cookie })).json()).toEqual({
      open: null,
      completed: null,
    });
  });
});

describe('keeping ownership in the product (AC-9, objection half)', () => {
  it.each(OPEN_STATES)(
    'ends a request in %s as objected, kills its links, audits it, and starts the cooling-off',
    async (state) => {
      // Purpose: fails if the owner's "keep" leaves the request, its claim link, or an
      // object-only link alive, writes the wrong audit rows, or lets the host ask again at once.
      const { c, replacementId, claimToken } = await openIn(state);
      const token = await objectToken(host, c, replacementId);
      expect(await linksAlive(claimToken, token)).toEqual({ claim: 200, object: 200 });
      const kept = await object(c, c.owner.cookie, replacementId);
      expect(kept.status).toBe(204);
      expect(await replacementRow(host, replacementId)).toMatchObject({
        state: 'objected',
        claim_token_hash: null,
        ended_at: clock.now(),
      });
      expect(await linksAlive(claimToken, token)).toEqual({ claim: 403, object: 403 });
      expect(await audits(c.communityId)).toEqual({
        host: [
          { action: 'owner_replacement.request', actor_kind: 'api_key' },
          { action: 'owner_replacement.objected', actor_kind: 'system' },
        ],
        tenant: [
          {
            action: 'owner.replacement.requested',
            actor_kind: 'host',
            actor_member_id: null,
            changed_fields: [],
          },
          {
            action: 'owner.replacement.objected',
            actor_kind: 'member',
            actor_member_id: c.owner.memberId,
            changed_fields: [],
          },
        ],
      });
      const again = await askAgain(c);
      expect(again.status).toBe(409);
      expect((await again.json()).code).toBe('OWNER_REPLACEMENT_COOLDOWN');
    }
  );

  it('answers a repeat with the same success and writes nothing again', async () => {
    // Purpose: fails if a double click writes a second audit row or errors.
    const { c, replacementId } = await openIn('waiting');
    expect((await object(c, c.owner.cookie, replacementId)).status).toBe(204);
    const once = await audits(c.communityId);
    expect((await object(c, c.owner.cookie, replacementId)).status).toBe(204);
    expect(await audits(c.communityId)).toEqual(once);
  });

  it('refuses a request that ended another way', async () => {
    // Purpose: fails if keeping ownership can reopen or rewrite a withdrawn request.
    const { c, replacementId } = await openIn('notifying');
    await expectStatus(
      await host.h.call(
        `/api/v1/host/communities/${c.communityId}/owner-replacements/${replacementId}/cancel`,
        { bearer: host.ownershipKey, body: {} }
      ),
      200,
      'cancel'
    );
    const refused = await object(c, c.owner.cookie, replacementId);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      code: 'STATE_CONFLICT',
      message: 'This request has already ended.',
    });
    expect((await replacementRow(host, replacementId)).state).toBe('withdrawn');
  });

  it('works for an owner with no password', async () => {
    // Purpose: fails if keeping ownership asks for a password a single sign-on owner lacks.
    const { c, replacementId } = await openIn('waiting');
    await host.h.pool.query(`DELETE FROM account WHERE "userId"=$1 AND "providerId"='credential'`, [
      c.ownerUserId,
    ]);
    expect((await object(c, c.owner.cookie, replacementId)).status).toBe(204);
  });

  it('refuses every bearer credential, an admin, and a member, and changes nothing', async () => {
    // Purpose: fails if anything but the owner's own browser session can end the request.
    const { c, replacementId } = await openIn('waiting');
    const grant = await pairInstall(host.h, c.communityId, c.owner.cookie);
    const enrolled = await host.h.call(`${c.base}/agents`, {
      bearer: grant,
      body: { localAgentId: `agent-${unique()}`, displayName: 'Keeper Agent' },
    });
    const agentToken = (await enrolled.json()).token as string;
    const admin = await member(host, c);
    await promote(host, c, admin.memberId);
    const plainMember = await member(host, c);
    const before = await replacementRow(host, replacementId);
    const tries: [string, Response, number][] = [
      [
        'connection grant',
        await host.h.call(`${c.base}/owner-replacement/objection`, {
          bearer: grant,
          body: { replacementId },
        }),
        403,
      ],
      [
        'agent credential',
        await host.h.call(`${c.base}/owner-replacement/objection`, {
          bearer: agentToken,
          body: { replacementId },
        }),
        403,
      ],
      [
        'owner session with a bearer beside it',
        await object(c, c.owner.cookie, replacementId, { authorization: `Bearer ${grant}` }),
        403,
      ],
      [
        'host API key',
        await host.h.call(`${c.base}/owner-replacement/objection`, {
          bearer: host.ownershipKey,
          body: { replacementId },
        }),
        401,
      ],
      ['admin', await object(c, admin.cookie, replacementId), 403],
      ['member', await object(c, plainMember.cookie, replacementId), 403],
      ['no session', await object(c, '', replacementId), 401],
    ];
    for (const [name, response, status] of tries) expect(response.status, name).toBe(status);
    expect(await replacementRow(host, replacementId)).toEqual(before);
  });

  it('works while the community is archived or held, where transfer stays refused (AC-10)', async () => {
    // Purpose: fails if a hold or an archive traps the owner, or lets them transfer.
    for (const lifecycle of ['archived', 'held'] as const) {
      const c = await ownedCommunity(host);
      const successor = await member(host, c);
      await moveLifecycle(host, c, lifecycle);
      const { replacementId } = await openIn('waiting', c);
      const transfer = await host.h.call(`${c.base}/owner/transfer`, {
        cookie: c.owner.cookie,
        body: {
          successorMemberId: successor.memberId,
          lifecycleVersion: await lifecycleVersion(host, c.communityId),
          password: TENANCY_PASSWORD,
        },
      });
      expect([409, 423], lifecycle).toContain(transfer.status);
      expect((await object(c, c.owner.cookie, replacementId)).status, lifecycle).toBe(204);
      expect((await replacementRow(host, replacementId)).state, lifecycle).toBe('objected');
    }
  });

  it('behaves the same under a legal hold and never mentions it (AC-11)', async () => {
    // Purpose: fails if a legal hold blocks the owner or shows up in anything they read.
    const c = await ownedCommunity(host);
    await expectStatus(
      await host.h.call(`/api/v1/host/communities/${c.communityId}/legal-hold`, {
        method: 'PUT',
        cookie: host.operator,
        body: { reference: 'COURT-1' },
      }),
      200,
      'legal hold'
    );
    const { replacementId } = await openIn('claimable', c);
    const read = await (await readNotice(c, { cookie: c.owner.cookie })).text();
    expect(read.replace('"CASE-2541"', '')).not.toMatch(NEVER_SAID);
    expect(read).not.toContain('COURT-1');
    expect((await object(c, c.owner.cookie, replacementId)).status).toBe(204);
  });

  it("refuses another community's request on this community's path (AC-17)", async () => {
    // Purpose: fails if a replacement id from one community can be answered through another.
    const a = await openIn('waiting');
    const b = await openIn('waiting');
    const crossed = await object(b.c, b.c.owner.cookie, a.replacementId);
    expect(crossed.status).toBe(404);
    const foreign = await object(b.c, a.c.owner.cookie, b.replacementId);
    expect(foreign.status).toBe(403);
    expect((await replacementRow(host, a.replacementId)).state).toBe('waiting');
    expect((await replacementRow(host, b.replacementId)).state).toBe('waiting');
  });
});

describe('the object-only link (AC-19, route half)', () => {
  it('shows a live link only its community name and date, and changes nothing', async () => {
    // Purpose: fails if the preflight reveals more than the name and date, or objects.
    const { c, replacementId } = await openIn('waiting');
    const token = await objectToken(host, c, replacementId);
    const row = await replacementRow(host, replacementId);
    const preflight = await host.h.call('/api/v1/owner-replacements/object-preflight', {
      body: { token },
    });
    await expectStatus(preflight, 200, 'object preflight');
    expect(preflight.headers.get('cache-control')).toBe('no-store');
    expect(await preflight.json()).toEqual({
      communityName: c.name,
      claimableAfter: (row.claimable_after as Date).toISOString(),
      objectionCooldownDays: 90,
    });
    expect(await replacementRow(host, replacementId)).toEqual(row);
  });

  it('never objects on a GET, whatever a mail scanner opens', async () => {
    // Purpose: fails if fetching the link or either route with GET ends the request.
    const { c, replacementId } = await openIn('waiting');
    const token = await objectToken(host, c, replacementId);
    const before = await replacementRow(host, replacementId);
    for (const path of [
      `/keep-ownership#${token}`,
      `/api/v1/owner-replacements/object?token=${token}`,
      `/api/v1/owner-replacements/object-preflight?token=${token}`,
    ])
      expect((await host.h.call(path)).status, path).toBe(404);
    expect(await replacementRow(host, replacementId)).toEqual(before);
  });

  it('keeps ownership without a session, once, and answers a replay the same with nothing written', async () => {
    // Purpose: fails if the link needs a sign-in, fails to end the request or start the
    // cooling-off, writes the wrong audits, or writes a second audit row when used again.
    const { c, replacementId, claimToken } = await openIn('claimable');
    const token = await objectToken(host, c, replacementId);
    const spare = await objectToken(host, c, replacementId);
    const kept = await host.h.call('/api/v1/owner-replacements/object', { body: { token } });
    await expectStatus(kept, 200, 'object');
    expect(kept.headers.get('cache-control')).toBe('no-store');
    expect(await kept.json()).toEqual({ outcome: 'kept' });
    expect((await replacementRow(host, replacementId)).state).toBe('objected');
    const used = await host.h.pool.query(
      'SELECT used_at FROM owner_replacement_object_tokens WHERE replacement_id=$1 AND used_at IS NOT NULL',
      [replacementId]
    );
    expect(used.rowCount).toBe(1);
    const once = await audits(c.communityId);
    expect(once.host.at(-1)).toEqual({
      action: 'owner_replacement.objected',
      actor_kind: 'system',
    });
    expect(once.tenant.at(-1)).toEqual({
      action: 'owner.replacement.objected',
      actor_kind: 'system',
      actor_member_id: null,
      changed_fields: ['via_link'],
    });
    expect(await linksAlive(claimToken, spare)).toEqual({ claim: 403, object: 403 });
    for (const again of [token, spare]) {
      const replay = await host.h.call('/api/v1/owner-replacements/object', {
        body: { token: again },
      });
      expect(await replay.json()).toEqual({ outcome: 'kept' });
    }
    expect(await audits(c.communityId)).toEqual(once);
    expect((await askAgain(c)).status).toBe(409);
  });

  it('answers a request that ended any other way as ended, and changes nothing', async () => {
    // Purpose: fails if a link from a withdrawn or expired request objects or reopens it.
    const withdrawn = await openIn('waiting');
    const withdrawnToken = await objectToken(host, withdrawn.c, withdrawn.replacementId);
    await expectStatus(
      await host.h.call(
        `/api/v1/host/communities/${withdrawn.c.communityId}/owner-replacements/${withdrawn.replacementId}/cancel`,
        { bearer: host.ownershipKey, body: {} }
      ),
      200,
      'cancel'
    );
    const expired = await openIn('claimable');
    const expiredToken = await objectToken(host, expired.c, expired.replacementId);
    clock.advance(14 * DAY);
    await tick(host);
    for (const [name, token, id, state] of [
      ['withdrawn', withdrawnToken, withdrawn.replacementId, 'withdrawn'],
      ['expired', expiredToken, expired.replacementId, 'expired'],
    ] as const) {
      const response = await host.h.call('/api/v1/owner-replacements/object', { body: { token } });
      expect(response.status, name).toBe(200);
      expect(await response.json(), name).toEqual({ outcome: 'ended' });
      expect((await replacementRow(host, id)).state, name).toBe(state);
    }
  });

  it('answers one identical 403 for every link that no longer works', async () => {
    // Purpose: fails if an unknown, used, or dead link can be told apart on either route.
    const { c, replacementId, claimToken } = await openIn('waiting');
    const used = await objectToken(host, c, replacementId);
    await expectStatus(
      await host.h.call('/api/v1/owner-replacements/object', { body: { token: used } }),
      200,
      'use it'
    );
    const answers = [];
    for (const token of [randomBytes(32).toString('base64url'), used, claimToken, 'x'])
      answers.push(
        await (
          await host.h.call('/api/v1/owner-replacements/object-preflight', { body: { token } })
        ).text()
      );
    const unknownObject = await host.h.call('/api/v1/owner-replacements/object', {
      body: { token: randomBytes(32).toString('base64url') },
    });
    expect(unknownObject.status).toBe(403);
    answers.push(await unknownObject.text());
    const claimAsObject = await host.h.call('/api/v1/owner-replacements/object', {
      body: { token: claimToken },
    });
    expect(claimAsObject.status).toBe(403);
    answers.push(await claimAsObject.text());
    expect(new Set(answers)).toEqual(
      new Set([JSON.stringify({ code: 'FORBIDDEN', message: 'This link no longer works.' })])
    );
  });

  it('is not a session, a claim, or a connection', async () => {
    // Purpose: fails if the emailed link can sign someone in, claim, or read the community.
    const { c, replacementId } = await openIn('claimable');
    const token = await objectToken(host, c, replacementId);
    const before = await replacementRow(host, replacementId);
    const session = await host.h.call(`${c.base}/me`, {
      cookie: `better-auth.session_token=${token}`,
    });
    expect(session.status).toBe(401);
    expect((await host.h.call(`${c.base}/channels`, { bearer: token })).status).toBe(401);
    expect((await host.h.call(`${c.base}/owner-replacement`, { bearer: token })).status).toBe(401);
    const asClaim = await host.h.call('/api/v1/owner-replacements/preflight', { body: { token } });
    expect(asClaim.status).toBe(403);
    const claimant = await member(host, c);
    const forged = cookies(
      claimant.cookie,
      `community_owner_replacement=${signValue(token, host.h.config.authSecret)}`
    );
    expect((await claim(host, forged)).status).toBe(403);
    expect(await replacementRow(host, replacementId)).toEqual(before);
  });
});
