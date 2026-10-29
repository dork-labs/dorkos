/**
 * The `administer` pairing scope (DOR-3005): an owner or admin lets their own paired DorkOS app
 * manage a space, with their consent, through a separate credential.
 *
 * - Only an owner's or admin's approval with the consent line ticked issues it; a member's never
 *   does, even when the request asks, and neither does an approval without the consent.
 * - It is its own row with its own token, never one more scope on the connection grant: it does
 *   not pass the grant's own routes, and the grant does not pass its routes.
 * - It passes exactly the routes an owner or admin manages through (reads: invitations and mutes;
 *   writes: settings, icon, roles, rules, invitations, mutes, removing a member), under the same
 *   live role checks as the browser, on every call. Handing over, archiving, deleting and leaving
 *   still need the browser.
 * - An agent's credential, a revoked credential, one whose grant was revoked, and another space's
 *   are refused. A demoted admin is refused on the next call.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admit,
  bootstrapHost,
  claimAsNewAccount,
  createPendingCommunity,
  expectStatus,
  pairInstall,
  startTenancyHarness,
  TENANCY_PASSWORD,
  type TenancyHarness,
  type TenancyMember,
} from './tenancy-test-harness.js';
import { hashSecret } from '../security.js';

let h: TenancyHarness;
let communityId = '';
let otherCommunityId = '';
let otherAdminister = '';
let agentToken = '';
let seq = 0;

const ROLES = ['owner', 'admin', 'member'] as const;
type Role = (typeof ROLES)[number];
type Via = 'cookie' | 'read grant' | 'administer';
const people = {} as Record<
  Role,
  TenancyMember & { grant: string; administer: string | undefined }
>;
const tenant = (id = communityId) => `/api/v1/communities/${id}`;

/** One pairing, approved in the browser with or without the consent line ticked. */
async function pair(
  communityIdToPair: string,
  approverCookie: string,
  scopes: string[],
  consent: boolean,
  beforeExchange?: () => Promise<void>
) {
  const base = tenant(communityIdToPair);
  const local = { origin: '' };
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const started = await expectStatus(
    await h.call(`${base}/pairings/start`, {
      headers: local,
      body: { installName: `Install ${++seq}`, challenge, scopes },
    }),
    201,
    'pairing start'
  );
  const { pairingId } = (await started.json()) as { pairingId: string };
  const shown = await expectStatus(
    await h.call(`${base}/pairings/${pairingId}`, { cookie: approverCookie }),
    200,
    'pairing status'
  );
  const shownScopes = ((await shown.json()) as { scopes: string[] }).scopes;
  await expectStatus(
    await h.call(`${base}/pairings/approve`, {
      cookie: approverCookie,
      // Consent takes the password (#3155 review, M3).
      body: consent ? { pairingId, administer: true, password: TENANCY_PASSWORD } : { pairingId },
    }),
    200,
    'pairing approve'
  );
  await beforeExchange?.();
  const polled = await expectStatus(
    await h.call(`${base}/pairings/poll`, { headers: local, body: { pairingId, verifier } }),
    200,
    'pairing poll'
  );
  const { code } = (await polled.json()) as { code: string };
  const exchanged = await expectStatus(
    await h.call(`${base}/pairings/exchange`, {
      headers: local,
      body: { pairingId, code, verifier },
    }),
    200,
    'pairing exchange'
  );
  const body = (await exchanged.json()) as {
    token: string;
    administerToken?: string;
    grant: { id: string; scopes: string[] };
  };
  return { ...body, pairingId, shownScopes };
}

/** The credential a role reaches the space with. */
function credential(role: Role, via: Via): { cookie?: string; bearer?: string } {
  const person = people[role];
  if (via === 'cookie') return { cookie: person.cookie };
  if (via === 'read grant') return { bearer: person.grant };
  return { bearer: person.administer };
}

async function settingsVersion(): Promise<number> {
  const row = await h.pool.query<{ settings_version: number }>(
    'SELECT settings_version FROM communities WHERE id=$1',
    [communityId]
  );
  return row.rows[0]!.settings_version;
}

