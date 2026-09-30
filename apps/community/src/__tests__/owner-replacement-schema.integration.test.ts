/**
 * The owner replacement storage and scope (specs/community-owner-replacement, "Data model" and
 * "Scope and authority"; DOR-2538): the database refuses every row shape the spec rules out, a
 * key can hold `communities:ownership`, the host projection shows the open replacement, and a
 * deleted community takes its replacements with it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommunityAdminHostProjectionSchema } from '@dorkos/shared/community-admin-wire';
import type { CommunityAuth } from '../auth.js';
import { sweepCommunityDeletions } from '../deletion-worker.js';
import { createHostAuthority, type HostApiKeyScope } from '../host/authority.js';
import { parseHostKeyCommand, runHostKeyCommand } from '../host-keys.js';
import { ApiError } from '../http.js';
import { COMMUNITY_MIGRATIONS, migrate } from '../migrate.js';
import {
  TENANCY_PASSWORD,
  bootstrapHost,
  expectStatus,
  startTenancyHarness,
  type TenancyHarness,
} from './tenancy-test-harness.js';

let h: TenancyHarness;
let operatorCookie = '';
/** The bootstrapped community, owned by the host operator. */
let a = { id: '', owner: '' };
/** A second community, made directly in the database. */
let b = { id: '', owner: '' };

const hex = () => createHash('sha256').update(randomUUID()).digest('hex');

async function ownerOf(communityId: string): Promise<string> {
  return (
    await h.pool.query<{ id: string }>(
      "SELECT id FROM members WHERE community_id=$1 AND role='owner' AND active",
      [communityId]
    )
  ).rows[0].id;
}

async function createCommunity(name: string): Promise<string> {
  const client = await h.pool.connect();
  const userId = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [
      userId,
      name,
      `${userId}@example.test`,
    ]);
    const community = await client.query<{ id: string }>(
      "INSERT INTO communities(name,lifecycle) VALUES($1,'pending_owner') RETURNING id",
      [name]
    );
    await client.query(
      `INSERT INTO members(community_id,user_id,display_name,handle,role)
       VALUES($1,$2,$3,'owner-b','owner')`,
      [community.rows[0].id, userId, name]
    );
    await client.query(
      "UPDATE communities SET lifecycle='active',activated_at=now(),lifecycle_version=2 WHERE id=$1",
      [community.rows[0].id]
    );
    await client.query('COMMIT');
    return community.rows[0].id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

type Row = Record<string, unknown>;

const DAY = 24 * 60 * 60_000;
const requestedAt = new Date('2026-10-01T12:00:00Z');
const resolvedAt = new Date(requestedAt.getTime() + 60_000);
const claimableAfter = new Date(resolvedAt.getTime() + 30 * DAY);
const claimExpiresAt = new Date(claimableAfter.getTime() + 14 * DAY);
const endedAt = new Date(claimableAfter.getTime() + DAY);

/** A valid `notifying` row for `community`, with `overrides` applied. */
function notifying(community: { id: string; owner: string }, overrides: Row = {}): Row {
  return {
    community_id: community.id,
    state: 'notifying',
    reason: 'owner_unreachable',
    reference: null,
    claimant_named: false,
    claimant_oidc_issuer: null,
    claimant_oidc_subject: null,
    claim_token_hash: hex(),
    requested_by_host_actor: 'api_key:6f2d0c4e-0c0a-4f7e-9a51-0d9d6b6a1c11',
    idempotency_key: randomUUID(),
    payload_hash: hex(),
    after_objection: false,
    after_withdrawal: false,
    prior_owner_member_id: community.owner,
    requested_at: requestedAt,
    ...overrides,
  };
}

/** The columns a request has once its notice resolved and the wait started. */
const waitingFields: Row = {
  state: 'waiting',
  notice_state: 'accepted',
  notice_resolved_at: resolvedAt,
  verified_address: false,
  claimable_after: claimableAfter,
};
/** The columns a request has once its claim window opened. */
const claimableFields: Row = {
  ...waitingFields,
  state: 'claimable',
  claim_expires_at: claimExpiresAt,
};
/** Closing a request: its end date, no live claim token, and a cause when withdrawn. */
const closed = (state: string, from: Row = {}): Row => ({
  ...from,
  state,
  withdrawn_cause: state === 'withdrawn' ? 'cancelled' : null,
  ended_at: endedAt,
  claim_token_hash: null,
});

