/**
 * Reading the erasure journal through the host API (DOR-2566): the scope that allows it, paging
 * that never skips a row while erasures commit concurrently, an empty journal, cursors that
 * notice a restore, isolation between two hosts, and that a real erasure's line carries ids only.
 *
 * The restore rehearsal (an erasure made after a backup, re-applied from the pulled copy) is in
 * member-erasure-recovery.integration.test.ts, beside the backup helpers it reuses.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommunityAdminErasureJournalPageSchema,
  CommunityAdminHostApiKeyScopeSchema,
  type CommunityAdminErasureJournalPageSchema as PageSchema,
} from '@dorkos/shared/community-admin-wire';
import type { z } from 'zod';
import { eraseMembership } from '../erasure/erasure.js';
import {
  appendJournalRow,
  pruneErasureJournal,
  type ErasureJournalRecord,
} from '../erasure/journal.js';
import { runHostKeyCommand } from '../host-keys.js';
import type { HostApiKeyScope } from '../host/authority.js';
import { body, hoursFromNow, PASSWORD, runErasures } from './member-erasure-fixture.js';
import { makeScene, requestErasure } from './member-erasure-scenes.js';
import {
  bootstrapHost,
  createPendingCommunity,
  preflightOwnerClaim,
  startTenancyHarness,
  TENANCY_PASSWORD,
  waitForLockWaiters,
  type TenancyHarness,
} from './tenancy-test-harness.js';

type Page = z.infer<typeof PageSchema>;

const SCOPE = 'communities:erasure_journal';
let h: TenancyHarness;
let other: TenancyHarness;
let operatorCookie: string;
let journalKey: string;

async function issue(harness: TenancyHarness, scopes: HostApiKeyScope[]): Promise<string> {
  const issued = await runHostKeyCommand(harness.pool, {
    kind: 'issue',
    label: `Journal test ${scopes.length}`,
    scopes,
    expiresInDays: null,
  });
  if (issued.kind !== 'issue') throw new Error('expected a key');
  return issued.secret;
}

function read(
  harness: TenancyHarness,
  query: { cursor?: string; limit?: number | string } = {},
  auth: { bearer?: string; cookie?: string } = { bearer: journalKey }
) {
  const params = new URLSearchParams();
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const search = params.size ? `?${params}` : '';
  return harness.call(`/api/v1/host/erasure-journal${search}`, auth);
}

async function page(
  harness: TenancyHarness,
  query: { cursor?: string; limit?: number } = {},
  bearer = journalKey
): Promise<Page> {
  return CommunityAdminErasureJournalPageSchema.parse(
    await body(await read(harness, query, { bearer }), 200, 'journal page')
  );
}

/** Read from `cursor` to the end, `limit` at a time. */
async function drain(harness: TenancyHarness, cursor?: string, limit = 3, bearer = journalKey) {
  const lines: Page['lines'] = [];
  for (;;) {
    const next = await page(harness, { cursor, limit }, bearer);
    lines.push(...next.lines);
    cursor = next.nextCursor;
    if (!next.hasMore) return { lines, cursor };
  }
}