async function rulesVersion(): Promise<number> {
  const row = await h.pool.query<{ rules_version: number }>(
    'SELECT rules_version FROM communities WHERE id=$1',
    [communityId]
  );
  return row.rows[0]!.rules_version;
}

/** A fresh plain member to act on, so each call starts from the same place. */
async function target(): Promise<string> {
  const admitted = await admit(h, communityId, people.owner.cookie, {
    name: `Target ${++seq}`,
    email: `target-${seq}@administer.test`,
  });
  return admitted.memberId;
}

/** Each operation the `administer` credential opens, who may do it, and its success status. */
const OPERATIONS: {
  name: string;
  roles: readonly Role[];
  ok: number;
  /** A move that hits other people hard: the app's credential is told to use the browser (M2). */
  browserOnly?: true;
  run: (auth: { cookie?: string; bearer?: string }) => Promise<Response>;
}[] = [
  {
    name: 'GET /invites',
    roles: ['owner', 'admin'],
    ok: 200,
    run: (a) => h.call(`${tenant()}/invites`, a),
  },
  {
    name: 'GET /mutes',
    roles: ['owner', 'admin'],
    ok: 200,
    run: (a) => h.call(`${tenant()}/mutes`, a),
  },
  {
    name: 'PATCH /settings',
    roles: ['owner', 'admin'],
    ok: 200,
    run: async (a) =>
      h.call(`${tenant()}/settings`, {
        ...a,
        method: 'PATCH',
        headers: { 'if-match': `"${await settingsVersion()}"` },
        body: { description: `Described ${++seq}` },
      }),
  },
  {
    name: 'DELETE /settings/icon',
    roles: ['owner', 'admin'],
    ok: 200,
    run: async (a) =>
      h.call(`${tenant()}/settings/icon`, {
        ...a,
        method: 'DELETE',
        headers: { 'if-match': `"${await settingsVersion()}"` },
      }),
  },
  {
    name: 'PUT /rules',
    roles: ['owner', 'admin'],
    ok: 200,
    run: async (a) =>
      h.call(`${tenant()}/rules`, {
        ...a,
        method: 'PUT',
        body: { text: `Be kind ${++seq}`, expectedVersion: await rulesVersion() },
      }),
  },
  {
    name: 'POST and DELETE /invites',
    roles: ['owner', 'admin'],
    ok: 204,
    run: async (a) => {
      const created = await h.call(`${tenant()}/invites`, { ...a, body: { seats: 1 } });
      if (created.status !== 201) return created;
      const { invite } = (await created.json()) as { invite: { id: string } };
      return h.call(`${tenant()}/invites/${invite.id}`, { ...a, method: 'DELETE' });
    },
  },
  {
    name: 'POST and DELETE /members/:id/mute',
    roles: ['owner', 'admin'],
    ok: 204,
    run: async (a) => {
      const id = await target();
      const muted = await h.call(`${tenant()}/members/${id}/mute`, { ...a, body: { minutes: 5 } });
      if (muted.status !== 200) return muted;
      return h.call(`${tenant()}/members/${id}/mute`, { ...a, method: 'DELETE' });
    },
  },
  {
    name: 'PATCH /settings admissionPolicy',
    roles: ['owner'],
    ok: 200,
    browserOnly: true,
    run: async (a) => {
      const now = await h.pool.query<{ admission_policy: string }>(
        'SELECT admission_policy FROM communities WHERE id=$1',
        [communityId]
      );
      return h.call(`${tenant()}/settings`, {
        ...a,
        method: 'PATCH',
        headers: { 'if-match': `"${await settingsVersion()}"` },
        body: { admissionPolicy: now.rows[0]!.admission_policy },
      });
    },
  },
  {
    name: 'PATCH /members/:id/role',
    roles: ['owner'],
    ok: 200,
    browserOnly: true,
    run: async (a) =>
      h.call(`${tenant()}/members/${await target()}/role`, {
        ...a,
        method: 'PATCH',
        body: { role: 'member' },
      }),
  },
  {
    name: 'DELETE /members/:id',
    roles: ['owner', 'admin'],
    ok: 204,
    browserOnly: true,
    run: async (a) => h.call(`${tenant()}/members/${await target()}`, { ...a, method: 'DELETE' }),
  },
];