async function insert(row: Row): Promise<string> {
  const columns = Object.keys(row);
  const result = await h.pool.query<{ id: string }>(
    `INSERT INTO owner_replacements(${columns.join(',')})
     VALUES(${columns.map((_, index) => `$${index + 1}`).join(',')}) RETURNING id`,
    Object.values(row)
  );
  return result.rows[0].id;
}

async function clear(): Promise<void> {
  await h.pool.query('DELETE FROM owner_replacements');
}

/** Expect `work` to fail on the named constraint, and nothing else. */
async function refusedBy(work: Promise<unknown>, constraint: string): Promise<void> {
  await expect(work).rejects.toMatchObject({ constraint });
}

beforeAll(async () => {
  h = await startTenancyHarness('owner_replacement');
  const host = await bootstrapHost(h, 'Operator', 'operator@replacement.test');
  operatorCookie = host.cookie;
  a = { id: host.communityId, owner: await ownerOf(host.communityId) };
  const bId = await createCommunity('Second');
  b = { id: bId, owner: await ownerOf(bId) };
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('owner_replacements', () => {
  // Purpose: fails if a check is so tight that a state the spec allows cannot be stored; every
  // refusal below is only meaningful beside this.
  it('stores every open and closed state in its allowed shape', async () => {
    await clear();
    const shapes: Row[] = [
      notifying(a),
      notifying(a, waitingFields),
      notifying(a, claimableFields),
      notifying(a, {
        ...closed('completed', claimableFields),
        new_owner_member_id: a.owner,
      }),
      notifying(a, closed('expired', claimableFields)),
      // Closed before the notice resolved: no date at all.
      notifying(a, closed('objected')),
      notifying(a, closed('withdrawn')),
      notifying(a, closed('superseded')),
      // Closed while waiting or claimable: the dates stay.
      notifying(a, closed('objected', waitingFields)),
      notifying(a, closed('withdrawn', claimableFields)),
      notifying(a, { ...closed('withdrawn'), withdrawn_cause: 'suspended' }),
      notifying(a, { ...closed('withdrawn', waitingFields), withdrawn_cause: 'deletion' }),
      // A named request once closed: the identity is cleared, the flag stays for the list.
      notifying(a, {
        ...closed('completed', claimableFields),
        new_owner_member_id: a.owner,
        claimant_named: true,
      }),
      notifying(a, {
        ...closed('superseded', waitingFields),
        claimant_named: true,
        claimant_oidc_issuer: 'https://idp.example',
        claimant_oidc_subject: 'subject-1',
        reminder_queued_at: resolvedAt,
        claim_reissued_at: resolvedAt,
        reference: 'CASE-123 #4.5_x',
        requested_by_host_actor: 'person:u_7Kq9',
      }),
    ];
    for (const row of shapes) {
      const id = await insert(row);
      // One open per community, so each open shape is removed before the next.
      if (['notifying', 'waiting', 'claimable'].includes(row.state as string))
        await h.pool.query('DELETE FROM owner_replacements WHERE id=$1', [id]);
    }
    expect(
      (await h.pool.query('SELECT count(*)::int AS n FROM owner_replacements')).rows[0].n
    ).toBe(shapes.length - 3);
  });

  // Purpose: fails if the partial unique index is missing or covers closed states.
  it('allows one open request per community, beside any number of closed ones', async () => {
    await clear();
    await insert(notifying(a, closed('withdrawn')));
    await insert(notifying(a, closed('objected')));
    await insert(notifying(a));
    await insert(notifying(b));
    await refusedBy(insert(notifying(a, waitingFields)), 'owner_replacements_open_unique');
    await refusedBy(insert(notifying(a, claimableFields)), 'owner_replacements_open_unique');
  });

  // Purpose: fails if idempotency is global (the same key in another community refused) or
  // missing (the same key twice in one community accepted).
  it('scopes the idempotency key to the community and actor', async () => {
    await clear();
    const key = { idempotency_key: 'same-key' };
    await insert(notifying(a, key));
    await insert(notifying(b, key));
    await refusedBy(
      insert(notifying(a, { ...key, ...closed('withdrawn') })),
      'owner_replacements_idempotency'
    );
    // Another actor with the same key is its own request.
    await insert(
      notifying(a, {
        ...key,
        ...closed('withdrawn'),
        requested_by_host_actor: 'person:another',
      })
    );
  });

  // Purpose: fails if the reference could be stored as a link, markup, a second line, or long.
  it.each([
    ['a colon', 'https:evil'],
    ['a slash', 'a/b'],
    ['markup', '<b>x</b>'],
    ['a newline', 'ABC\n123'],
    ['81 characters', 'a'.repeat(81)],
    ['nothing', ''],
  ])('refuses a reference with %s', async (_, reference) => {
    await clear();
    await refusedBy(insert(notifying(a, { reference })), 'owner_replacements_reference_check');
  });

  // Purpose: each fails if the named shape check is missing or loosened.
  it.each<[string, () => Row, string]>([
    [
      'a completed request without its new owner',
      () => notifying(a, closed('completed', claimableFields)),
      'owner_replacements_new_owner',
    ],
    [
      'an open request with a new owner',
      () => notifying(a, { ...claimableFields, new_owner_member_id: a.owner }),
      'owner_replacements_new_owner',
    ],
    [
      'a closed request with a claim token',
      () => notifying(a, { ...closed('withdrawn'), claim_token_hash: hex() }),
      'owner_replacements_claim_token',
    ],
    [
      'an open request without a claim token',
      () => notifying(a, { claim_token_hash: null }),
      'owner_replacements_claim_token',
    ],
    [
      'a subject without an issuer',
      () =>
        notifying(a, {
          ...closed('objected'),
          claimant_named: true,
          claimant_oidc_subject: 'subject-1',
        }),
      'owner_replacements_claimant',
    ],
    [
      'an issuer without a subject',
      () =>
        notifying(a, {
          ...closed('objected'),
          claimant_named: true,
          claimant_oidc_issuer: 'https://idp.example',
        }),
      'owner_replacements_claimant',
    ],
    [
      'a subject longer than 255 characters',
      () =>
        notifying(a, {
          claimant_named: true,
          claimant_oidc_issuer: 'https://idp.example',
          claimant_oidc_subject: 's'.repeat(256),
        }),
      'owner_replacements_claimant_oidc_subject_check',
    ],
    [
      'a date while still notifying',
      () => notifying(a, { claimable_after: claimableAfter }),
      'owner_replacements_claimable_after',
    ],
    [
      'waiting with no date',
      () => notifying(a, { ...waitingFields, claimable_after: null }),
      'owner_replacements_claimable_after',
    ],
    [
      'waiting before the notice resolved',
      () => notifying(a, { ...waitingFields, notice_state: 'pending', notice_resolved_at: null }),
      'owner_replacements_waiting',
    ],
    [
      'a resolved notice with no date',
      () => notifying(a, { notice_state: 'failed' }),
      'owner_replacements_notice',
    ],
    [
      'a pending notice with a date',
      () => notifying(a, { notice_resolved_at: resolvedAt }),
      'owner_replacements_notice',
    ],
    [
      'claimable with no claim window',
      () => notifying(a, { ...claimableFields, claim_expires_at: null }),
      'owner_replacements_claim_window',
    ],
    [
      'a claim window while waiting',
      () => notifying(a, { ...waitingFields, claim_expires_at: claimExpiresAt }),
      'owner_replacements_claim_window',
    ],
    [
      'a claim window that ends before it opens',
      () => notifying(a, { ...claimableFields, claim_expires_at: claimableAfter }),
      'owner_replacements_claim_window',
    ],
    [
      'expired without a claim window',
      () => notifying(a, closed('expired', waitingFields)),
      'owner_replacements_claim_window',
    ],
    [
      'a reminder with no date',
      () => notifying(a, { reminder_queued_at: resolvedAt }),
      'owner_replacements_reminder',
    ],
    [
      'an open request with an end date',
      () => notifying(a, { ...waitingFields, ended_at: endedAt }),
      'owner_replacements_ended',
    ],
    [
      'a closed request with no end date',
      () => notifying(a, { ...closed('objected'), ended_at: null }),
      'owner_replacements_ended',
    ],
    [
      'an open request that names an account without its identity',
      () => notifying(a, { claimant_named: true }),
      'owner_replacements_claimant_named',
    ],
    [
      'an open request with an identity it does not name',
      () =>
        notifying(a, {
          claimant_oidc_issuer: 'https://idp.example',
          claimant_oidc_subject: 'subject-1',
        }),
      'owner_replacements_claimant_named',
    ],
    [
      'a closed request with an identity it did not name',
      () =>
        notifying(a, {
          ...closed('expired', claimableFields),
          claimant_oidc_issuer: 'https://idp.example',
          claimant_oidc_subject: 'subject-1',
        }),
      'owner_replacements_claimant_named',
    ],
    [
      'a withdrawn request without its cause',
      () => notifying(a, { ...closed('withdrawn'), withdrawn_cause: null }),
      'owner_replacements_withdrawn_cause',
    ],
    [
      'a cause on a request that was not withdrawn',
      () => notifying(a, { ...closed('objected'), withdrawn_cause: 'cancelled' }),
      'owner_replacements_withdrawn_cause',
    ],
    [
      'an unknown withdrawal cause',
      () => notifying(a, { ...closed('withdrawn'), withdrawn_cause: 'expired' }),
      'owner_replacements_withdrawn_cause_check',
    ],
    [
      'an unknown state',
      () => notifying(a, { state: 'paused', claim_token_hash: null }),
      'owner_replacements_state_check',
    ],
    [
      'an unknown reason',
      () => notifying(a, { reason: 'dispute' }),
      'owner_replacements_reason_check',
    ],
    [
      'a claim token that is not a hash',
      () => notifying(a, { claim_token_hash: 'plain-token' }),
      'owner_replacements_claim_token_hash_check',
    ],
    [
      'a requester that is not a host actor',
      () => notifying(a, { requested_by_host_actor: 'member:owner' }),
      'owner_replacements_requested_by_host_actor_check',
    ],
  ])('refuses %s', async (_, row, constraint) => {
    await clear();
    await refusedBy(insert(row()), constraint);
  });

  // Purpose: fails if a replacement could point at a member of another community.
  it('binds the prior and new owner to the same community', async () => {
    await clear();
    await refusedBy(
      insert(notifying(a, { prior_owner_member_id: b.owner })),
      'owner_replacements_prior_owner_tenant_fk'
    );
    await refusedBy(
      insert(
        notifying(a, { ...closed('completed', claimableFields), new_owner_member_id: b.owner })
      ),
      'owner_replacements_new_owner_tenant_fk'
    );
  });

  // Purpose: fails if one claim token hash could open two requests.
  it('keeps claim token hashes unique across communities', async () => {
    await clear();
    const hash = hex();
    await insert(notifying(a, { claim_token_hash: hash }));
    await refusedBy(
      insert(notifying(b, { claim_token_hash: hash })),
      'owner_replacements_claim_token_hash_key'
    );
  });
});

describe('owner_replacement_object_tokens', () => {
  async function token(row: Row): Promise<void> {
    const columns = Object.keys(row);
    await h.pool.query(
      `INSERT INTO owner_replacement_object_tokens(${columns.join(',')})
       VALUES(${columns.map((_, index) => `$${index + 1}`).join(',')})`,
      Object.values(row)
    );
  }

  // Purpose: fails if a token hash could be shared, stored in plain text, bound to another
  // community's request, or outlive its request.
  it('stores unique hashes bound to their own community and request', async () => {
    await clear();
    const replacementA = await insert(notifying(a));
    const replacementB = await insert(notifying(b));
    const hash = hex();
    // Two send attempts for one request each get a token, and a failed one is kept.
    await token({
      created_at: requestedAt,
      replacement_id: replacementA,
      community_id: a.id,
      token_hash: hash,
    });
    await token({
      created_at: requestedAt,
      replacement_id: replacementA,
      community_id: a.id,
      token_hash: hex(),
    });
    await refusedBy(
      token({
        created_at: requestedAt,
        replacement_id: replacementB,
        community_id: b.id,
        token_hash: hash,
      }),
      'owner_replacement_object_tokens_token_hash_key'
    );
    await refusedBy(
      token({
        created_at: requestedAt,
        replacement_id: replacementA,
        community_id: a.id,
        token_hash: 'plain-token',
      }),
      'owner_replacement_object_tokens_token_hash_check'
    );
    await refusedBy(
      token({
        created_at: requestedAt,
        replacement_id: replacementA,
        community_id: b.id,
        token_hash: hex(),
      }),
      'owner_replacement_object_tokens_tenant_fk'
    );
    // The date comes from the caller's clock; the table supplies none.
    await expect(
      token({ replacement_id: replacementA, community_id: a.id, token_hash: hex() })
    ).rejects.toMatchObject({ code: '23502', column: 'created_at' });
    await h.pool.query('DELETE FROM owner_replacements WHERE id=$1', [replacementA]);
    expect(
      (
        await h.pool.query(
          'SELECT 1 FROM owner_replacement_object_tokens WHERE replacement_id=$1',
          [replacementA]
        )
      ).rowCount
    ).toBe(0);
  });
});

describe('the communities:ownership scope', () => {
  async function insertKey(scopes: string[]): Promise<void> {
    const prefix = `dkh_${randomUUID().replaceAll('-', '').slice(0, 6)}`;
    await h.pool.query(
      `INSERT INTO host_api_keys(label,prefix,secret_hash,scopes,issued_via)
       VALUES('Scope test',$1,$2,$3,'command')`,
      [prefix, hex(), scopes]
    );
  }

  const every = [
    'communities:read',
    'communities:write',
    'communities:lifecycle',
    'communities:import',
    'communities:legal_hold',
    'communities:takedown',
    'communities:ownership',
    'communities:erasure_journal',
  ];

  // Purpose: fails if the database refuses the new scope, accepts an unknown one, or does not
  // hold the ceiling at every scope once.
  it('is accepted on a key, alone or with every other scope, and no more', async () => {
    await insertKey(['communities:ownership']);
    await insertKey(every);
    await refusedBy(insertKey(['communities:owner']), 'host_api_keys_scopes');
    await refusedBy(insertKey([...every, 'communities:read']), 'host_api_keys_scopes');
  });

  // Purpose: fails if the offline command cannot issue the scope, if the key it issues does not
  // pass the ownership check, or if another scope (lifecycle above all) implies it.
  it('is issued by the offline command, and no other scope implies it', async () => {
    const authority = createHostAuthority({
      // A key never reaches the session path, which is the only use of `auth`.
      auth: {} as CommunityAuth,
      pool: h.pool,
      now: () => new Date(),
      limitKeyMiss: () => undefined,
    });
    const app = new Hono();
    app.get('/:scope', async (c) => {
      try {
        await authority.require(c, c.req.param('scope') as HostApiKeyScope);
        return c.body(null, 204);
      } catch (error) {
        if (error instanceof ApiError) return c.body(null, error.status as 401 | 403);
        throw error;
      }
    });
    const issue = async (scope: string) => {
      const result = await runHostKeyCommand(
        h.pool,
        parseHostKeyCommand(['issue', '--label', scope, '--scope', scope])
      );
      if (result.kind !== 'issue') throw new Error('expected an issued key');
      return result.secret;
    };
    const status = async (secret: string, scope: string) =>
      (await app.request(`/${scope}`, { headers: { authorization: `Bearer ${secret}` } })).status;

    const ownership = await issue('communities:ownership');
    expect(await status(ownership, 'communities:ownership')).toBe(204);
    expect(await status(ownership, 'communities:lifecycle')).toBe(403);
    for (const other of [
      'communities:read',
      'communities:write',
      'communities:lifecycle',
      'communities:import',
      'communities:legal_hold',
    ]) {
      expect(await status(await issue(other), 'communities:ownership')).toBe(403);
    }
  });
});

describe('the host projection', () => {
  async function projected(): Promise<unknown> {
    const response = await expectStatus(
      await h.call(`/api/v1/host/communities/${a.id}`, { cookie: operatorCookie }),
      200,
      'read community'
    );
    const body = CommunityAdminHostProjectionSchema.parse(await response.json());
    return body.ownerReplacement;
  }

  // Purpose: fails if the projection omits an open replacement, shows a closed one, or carries
  // any detail beyond its id, state, and date.
  it('shows only the open replacement', async () => {
    await clear();
    expect(await projected()).toBeNull();
    await insert(notifying(a, closed('objected', waitingFields)));
    expect(await projected()).toBeNull();
    const open = await insert(notifying(a, { reference: 'CASE-9' }));
    expect(await projected()).toEqual({
      replacementId: open,
      state: 'notifying',
      claimableAfter: null,
    });
    await h.pool.query(
      `UPDATE owner_replacements SET state='waiting',notice_state='accepted',
         notice_resolved_at=$2,claimable_after=$3 WHERE id=$1`,
      [open, resolvedAt, claimableAfter]
    );
    expect(await projected()).toEqual({
      replacementId: open,
      state: 'waiting',
      claimableAfter: claimableAfter.toISOString(),
    });
    // The list reads the same projection.
    const list = await expectStatus(
      await h.call('/api/v1/host/communities', { cookie: operatorCookie }),
      200,
      'list communities'
    );
    const listed = (await list.json()) as {
      communities: { id: string; ownerReplacement: unknown }[];
    };
    expect(listed.communities.find((row) => row.id === b.id)?.ownerReplacement).toBeNull();
    expect(listed.communities.find((row) => row.id === a.id)?.ownerReplacement).toMatchObject({
      replacementId: open,
    });
  });
});

describe('deleting a community', () => {
  // Purpose: fails if the deletion worker leaves a replacement or an object token behind, or
  // if either blocks the tenant's deletion.
  it('deletes its replacements and object tokens with it', async () => {
    await clear();
    const open = await insert(notifying(a));
    await insert(notifying(a, closed('objected')));
    await h.pool.query(
      `INSERT INTO owner_replacement_object_tokens(replacement_id,community_id,token_hash,created_at)
       VALUES($1,$2,$3,$4)`,
      [open, a.id, hex(), requestedAt]
    );
    const keptInB = await insert(notifying(b));
    const version = (
      await h.pool.query<{ lifecycle_version: number }>(
        'SELECT lifecycle_version FROM communities WHERE id=$1',
        [a.id]
      )
    ).rows[0].lifecycle_version;
    await expectStatus(
      await h.call(`/api/v1/communities/${a.id}/owner/deletion`, {
        cookie: operatorCookie,
        body: {
          lifecycleVersion: version,
          password: TENANCY_PASSWORD,
          confirmName: 'Operator Community',
          confirmIdSuffix: a.id.slice(-8),
        },
      }),
      200,
      'owner deletion request'
    );
    await h.pool.query(
      `UPDATE community_deletion_jobs SET delete_after=now()-interval '1 second',
         next_attempt_at=now() WHERE community_id=$1`,
      [a.id]
    );
    let completed = 0;
    for (let pass = 0; pass < 10 && !completed; pass++) {
      completed = (await sweepCommunityDeletions(h.pool, h.blobStore, 100)).completed;
      await h.pool.query('UPDATE community_deletion_jobs SET next_attempt_at=now()');
    }
    expect(completed).toBe(1);
    expect(
      (await h.pool.query('SELECT id FROM owner_replacements')).rows.map((row) => row.id)
    ).toEqual([keptInB]);
    expect((await h.pool.query('SELECT 1 FROM owner_replacement_object_tokens')).rowCount).toBe(0);
  });
});

describe('upgrading', () => {
  // Purpose: fails if the migration drops a scope an existing key holds (its new check would
  // refuse to apply, or the key would stop matching), or if a pre-existing key cannot be
  // joined by an ownership key afterwards.
  it('keeps every existing key and adds the scope', async () => {
    const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL!;
    const admin = new Pool({ connectionString: adminUrl });
    const name = `community_owner_replacement_upgrade_${randomUUID().replaceAll('-', '')}`;
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const db = new Pool({ connectionString: url.toString() });
    try {
      await db.query(
        'CREATE TABLE community_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
      );
      for (const [version, filename] of COMMUNITY_MIGRATIONS) {
        if (filename === '0022_owner_replacements.sql') break;
        await db.query(
          await readFile(
            fileURLToPath(new URL(`../../migrations/${filename}`, import.meta.url)),
            'utf8'
          )
        );
        await db.query('INSERT INTO community_migrations(version) VALUES($1)', [version]);
      }
      const existing = (
        await db.query<{ id: string }>(
          `INSERT INTO host_api_keys(label,prefix,secret_hash,scopes,issued_via)
           VALUES('Before','dkh_before',$1,
             ARRAY['communities:read','communities:write','communities:lifecycle',
                   'communities:import','communities:legal_hold'],'command')
           RETURNING id`,
          [hex()]
        )
      ).rows[0].id;

      await migrate(url.toString());

      expect(
        (await db.query('SELECT scopes FROM host_api_keys WHERE id=$1', [existing])).rows
      ).toEqual([
        {
          scopes: [
            'communities:read',
            'communities:write',
            'communities:lifecycle',
            'communities:import',
            'communities:legal_hold',
          ],
        },
      ]);
      await db.query(
        `INSERT INTO host_api_keys(label,prefix,secret_hash,scopes,issued_via)
         VALUES('After','dkh_after0',$1,ARRAY['communities:ownership'],'command')`,
        [hex()]
      );
      expect((await db.query('SELECT count(*)::int AS n FROM owner_replacements')).rows[0].n).toBe(
        0
      );
    } finally {
      await db.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
    }
  });
});
