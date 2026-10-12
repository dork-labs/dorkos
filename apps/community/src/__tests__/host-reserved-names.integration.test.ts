/**
 * Creating a space under a reserved short name (DOR-2848): the one way a reserved name reaches
 * a space, for the host's own official space. Only a key holding `communities:reserved_names`
 * (or a signed-in host operator, who holds every scope) may do it, only for a reserved name no
 * page owns, only with a reason, and only once per name. The address then opens that space and
 * no other; every other path still refuses reserved names.
 *
 * Tests run in order on one host.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CommunityAdminHostApiKeyScopeSchema } from '@dorkos/shared/community-admin-wire';
import { runHostKeyCommand } from '../host-keys.js';
import type { HostApiKeyScope } from '../host/authority.js';
import { reservedBoundShortNames } from '../host/short-names.js';
import {
  bootstrapHost,
  claimAsNewAccount,
  createPendingCommunity,
  expectStatus,
  startTenancyHarness,
  type TenancyHarness,
} from './tenancy-test-harness.js';

const SCOPE = 'communities:reserved_names';
let h: TenancyHarness;
let operatorCookie = '';
let ownerCookie = '';
let reservedKey = '';
let reservedKeyId = '';
let secondReservedKey = '';
let everyOtherScopeKey = '';
let official = '';
let officialClaim = '';

async function issue(label: string, scopes: HostApiKeyScope[]) {
  const issued = await runHostKeyCommand(h.pool, {
    kind: 'issue',
    label,
    scopes,
    expiresInDays: null,
  });
  if (issued.kind !== 'issue') throw new Error('expected a key');
  return { secret: issued.secret, id: issued.key.id };
}

const createReserved = (
  body: Record<string, unknown>,
  auth: { bearer?: string; cookie?: string } = { bearer: reservedKey }
) => h.call('/api/v1/host/communities/reserved-name', { ...auth, body });
const lookup = (name: string) => h.call(`/api/v1/community-names/${name}`);

beforeAll(async () => {
  h = await startTenancyHarness('reserved_names');
  const first = await bootstrapHost(h, 'Operator', 'operator@reserved.test');
  operatorCookie = first.cookie;
  // A second space with its own owner, who is not a host operator.
  const pending = await createPendingCommunity(h, operatorCookie, 'Owned');
  ownerCookie = (await claimAsNewAccount(h, pending.token, 'Owner', 'owner@reserved.test')).cookie;
  const reserved = await issue('Reserved names', [SCOPE]);
  reservedKey = reserved.secret;
  reservedKeyId = reserved.id;
  secondReservedKey = (await issue('Reserved names two', [SCOPE])).secret;
  everyOtherScopeKey = (
    await issue(
      'Everything else',
      CommunityAdminHostApiKeyScopeSchema.options.filter((scope) => scope !== SCOPE)
    )
  ).secret;
}, 60_000);

afterAll(async () => {
  await h?.close();
});

it('keeps refusing a reserved name on the ordinary creation and rename routes', async () => {
  // Purpose: fails if adding the reserved-name route loosened the ordinary paths, so a key
  // that creates spaces could take the host's name.
  const created = await h.call('/api/v1/host/communities', {
    bearer: everyOtherScopeKey,
    body: { idempotencyKey: 'plain-dorkos', name: 'Fake official', shortName: 'dorkos' },
  });
  expect(created.status).toBe(409);
  expect((await created.json()).code).toBe('SHORT_NAME_RESERVED');
  const someone = (await h.pool.query<{ id: string }>('SELECT id FROM communities LIMIT 1')).rows[0]
    .id;
  const renamed = await h.call(`/api/v1/host/communities/${someone}/short-name`, {
    method: 'PUT',
    bearer: everyOtherScopeKey,
    body: { shortName: 'official' },
  });
  expect(renamed.status).toBe(409);
  expect((await renamed.json()).code).toBe('SHORT_NAME_RESERVED');
});

it('refuses every caller without the reserved-name scope', async () => {
  // Purpose: fails if any other scope, a member or owner session, or no credential at all
  // could create a space under a reserved name.
  const body = { idempotencyKey: 'no-scope', name: 'DorkOS', shortName: 'dorkos', reason: 'x' };
  const otherKey = await createReserved(body, { bearer: everyOtherScopeKey });
  expect(otherKey.status).toBe(403);
  expect((await otherKey.json()).code).toBe('FORBIDDEN');
  expect((await createReserved(body, { cookie: ownerCookie })).status).toBe(403);
  expect((await createReserved(body, {})).status).toBe(401);
  expect((await createReserved(body, { bearer: 'dkh_not-a-real-key' })).status).toBe(401);
  expect(
    (await h.pool.query("SELECT 1 FROM community_short_names WHERE short_name='dorkos'")).rowCount
  ).toBe(0);
  expect((await h.pool.query('SELECT 1 FROM reserved_name_grants')).rowCount).toBe(0);
});

it('refuses a missing reason, a name that is not reserved, and a reserved path', async () => {
  // Purpose: fails if the route gives out a name without saying why, can be used to skip the
  // ordinary checks for an ordinary name, or can give a space a path the server owns.
  const base = { idempotencyKey: 'refusals', name: 'DorkOS', shortName: 'dorkos' };
  expect((await createReserved(base)).status).toBe(400);
  expect((await createReserved({ ...base, reason: '   ' })).status).toBe(400);
  expect((await createReserved({ ...base, reason: 'x'.repeat(201) })).status).toBe(400);
  const { shortName: _omitted, ...nameless } = base;
  expect((await createReserved({ ...nameless, reason: 'Official' })).status).toBe(400);
  const ordinary = await createReserved({ ...base, shortName: 'plain-name', reason: 'Official' });
  expect(ordinary.status).toBe(409);
  expect((await ordinary.json()).code).toBe('STATE_CONFLICT');
  for (const path of ['api', 'host', 'admin', 'join']) {
    const refused = await createReserved({ ...base, shortName: path, reason: 'Official' });
    expect(refused.status, path).toBe(409);
    expect((await refused.json()).code, path).toBe('SHORT_NAME_RESERVED');
  }
  expect((await h.pool.query('SELECT 1 FROM reserved_name_grants')).rowCount).toBe(0);
});

it('creates the space under the reserved name, records why, and audits the key', async () => {
  // Purpose: fails if the creation is not the ordinary unclaimed space with an owner claim, or
  // if the grant's reason and the acting key are not recorded.
  const created = await expectStatus(
    await createReserved({
      idempotencyKey: 'official-space',
      name: 'DorkOS',
      shortName: 'DorkOS',
      admissionPolicy: 'open',
      reason: 'The official DorkOS space',
    }),
    201,
    'create the official space'
  );
  expect(created.headers.get('cache-control')).toBe('no-store');
  const body = await created.json();
  official = body.community.id;
  officialClaim = body.ownerClaimToken;
  expect(body.community).toMatchObject({ shortName: 'dorkos', lifecycle: 'pending_owner' });
  expect(officialClaim).toEqual(expect.any(String));
  const grants = await h.pool.query(
    'SELECT short_name,community_id,reason,granted_by_host_actor FROM reserved_name_grants'
  );
  expect(grants.rows).toEqual([
    {
      short_name: 'dorkos',
      community_id: official,
      reason: 'The official DorkOS space',
      granted_by_host_actor: `api_key:${reservedKeyId}`,
    },
  ]);
  const audit = await h.pool.query(
    `SELECT actor_kind,actor_api_key_id,next_state,changed_fields FROM host_audit_events
     WHERE action='community.create_reserved_name' AND community_id=$1`,
    [official]
  );
  expect(audit.rows).toEqual([
    {
      actor_kind: 'api_key',
      actor_api_key_id: reservedKeyId,
      next_state: 'pending_owner',
      changed_fields: [
        'name',
        'description',
        'admission_policy',
        'short_name',
        'reserved_name_grant',
      ],
    },
  ]);
});

it('opens the space at its reserved address once it is claimed, and no other reserved name', async () => {
  // Purpose: fails if a granted reserved name never opens its space (the point of giving it),
  // opens it before an owner claims it, or if another reserved name now resolves too.
  expect((await lookup('dorkos')).status).toBe(404);
  await claimAsNewAccount(h, officialClaim, 'Official Owner', 'official@reserved.test');
  expect(await (await expectStatus(await lookup('dorkos'), 200, 'lookup')).json()).toEqual({
    communityId: official,
    shortName: 'dorkos',
  });
  expect((await lookup('official')).status).toBe(404);
  expect(await reservedBoundShortNames(h.pool, h.config.reservedShortNames)).toEqual([]);
});

it('replays the same request, and refuses a second space under the same name', async () => {
  // Purpose: fails if a retry makes a second space, if the ordinary route can replay the
  // reserved receipt, or if a second creation could squat or move the name.
  const replay = await expectStatus(
    await createReserved({
      idempotencyKey: 'official-space',
      name: 'DorkOS',
      shortName: 'dorkos',
      admissionPolicy: 'open',
      reason: 'The official DorkOS space',
    }),
    200,
    'replay'
  );
  expect(await replay.json()).toMatchObject({
    replayed: true,
    ownerClaimToken: null,
    community: { id: official },
  });
  const ordinaryReplay = await h.call('/api/v1/host/communities', {
    bearer: everyOtherScopeKey,
    body: {
      idempotencyKey: 'official-space',
      name: 'DorkOS',
      shortName: 'dorkos',
      admissionPolicy: 'open',
    },
  });
  expect((await ordinaryReplay.json()).code).toBe('IDEMPOTENCY_CONFLICT');
  const second = await createReserved(
    { idempotencyKey: 'official-again', name: 'Impostor', shortName: 'dorkos', reason: 'Again' },
    { bearer: secondReservedKey }
  );
  expect(second.status).toBe(409);
  expect((await second.json()).code).toBe('SHORT_NAME_TAKEN');
  expect(
    (await h.pool.query("SELECT community_id FROM community_short_names WHERE short_name='dorkos'"))
      .rows
  ).toEqual([{ community_id: official }]);
  expect((await h.pool.query('SELECT 1 FROM reserved_name_grants')).rowCount).toBe(1);
});

it('creates one space when two requests race for the same reserved name', async () => {
  // Purpose: fails if two concurrent creations could both bind the name, or leave a grant or
  // a space behind for the one that lost.
  const before = (await h.pool.query('SELECT count(*)::int AS n FROM communities')).rows[0].n;
  const race = await Promise.all(
    [reservedKey, secondReservedKey].map((bearer, i) =>
      createReserved(
        { idempotencyKey: `race-${i}`, name: `Racer ${i}`, shortName: 'official', reason: 'Race' },
        { bearer }
      )
    )
  );
  expect(race.map((response) => response.status).sort()).toEqual([201, 409]);
  const loser = race.find((response) => response.status === 409)!;
  expect((await loser.json()).code).toBe('SHORT_NAME_TAKEN');
  expect((await h.pool.query('SELECT count(*)::int AS n FROM communities')).rows[0].n).toBe(
    before + 1
  );
  expect(
    (await h.pool.query("SELECT 1 FROM reserved_name_grants WHERE short_name='official'")).rowCount
  ).toBe(1);
});

it('gives out a name the host reserved for itself, and a host operator may do it too', async () => {
  // Purpose: fails if the host's own additions cannot be given out, or if a signed-in host
  // operator (who holds every scope) is refused.
  h.config.reservedShortNames.add('our-brand');
  const created = await expectStatus(
    await createReserved(
      { idempotencyKey: 'our-brand', name: 'Our brand', shortName: 'our-brand', reason: 'Ours' },
      { cookie: operatorCookie }
    ),
    201,
    'operator gives out the host’s own name'
  );
  expect((await created.json()).community.shortName).toBe('our-brand');
  expect(
    (
      await h.pool.query(
        "SELECT granted_by_host_actor FROM reserved_name_grants WHERE short_name='our-brand'"
      )
    ).rows[0].granted_by_host_actor
  ).toMatch(/^person:/);
});

it('still reports, and never opens, a reserved name a space took before it was reserved', async () => {
  // Purpose: fails if the grant check let any reserved name a space holds open it, rather than
  // only the one a host operator gave that space.
  const pending = await createPendingCommunity(h, operatorCookie, 'Early bird');
  await expectStatus(
    await h.call(`/api/v1/host/communities/${pending.communityId}/short-name`, {
      method: 'PUT',
      bearer: everyOtherScopeKey,
      body: { shortName: 'early-brand' },
    }),
    200,
    'name it before it is reserved'
  );
  await claimAsNewAccount(h, pending.token, 'Early Owner', 'early@reserved.test');
  expect((await lookup('early-brand')).status).toBe(200);
  h.config.reservedShortNames.add('early-brand');
  expect((await lookup('early-brand')).status).toBe(404);
  expect(await reservedBoundShortNames(h.pool, h.config.reservedShortNames)).toEqual([
    { shortName: 'early-brand', communityId: pending.communityId },
  ]);
});