beforeAll(async () => {
  h = await startTenancyHarness('administer_grants');
  const host = await bootstrapHost(h, 'Owner', 'owner@administer.test');
  communityId = host.communityId;
  const owner = { cookie: host.cookie, memberId: host.memberId };
  const admin = await admit(h, communityId, owner.cookie, {
    name: 'Admin',
    email: 'admin@administer.test',
  });
  const member = await admit(h, communityId, owner.cookie, {
    name: 'Member',
    email: 'member@administer.test',
  });
  await h.pool.query("UPDATE members SET role='admin' WHERE id=$1", [admin.memberId]);
  for (const [role, who] of [
    ['owner', owner],
    ['admin', admin],
    ['member', member],
  ] as const) {
    const managed = await pair(communityId, who.cookie, ['read', 'post', 'administer'], true);
    people[role] = {
      ...who,
      grant: await pairInstall(h, communityId, who.cookie, ['read']),
      administer: managed.administerToken,
    };
  }

  const enrolling = await pairInstall(h, communityId, owner.cookie);
  const enrolled = await expectStatus(
    await h.call(`${tenant()}/agents`, {
      bearer: enrolling,
      body: { localAgentId: crypto.randomUUID(), displayName: 'Helper' },
    }),
    201,
    'enroll agent'
  );
  agentToken = ((await enrolled.json()) as { token: string }).token;

  const other = await createPendingCommunity(h, owner.cookie, 'Elsewhere');
  otherCommunityId = other.communityId;
  const otherOwner = await claimAsNewAccount(h, other.token, 'Other', 'other@administer.test');
  otherAdminister =
    (await pair(otherCommunityId, otherOwner.cookie, ['read', 'administer'], true))
      .administerToken ?? '';
});

afterAll(async () => {
  await h?.close();
});