async function append(harness: TenancyHarness, record: ErasureJournalRecord): Promise<void> {
  const client = await harness.pool.connect();
  try {
    await client.query('BEGIN');
    await appendJournalRow(client, record);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

const member = () => ({
  kind: 'member' as const,
  communityId: randomUUID(),
  memberId: randomUUID(),
});
const lineOf = (record: ErasureJournalRecord) =>
  record.kind === 'member'
    ? {
        event: 'community.member_erased',
        communityId: record.communityId,
        memberId: record.memberId,
      }
    : { event: 'community.account_erased', userId: record.userId };

beforeAll(async () => {
  [h, other] = await Promise.all([
    startTenancyHarness('journal'),
    startTenancyHarness('journalother', { env: { COMMUNITY_AUTH_SECRET: 'z'.repeat(32) } }),
  ]);
  operatorCookie = (await bootstrapHost(h, 'Jo Host', 'jo@journal.test')).cookie;
  journalKey = await issue(h, [SCOPE]);
}, 60_000);

afterAll(async () => {
  await Promise.all([h?.close(), other?.close()]);
});

// Runs first: every later test adds rows.
describe('an empty journal', () => {
  // Purpose: fails if an empty journal errors, claims more, or hands out a cursor that does not
  // resume at the start once rows arrive.
  it('returns no lines and a cursor that picks up the first row written later', async () => {
    const empty = await page(h);
    expect(empty).toMatchObject({ lines: [], hasMore: false });
    expect(await page(h, { cursor: empty.nextCursor })).toMatchObject({ lines: [] });
    const first = member();
    await append(h, first);
    expect((await drain(h, empty.nextCursor)).lines).toEqual([lineOf(first)]);
  });
});

describe('the communities:erasure_journal scope', () => {
  // Purpose: fails if any other scope, even every other scope at once, reads the journal, or if
  // the scope itself, or a host operator's session, is refused.
  it('is the only scope that reads the journal', async () => {
    const others = CommunityAdminHostApiKeyScopeSchema.options.filter((scope) => scope !== SCOPE);
    expect(others.length).toBeGreaterThan(0);
    for (const scope of others) {
      const response = await read(h, {}, { bearer: await issue(h, [scope]) });
      expect(response.status, scope).toBe(403);
    }
    expect((await read(h, {}, { bearer: await issue(h, others) })).status).toBe(403);
    expect((await read(h, {}, { bearer: journalKey })).status).toBe(200);
    expect((await read(h, {}, { cookie: operatorCookie })).status).toBe(200);
  });

  // Purpose: fails if the route answers without credentials, or keeps serving a revoked key.
  it('refuses no credentials and a revoked key', async () => {
    expect((await read(h, {}, {})).status).toBe(401);
    const doomed = await issue(h, [SCOPE]);
    expect((await read(h, {}, { bearer: doomed })).status).toBe(200);
    await h.pool.query('UPDATE host_api_keys SET revoked_at=now() WHERE prefix=$1', [
      doomed.slice(0, 10),
    ]);
    expect((await read(h, {}, { bearer: doomed })).status).toBe(401);
  });

  // Purpose: fails if the page size is unbounded or a malformed limit is accepted.
  it('bounds the page size', async () => {
    for (const limit of [0, 1001, 'many', -1]) {
      expect((await read(h, { limit })).status, String(limit)).toBe(400);
    }
    expect((await read(h, { limit: 1000 })).status).toBe(200);
  });
});

describe('paging', () => {
  // Purpose: fails if a page skips, repeats or reorders a row, or if a saved cursor does not
  // resume exactly after the rows it has seen once more are appended.
  it('returns every row once, in order, and a saved cursor resumes after appends', async () => {
    const start = (await drain(h)).cursor;
    const records: ErasureJournalRecord[] = [
      member(),
      { kind: 'account', userId: `user_${randomUUID().slice(0, 8)}` },
      member(),
      member(),
      member(),
    ];
    for (const record of records) await append(h, record);
    // A page that ends exactly at the last row says so, and one that stops short says there is more.
    expect(await page(h, { cursor: start, limit: 5 })).toMatchObject({ hasMore: false });
    expect(await page(h, { cursor: start, limit: 4 })).toMatchObject({ hasMore: true });
    const first = await drain(h, start, 2);
    expect(first.lines).toEqual(records.map(lineOf));
    const later = [member(), member()];
    for (const record of later) await append(h, record);
    expect((await drain(h, first.cursor, 2)).lines).toEqual(later.map(lineOf));
    expect((await drain(h, start, 1)).lines).toEqual([...records, ...later].map(lineOf));
  });

  // Purpose: fails if a reader can move past a row whose erasure commits after a later one.
  // Without the journal write lock, B commits id n+1 while A still holds id n, the first read
  // returns B's row alone, and A's row is never read.
  it('never moves past a row that commits after a later one', async () => {
    const start = (await drain(h)).cursor;
    const a = member();
    const b = member();
    const holder = await h.pool.connect();
    let later: Promise<void> | undefined;
    try {
      await holder.query('BEGIN');
      await appendJournalRow(holder, a);
      later = append(h, b);
      // B either waits on A's lock or, without the lock, commits on its own.
      await Promise.race([waitForLockWaiters(h, 1, 'pg_advisory_xact_lock'), later]);
      const during = await page(h, { cursor: start });
      await holder.query('COMMIT');
      await later;
      const after = await drain(h, during.nextCursor);
      expect([...during.lines, ...after.lines]).toEqual([lineOf(a), lineOf(b)]);
    } finally {
      holder.release();
    }
  });

  // Purpose: fails if rows are lost or duplicated while many erasures commit during a read.
  it('loses nothing while many rows commit during the read', async () => {
    const start = (await drain(h)).cursor;
    const records = Array.from({ length: 60 }, member);
    let done = false;
    const writers = (async () => {
      await Promise.all(records.map((record) => append(h, record)));
      done = true;
    })();
    const seen: Page['lines'] = [];
    let cursor = start;
    for (;;) {
      const finished = done;
      const next = await page(h, { cursor, limit: 7 });
      seen.push(...next.lines);
      cursor = next.nextCursor;
      if (finished && !next.hasMore) break;
    }
    await writers;
    expect(seen).toHaveLength(records.length);
    expect(new Set(seen.map((line) => JSON.stringify(line)))).toEqual(
      new Set(records.map((record) => JSON.stringify(lineOf(record))))
    );
  });
});

describe('stale cursors', () => {
  // Purpose: fails if a tampered cursor or one for another feed is served instead of 410.
  it('answers 410 for a tampered cursor', async () => {
    const { cursor } = await drain(h);
    const [value, mac] = cursor.split('.');
    const forged = Buffer.from(
      JSON.stringify({ version: 1, kind: 'erasure-journal', id: 1, nonce: null })
    ).toString('base64url');
    for (const bad of [`${value}.x${mac.slice(1)}`, `${forged}.${mac}`, 'nonsense']) {
      const response = await read(h, { cursor: bad });
      expect(response.status, bad).toBe(410);
      expect(await response.json()).toMatchObject({ code: 'CURSOR_STALE' });
    }
  });

  // Purpose: fails if a cursor survives a restore that removed or replaced the row it names,
  // which would make a reader skip rows written after the restore.
  it('answers 410 once the row a cursor names is gone or replaced', async () => {
    const before = (await drain(h)).cursor;
    await append(h, member());
    const { cursor } = await drain(h, before);
    const last = await h.pool.query<{ id: string }>(
      'SELECT max(id)::text AS id FROM erasure_journal'
    );
    // A restore gives the id to a different row, with a different nonce.
    await h.pool.query('UPDATE erasure_journal SET nonce=gen_random_uuid() WHERE id=$1', [
      last.rows[0].id,
    ]);
    expect((await read(h, { cursor })).status).toBe(410);
    await h.pool.query('DELETE FROM erasure_journal WHERE id=$1', [last.rows[0].id]);
    expect((await read(h, { cursor })).status).toBe(410);
    // The start is always valid, and the earlier cursor still holds.
    expect((await read(h)).status).toBe(200);
    expect((await read(h, { cursor: before })).status).toBe(200);
  });
});

describe('two hosts', () => {
  // Purpose: fails if one host's key, cursor, or rows reach another host's journal.
  it('keeps each host to its own journal', async () => {
    const otherKey = await issue(other, [SCOPE]);
    const mine = member();
    await append(h, mine);
    const theirs = member();
    await append(other, theirs);
    expect((await read(other, {}, { bearer: journalKey })).status).toBe(401);
    expect((await read(h, {}, { bearer: otherKey })).status).toBe(401);
    const here = await drain(h);
    const there = await drain(other, undefined, 3, otherKey);
    expect(there.lines).toEqual([lineOf(theirs)]);
    expect(here.lines).toContainEqual(lineOf(mine));
    expect(here.lines).not.toContainEqual(lineOf(theirs));
    expect((await read(other, { cursor: here.cursor }, { bearer: otherKey })).status).toBe(410);
  });
});

describe('a real erasure', { timeout: 120_000 }, () => {
  // Purpose: fails if a finished erasure writes no row, a row other than the file's line, or a
  // row that carries anything the erasure removed.
  it('adds the same lines as the journal file, by id only', async () => {
    const start = (await drain(h)).cursor;
    const s = await makeScene(h, operatorCookie, 'journalread');
    const email = (await h.pool.query('SELECT email FROM "user" WHERE id=$1', [s.p.userId])).rows[0]
      .email as string;
    await requestErasure(h, s.p.cookie, s.communityId);
    await body(
      await h.call('/api/v1/account/erasures', {
        cookie: s.q.cookie,
        body: {
          kind: 'account',
          confirmEmail: (await h.pool.query('SELECT email FROM "user" WHERE id=$1', [s.q.userId]))
            .rows[0].email,
          password: PASSWORD,
        },
      }),
      201,
      'account erasure'
    );
    const logged: string[] = [];
    await runErasures(h.pool, hoursFromNow(73), { log: (line) => logged.push(line) });
    const response = await read(h, { cursor: start });
    const text = await response.text();
    const pulled = CommunityAdminErasureJournalPageSchema.parse(JSON.parse(text)).lines;
    expect(pulled.map((line) => JSON.stringify(line)).sort()).toEqual([...logged].sort());
    expect(pulled).toContainEqual({
      event: 'community.member_erased',
      communityId: s.communityId,
      memberId: s.p.memberId,
    });
    expect(pulled).toContainEqual({ event: 'community.account_erased', userId: s.q.userId });
    for (const needle of [s.p.handle, s.q.handle, email, `hello from ${s.p.handle}`])
      expect(text).not.toContain(needle);
  });
});

describe('an erasure finishing while an owner claims the community', { timeout: 60_000 }, () => {
  // Purpose: fails if the journal shares its lock with community creation. The erasure holds the
  // community row FOR SHARE when it journals; the claim holds the creation lock and waits for that
  // row FOR UPDATE. With one key between them, PostgreSQL aborts one of the two (40P01).
  it('lets both finish', async () => {
    const pending = await createPendingCommunity(h, operatorCookie, `Claimed ${randomUUID()}`);
    // A member of a community waiting for an owner, as an imported community has.
    const userId = `imported_${randomUUID().slice(0, 8)}`;
    await h.pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [
      userId,
      'Imported member',
      `${userId}@journal.test`,
    ]);
    const memberId = (
      await h.pool.query<{ id: string }>(
        `INSERT INTO members(community_id,user_id,display_name,handle,role)
         VALUES($1,$2,'Imported member',$3,'member') RETURNING id`,
        [pending.communityId, userId, `m${randomUUID().slice(0, 8)}`]
      )
    ).rows[0].id;
    const grant = await preflightOwnerClaim(h, pending.token);
    const signedUp = await h.call('/api/auth/sign-up/email', {
      body: {
        name: 'New Owner',
        email: `owner-${randomUUID()}@journal.test`,
        password: TENANCY_PASSWORD,
      },
      cookie: grant,
    });
    expect(signedUp.status).toBe(200);
    const cookie = [
      grant,
      ...signedUp.headers.getSetCookie().map((value) => value.split(';')[0]),
    ].join('; ');
    let claim: Promise<Response> | undefined;
    const outcome = await eraseMembership(h.pool, pending.communityId, memberId, {
      log: () => undefined,
      hooks: {
        inBatch: async (step) => {
          if (step !== 'seal') return;
          // The erasure holds the community row; the claim now takes its lock and waits for it.
          claim = h.call('/api/v1/owner-claims/claim', { cookie, body: {} });
          await waitForLockWaiters(h, 1, 'FOR UPDATE OF c');
        },
      },
    });
    expect(outcome).toBe('erased');
    expect((await claim!).status).toBe(200);
    expect(
      (await h.pool.query('SELECT 1 FROM erasure_journal WHERE member_id=$1', [memberId])).rowCount
    ).toBe(1);
  });
});

describe('retention', () => {
  // Purpose: fails if rows older than the retention are kept (a deleted community's and an
  // account's included), if newer rows are pruned, or if a cursor naming a pruned row is served.
  it('prunes rows past the retention, and a cursor on a pruned row starts over', async () => {
    const old = [
      member(),
      { kind: 'account' as const, userId: `gone_${randomUUID().slice(0, 8)}` },
    ];
    for (const record of old) await append(h, record);
    const { cursor } = await drain(h);
    const fresh = member();
    await append(h, fresh);
    await h.pool.query(
      `UPDATE erasure_journal SET created_at=now()-interval '31 days'
       WHERE member_id=$1 OR user_id=$2`,
      [(old[0] as { memberId: string }).memberId, (old[1] as { userId: string }).userId]
    );
    const edge = member();
    await append(h, edge);
    await h.pool.query(
      `UPDATE erasure_journal SET created_at=now()-interval '29 days' WHERE member_id=$1`,
      [edge.memberId]
    );
    expect(await pruneErasureJournal(h.pool, 30)).toBe(2);
    const left = (await drain(h)).lines;
    for (const record of old) expect(left).not.toContainEqual(lineOf(record));
    expect(left).toContainEqual(lineOf(fresh));
    expect(left).toContainEqual(lineOf(edge));
    expect((await read(h, { cursor })).status).toBe(410);
  });
});