describe('who can give their app the administer credential', () => {
  it('issues one to a consenting owner and admin, and never to a member', async () => {
    // Purpose: fails if a member's pairing ever carries administer, or an owner's or admin's
    // consented one does not (security rule 1).
    expect(people.owner.administer).toEqual(expect.any(String));
    expect(people.admin.administer).toEqual(expect.any(String));
    expect(people.member.administer).toBeUndefined();
    const rows = await h.pool.query<{ member_id: string }>(
      'SELECT member_id FROM connection_administer_grants WHERE community_id=$1',
      [communityId]
    );
    expect(rows.rows.map((row) => row.member_id)).not.toContain(people.member.memberId);
  });

  it('shows the consent line to an owner or admin, never to a member', async () => {
    // Purpose: fails if the approval page offers a member the scope it can never grant.
    for (const role of ROLES) {
      const shown = await pair(communityId, people[role].cookie, ['read', 'administer'], false);
      expect(shown.shownScopes.includes('administer'), role).toBe(role !== 'member');
    }
  });

  it('issues nothing without the consent, and never as a scope on the grant', async () => {
    // Purpose: fails if approving without ticking the box consents, or administer leaks into
    // the connection grant's own scopes, where an older app would refuse the whole answer.
    const unticked = await pair(communityId, people.owner.cookie, ['read', 'administer'], false);
    expect(unticked.administerToken).toBeUndefined();
    const ticked = await pair(communityId, people.owner.cookie, ['read', 'administer'], true);
    expect(ticked.administerToken).toEqual(expect.any(String));
    for (const exchanged of [unticked, ticked]) {
      expect(exchanged.grant.scopes).toEqual(['read']);
      const stored = await h.pool.query<{ scopes: string[] }>(
        'SELECT scopes FROM connection_grants WHERE id=$1',
        [exchanged.grant.id]
      );
      expect(stored.rows[0]!.scopes).toEqual(['read']);
    }
    const audit = await h.pool.query<{ changed_fields: string[] }>(
      "SELECT changed_fields FROM audit_events WHERE action='pairing.approve' AND subject_id=$1",
      [ticked.pairingId]
    );
    expect(audit.rows[0]!.changed_fields).toEqual(['administer']);
  });

  it('issues nothing when the approving admin is demoted before the exchange', async () => {
    // Purpose: fails if the exchange trusts the role at approval instead of the role now.
    const admin = await admit(h, communityId, people.owner.cookie, {
      name: 'Brief admin',
      email: 'brief@administer.test',
    });
    await h.pool.query("UPDATE members SET role='admin' WHERE id=$1", [admin.memberId]);
    const paired = await pair(communityId, admin.cookie, ['read', 'administer'], true, () =>
      h.pool.query("UPDATE members SET role='member' WHERE id=$1", [admin.memberId]).then(() => {})
    );
    expect(paired.administerToken).toBeUndefined();
  });

  it('refuses a request that would manage a space without reading it', async () => {
    const response = await h.call(`${tenant()}/pairings/start`, {
      headers: { origin: '' },
      body: {
        installName: 'Bad',
        challenge: createHash('sha256').update('x').digest('base64url'),
        scopes: ['administer'],
      },
    });
    expect(response.status).toBe(400);
  });

  it('takes the approver’s password to consent, and issues nothing without it', async () => {
    // Purpose: fails if a click in a signed-in browser (an agent driving it) can give the app
    // manage power without the person's password (#3155 review, M3).
    for (const password of [undefined, 'not-the-password']) {
      const base = tenant();
      const started = await expectStatus(
        await h.call(`${base}/pairings/start`, {
          headers: { origin: '' },
          body: {
            installName: `No password ${++seq}`,
            challenge: createHash('sha256').update(`v${seq}`).digest('base64url'),
            scopes: ['read', 'administer'],
          },
        }),
        201,
        'pairing start'
      );
      const { pairingId } = (await started.json()) as { pairingId: string };
      const approved = await h.call(`${base}/pairings/approve`, {
        cookie: people.owner.cookie,
        body: { pairingId, administer: true, ...(password ? { password } : {}) },
      });
      expect(approved.status).toBe(403);
      expect(((await approved.json()) as { code: string }).code).toBe('REAUTH_FAILED');
      const row = await h.pool.query(
        'SELECT approved_at FROM connection_pairings WHERE id=$1 AND approved_at IS NOT NULL',
        [pairingId]
      );
      expect(row.rowCount).toBe(0);
    }
  });

  it('says the space offers it', async () => {
    const response = await expectStatus(await h.call(`${tenant()}/features`), 200, 'features');
    expect(((await response.json()) as { features: object }).features).toMatchObject({
      administer: true,
    });
  });
});

describe('role × credential', () => {
  // Purpose: fails if any manage route reads or writes for a credential or role it should not,
  // or refuses one it should (security rules 4 and 5, and the matrix of rule 6).
  for (const operation of OPERATIONS) {
    for (const role of ROLES) {
      for (const via of ['cookie', 'read grant', 'administer'] as const) {
        if (role === 'member' && via === 'administer') continue; // A member never holds one.
        // A read grant is no credential here at all (401); a role that may not is refused (403),
        // and so is the app's credential on a browser-only move.
        const refused =
          !operation.roles.includes(role) || (via === 'administer' && operation.browserOnly);
        const expected = via === 'read grant' ? 401 : refused ? 403 : operation.ok;
        it(`${operation.name}: ${role} by ${via} → ${expected}`, async () => {
          const response = await operation.run(credential(role, via));
          expect(response.status, await response.clone().text()).toBe(expected);
        });
      }
    }
  }
});

describe('what the audit trail says', () => {
  it('tags every row the app’s credential writes, and none the browser writes', async () => {
    // Purpose: fails if an audit row cannot tell the person's app from their browser (M2).
    const update = async (auth: { cookie?: string; bearer?: string }) => {
      await expectStatus(
        await h.call(`${tenant()}/settings`, {
          ...auth,
          method: 'PATCH',
          headers: { 'if-match': `"${await settingsVersion()}"` },
          body: { description: `Tagged ${++seq}` },
        }),
        200,
        'settings'
      );
      const row = await h.pool.query<{ via: string | null }>(
        "SELECT via FROM audit_events WHERE community_id=$1 AND action='settings.update' ORDER BY created_at DESC, id DESC LIMIT 1",
        [communityId]
      );
      return row.rows[0]!.via;
    };
    expect(await update(credential('owner', 'administer'))).toBe('administer');
    expect(await update(credential('owner', 'cookie'))).toBeNull();
  });

  it('records taking the credential back', async () => {
    // Purpose: fails if a revoke leaves no audit row (M2).
    const paired = await pair(communityId, people.admin.cookie, ['read', 'administer'], true);
    await expectStatus(
      await h.call(`${tenant()}/me/grants/${paired.grant.id}/administer`, {
        cookie: people.admin.cookie,
        method: 'DELETE',
      }),
      204,
      'revoke'
    );
    const row = await h.pool.query<{ actor_member_id: string }>(
      "SELECT actor_member_id FROM audit_events WHERE action='administer.revoke' AND subject_id=$1",
      [paired.grant.id]
    );
    expect(row.rows.map((r) => r.actor_member_id)).toEqual([people.admin.memberId]);
  });
});

describe('what the administer credential is not', () => {
  it('is not a connection grant: the grant’s own reads and posts refuse it', async () => {
    // Purpose: fails if the administer token is loaded on the read/post paths (rule 2 and 3).
    for (const path of ['/settings', '/me', '/members', '/rules', '/channels']) {
      const response = await h.call(`${tenant()}${path}`, { bearer: people.owner.administer });
      expect(response.status, path).toBe(401);
    }
    const access = await h.call(`${tenant()}/me/connection-access`, {
      bearer: people.owner.administer,
    });
    expect(access.status).toBe(401);
  });

  it('never hands over, archives, deletes or leaves', async () => {
    // Purpose: fails if a password- or browser-only route starts accepting the credential.
    const routes: [string, string, unknown][] = [
      [
        'POST',
        '/owner/transfer',
        { successorMemberId: people.admin.memberId, password: 'x', lifecycleVersion: 1 },
      ],
      [
        'POST',
        '/owner/lifecycle',
        { action: 'archive', password: 'x', lifecycleVersion: 1, confirmName: 'x' },
      ],
      [
        'POST',
        '/owner/deletion',
        { password: 'x', lifecycleVersion: 1, confirmName: 'x', confirmIdSuffix: 'x' },
      ],
      ['POST', '/me/leave', { password: 'x', communityName: 'x' }],
      ['GET', '/owner/deletion', undefined],
      ['GET', '/reserved-names', undefined],
      ['GET', '/bans', undefined],
    ];
    for (const [method, path, body] of routes) {
      const response = await h.call(`${tenant()}${path}`, {
        method,
        body,
        bearer: people.owner.administer,
      });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe('credentials the manage routes refuse', () => {
  it('refuses an agent’s credential', async () => {
    // Purpose: fails if an agent reaches a manage route (rule 3).
    for (const operation of OPERATIONS) {
      const response = await operation.run({ bearer: agentToken });
      expect(response.status, operation.name).toBe(401);
    }
  });

  it('refuses another space’s administer credential', async () => {
    // Purpose: fails if the credential is not bound to the space that issued it.
    expect(otherAdminister).not.toBe('');
    const own = await h.call(`${tenant(otherCommunityId)}/invites`, { bearer: otherAdminister });
    expect(own.status).toBe(200);
    for (const path of ['/invites', '/mutes']) {
      const response = await h.call(`${tenant()}${path}`, { bearer: otherAdminister });
      expect(response.status, path).toBe(401);
    }
  });

  it('refuses a revoked one, and the connection keeps reading', async () => {
    // Purpose: fails if the credential is not revocable on its own, apart from its grant.
    const paired = await pair(communityId, people.admin.cookie, ['read', 'administer'], true);
    await expectStatus(
      await h.call(`${tenant()}/invites`, { bearer: paired.administerToken }),
      200,
      'live'
    );
    await expectStatus(
      await h.call(`${tenant()}/me/grants/${paired.grant.id}/administer`, {
        method: 'DELETE',
        cookie: people.admin.cookie,
      }),
      204,
      'take back'
    );
    const refused = await h.call(`${tenant()}/invites`, { bearer: paired.administerToken });
    expect(refused.status).toBe(401);
    await expectStatus(
      await h.call(`${tenant()}/settings`, { bearer: paired.token }),
      200,
      'still reads'
    );
  });

  it('refuses one whose connection was revoked', async () => {
    // Purpose: fails if the credential outlives the grant it was issued with.
    const paired = await pair(communityId, people.owner.cookie, ['read', 'administer'], true);
    await expectStatus(
      await h.call(`${tenant()}/me/connection`, { method: 'DELETE', bearer: paired.token }),
      204,
      'disconnect'
    );
    const response = await h.call(`${tenant()}/mutes`, { bearer: paired.administerToken });
    expect(response.status).toBe(401);
  });

  it('refuses a demoted admin on the very next call', async () => {
    // Purpose: fails if the role is read once at pairing instead of live on every call (rule 4).
    const admin = await admit(h, communityId, people.owner.cookie, {
      name: 'Demoted',
      email: 'demoted@administer.test',
    });
    await h.pool.query("UPDATE members SET role='admin' WHERE id=$1", [admin.memberId]);
    const paired = await pair(communityId, admin.cookie, ['read', 'administer'], true);
    await expectStatus(
      await h.call(`${tenant()}/invites`, { bearer: paired.administerToken }),
      200,
      'admin'
    );
    // Straight in the database: the role route also ends the credential (S1, next test), and
    // this one proves the role is read live even while the credential stands.
    await h.pool.query("UPDATE members SET role='member' WHERE id=$1", [admin.memberId]);
    for (const operation of OPERATIONS) {
      const response = await operation.run({ bearer: paired.administerToken });
      expect(response.status, operation.name).toBe(403);
    }
  });

  it('ends a demoted admin’s credential, so promoting them again does not bring it back', async () => {
    // Purpose: fails if demotion only refuses the credential, leaving it to work again after a
    // later promotion the person may not connect with it (#3155 review, S1).
    const admin = await admit(h, communityId, people.owner.cookie, {
      name: 'Demoted admin',
      email: `demoted-${++seq}@administer.test`,
    });
    await h.pool.query("UPDATE members SET role='admin' WHERE id=$1", [admin.memberId]);
    const token = (await pair(communityId, admin.cookie, ['read', 'administer'], true))
      .administerToken!;
    for (const role of ['member', 'admin'])
      await expectStatus(
        await h.call(`${tenant()}/members/${admin.memberId}/role`, {
          cookie: people.owner.cookie,
          method: 'PATCH',
          body: { role },
        }),
        200,
        `role ${role}`
      );
    expect((await h.call(`${tenant()}/invites`, { bearer: token })).status).toBe(401);
    const row = await h.pool.query(
      'SELECT 1 FROM connection_administer_grants WHERE token_hash=$1 AND revoked_at IS NOT NULL',
      [hashSecret(token)]
    );
    expect(row.rowCount).toBe(1);
  });

  it('refuses one whose member left', async () => {
    // Purpose: fails if the credential outlives the membership it was approved from.
    const leaver = await admit(h, communityId, people.owner.cookie, {
      name: 'Leaving admin',
      email: 'leaving@administer.test',
    });
    await h.pool.query("UPDATE members SET role='admin' WHERE id=$1", [leaver.memberId]);
    const paired = await pair(communityId, leaver.cookie, ['read', 'administer'], true);
    const row = await h.pool.query<{ member_id: string }>(
      'SELECT member_id FROM connection_administer_grants WHERE token_hash=$1',
      [hashSecret(paired.administerToken!)]
    );
    expect(row.rows[0]!.member_id).toBe(leaver.memberId);
    await h.pool.query('UPDATE members SET active=false WHERE id=$1', [leaver.memberId]);
    const response = await h.call(`${tenant()}/invites`, { bearer: paired.administerToken });
    expect(response.status).toBe(401);
  });
});
