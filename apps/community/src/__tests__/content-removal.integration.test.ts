/**
 * Removing one message or one file on the Community server (specs/community-single-item-delete,
 * task 1.1, AC-1 to AC-10). Real PostgreSQL through the tenancy harness; filesystem storage
 * here, S3 in content-removal.s3.test.ts.
 */
import { readdir } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CommunityWireEntryRemoveResponseSchema,
  CommunityWireEntrySchema,
  type CommunityWireEntry,
} from '@dorkos/shared/community-wire';
import { REMOVED_ENTRY_TEXT, removeEntry } from '../content-removal.js';
import { ERASED_ENTRY_TEXT, eraseMembership } from '../erasure/erasure.js';
import { runHostKeyCommand } from '../host-keys.js';
import {
  admit,
  bootstrapHost,
  expectStatus,
  holdingLock,
  pairInstall,
  startTenancyHarness,
  waitForLockWaiters,
  type TenancyHarness,
} from './tenancy-test-harness.js';
import {
  body,
  drainCleanup,
  person,
  post,
  scanBlobs,
  scanDatabase,
  sha256,
  storageDirectory,
  upload,
  type Person,
} from './member-erasure-fixture.js';
import { communityDigest, makeScene, type Scene } from './member-erasure-scenes.js';

let h: TenancyHarness;
let host: { cookie: string; communityId: string };
let exportGate: { entered: () => void; release: Promise<void> } | null = null;
let keyCounter = 0;

beforeAll(async () => {
  h = await startTenancyHarness('removal', {
    hooks: {
      afterExportSnapshot: async () => {
        const gate = exportGate;
        if (!gate) return;
        gate.entered();
        await gate.release;
      },
    },
  });
  host = await bootstrapHost(h, 'Rhea Host', 'rhea@host.test');
}, 60_000);

afterAll(async () => {
  await h?.close();
});

type Auth = { cookie?: string; bearer?: string };
interface Agent {
  id: string;
  token: string;
}

const scene = (label: string) => makeScene(h, host.cookie, label);

/** Post one message as `auth` and return its id. */
async function say(s: Scene, auth: Auth, text = 'hello', extra: { attachmentIds?: string[] } = {}) {
  return (
    await post(h, s.communityId, s.channelId, auth, {
      text,
      idempotencyKey: `say-${++keyCounter}`,
      ...extra,
    })
  ).id;
}

function removeMessage(s: Scene, entryId: string, auth: Auth, base = s.base) {
  return h.call(`${base}/entries/${entryId}`, { method: 'DELETE', ...auth });
}

function removeFile(s: Scene, attachmentId: string, auth: Auth) {
  return h.call(`${s.base}/attachments/${attachmentId}`, { method: 'DELETE', ...auth });
}

async function removed(response: Response, step: string): Promise<CommunityWireEntry> {
  const parsed = CommunityWireEntryRemoveResponseSchema.parse(await body(response, 200, step));
  return parsed.entry;
}

async function joinChannel(s: Scene, cookie: string) {
  await body(
    await h.call(`${s.base}/channels/${s.channelId}/join`, { cookie, body: {} }),
    200,
    'join'
  );
}

/** Pair an install for `cookie`, enroll an agent through it, and put the agent in the channel. */
async function enrollAgent(s: Scene, cookie: string, label: string): Promise<Agent> {
  const grant = await pairInstall(
    h,
    s.communityId,
    cookie,
    ['read', 'post', 'enroll-agent'],
    label
  );
  const enrolled = await body<{ token: string; agent: { memberId: string } }>(
    await h.call(`${s.base}/agents`, {
      bearer: grant,
      body: { localAgentId: `local-${label}`, displayName: `Bot ${label}` },
    }),
    201,
    `enroll ${label}`
  );
  await body(
    await h.call(`${s.base}/channels/${s.channelId}/agents`, {
      cookie,
      body: { agentId: enrolled.agent.memberId },
    }),
    200,
    'agent joins'
  );
  return { id: enrolled.agent.memberId, token: enrolled.token };
}

async function setRole(s: Scene, memberId: string, role: 'admin' | 'member') {
  await body(
    await h.call(`${s.base}/members/${memberId}/role`, {
      method: 'PATCH',
      cookie: s.owner.cookie,
      body: { role },
    }),
    200,
    `role ${role}`
  );
}

async function admitPerson(s: Scene, label: string): Promise<Person> {
  const joined = await person(
    h,
    await admit(h, s.communityId, s.owner.cookie, {
      name: `${label} ${s.slug}`,
      email: `${label}-${s.slug}@x.test`,
    })
  );
  await joinChannel(s, joined.cookie);
  return joined;
}

async function count(sql: string, params: unknown[]): Promise<number> {
  return (await h.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) t`, params))
    .rows[0].n;
}

const redactionsOf = (entryId: string) =>
  count('SELECT 1 FROM entry_redactions WHERE entry_id=$1', [entryId]);

/**
 * Search every bytea column of the public schema, from the catalogue, for each needle both as
 * raw bytes and as UTF-8 text. Today there are none; one added later is scanned unlisted.
 */
async function scanBytea(needles: readonly string[]): Promise<string[]> {
  const columns = await h.pool.query<{ table_name: string; column_name: string }>(
    `SELECT c.table_name,c.column_name FROM information_schema.columns c
     JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
     WHERE c.table_schema='public' AND t.table_type='BASE TABLE' AND c.data_type='bytea'`
  );
  const hits: string[] = [];
  for (const { table_name: table, column_name: column } of columns.rows) {
    for (const needle of needles) {
      const found = await h.pool.query(
        `SELECT 1 FROM "${table}" WHERE position(convert_to($1,'UTF8') IN "${column}")>0
           OR lower(encode("${column}",'escape')) LIKE '%' || lower($1) || '%' LIMIT 1`,
        [needle]
      );
      if (found.rowCount) hits.push(`${table}.${column}:${needle}`);
    }
  }
  return hits;
}

describe('removing a message', { timeout: 120_000 }, () => {
  // Purpose (AC-1, AC-2, AC-9): the message keeps its place and thread, and nothing of what it
  // said or carried survives anywhere on the server; a hard delete, a filter, a leftover
  // mention, file row, blob, hash, log line, or audit value each fails it.
  it('tombstones in place, keeps the thread, and leaves no trace (AC-1, AC-2, AC-9)', async () => {
    const s = await scene('shape');
    const fileBytes = 'canary-bytes of the attached file';
    const fileId = await upload(
      h,
      s.communityId,
      s.channelId,
      s.p.cookie,
      'canary-file.txt',
      fileBytes
    );
    const rootText = `canary-text for @${s.q.handle}`;
    const root = await post(
      h,
      s.communityId,
      s.channelId,
      { cookie: s.p.cookie },
      { text: rootText, idempotencyKey: 'canary-root', attachmentIds: [fileId] }
    );
    const reply = await post(
      h,
      s.communityId,
      s.channelId,
      { cookie: s.q.cookie },
      { text: 'a reply', idempotencyKey: 'q-reply', parentEntryId: root.id }
    );
    const pageCursor = (
      await body<{ nextCursor: string }>(
        await h.call(`${s.base}/channels/${s.channelId}/entries?limit=1`, { cookie: s.p.cookie }),
        200,
        'first page'
      )
    ).nextCursor;
    expect(pageCursor).toBeTruthy();
    const rowBefore = (await h.pool.query('SELECT * FROM entries WHERE id=$1', [root.id])).rows[0];
    const needles = [
      'canary-text',
      'canary-file.txt',
      'canary-bytes',
      sha256(fileBytes),
      rowBefore.payload_hash as string,
    ];
    // Control: before the delete each needle is found, so the scan can see what it looks for.
    const beforeHits = await scanDatabase(h.pool, needles);
    for (const needle of [
      'canary-text',
      'canary-file.txt',
      sha256(fileBytes),
      rowBefore.payload_hash,
    ])
      expect(beforeHits.map((hit) => hit.needle)).toContain(needle.toLowerCase());
    expect((await scanBlobs(storageDirectory(h), ['canary-bytes'])).length).toBe(1);
    expect(await count('SELECT 1 FROM entry_mentions WHERE entry_id=$1', [root.id])).toBe(1);

    const logs: string[] = [];
    const capture = (...args: unknown[]) => void logs.push(args.map(String).join(' '));
    const spies = (['log', 'error', 'warn', 'info'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(capture)
    );
    let entry: CommunityWireEntry;
    try {
      entry = await removed(await removeMessage(s, root.id, { cookie: s.p.cookie }), 'delete');
      await drainCleanup(h);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    // AC-1: the unchanged wire schema parses it; only its content changed.
    expect(CommunityWireEntrySchema.parse(entry)).toMatchObject({
      id: root.id,
      seq: root.seq,
      text: REMOVED_ENTRY_TEXT.author,
      mentions: [],
      attachments: [],
      parentEntryId: null,
      threadRootEntryId: null,
      authorMemberId: s.p.memberId,
    });
    const rowAfter = (await h.pool.query('SELECT * FROM entries WHERE id=$1', [root.id])).rows[0];
    for (const kept of [
      'id',
      'seq',
      'parent_entry_id',
      'thread_root_entry_id',
      'created_at',
      'author_member_id',
      'author_agent_id',
      'author_display_name',
      'idempotency_key',
    ])
      expect(rowAfter[kept]).toEqual(rowBefore[kept]);
    expect(rowAfter).toMatchObject({ removed_by: 'author', erased_at: null });
    expect(rowAfter.removed_at).toBeInstanceOf(Date);
    const history = await body<{ entries: CommunityWireEntry[] }>(
      await h.call(`${s.base}/channels/${s.channelId}/entries`, { cookie: s.q.cookie }),
      200,
      'history'
    );
    expect(history.entries.find((row) => row.id === root.id)?.text).toBe(REMOVED_ENTRY_TEXT.author);
    const thread = await body<{ entries: CommunityWireEntry[] }>(
      await h.call(`${s.base}/channels/${s.channelId}/entries?thread=${root.id}`, {
        cookie: s.q.cookie,
      }),
      200,
      'thread'
    );
    expect(thread.entries.map((row) => row.id)).toEqual([root.id, reply.id]);
    expect(thread.entries[1].parentEntryId).toBe(root.id);
    // Cursors taken before the delete still work.
    expect(
      (
        await h.call(
          `${s.base}/channels/${s.channelId}/entries?cursor=${encodeURIComponent(pageCursor)}`,
          {
            cookie: s.q.cookie,
          }
        )
      ).status
    ).toBe(200);
    const stream = await h.call(`${s.base}/channels/${s.channelId}/events`, {
      cookie: s.q.cookie,
      headers: { 'last-event-id': root.cursor },
    });
    expect(stream.status).toBe(200);
    await stream.body?.cancel();

    // AC-2: nothing left in any column, blob, or log line.
    expect(await scanDatabase(h.pool, needles)).toEqual([]);
    expect(await scanBytea(needles)).toEqual([]);
    expect(await scanBlobs(storageDirectory(h), needles)).toEqual([]);
    expect(
      logs.filter((line) =>
        needles.some((needle) => line.toLowerCase().includes(needle.toLowerCase()))
      )
    ).toEqual([]);
    expect((await h.call(`${s.base}/attachments/${fileId}`, { cookie: s.q.cookie })).status).toBe(
      404
    );
    expect(await count('SELECT 1 FROM entry_mentions WHERE entry_id=$1', [root.id])).toBe(0);
    expect(await redactionsOf(root.id)).toBe(1);

    // AC-9: one content-free audit row.
    const audit = await h.pool.query(
      `SELECT action,actor_kind,actor_member_id,subject_id,changed_fields,prior_state,next_state
       FROM audit_events WHERE community_id=$1 AND subject_id=$2`,
      [s.communityId, root.id]
    );
    expect(audit.rows).toEqual([
      {
        action: 'entry.delete',
        actor_kind: 'member',
        actor_member_id: s.p.memberId,
        subject_id: root.id,
        changed_fields: ['text', 'mentions', 'attachments'],
        prior_state: null,
        next_state: null,
      },
    ]);
  });

  // Purpose (AC-3): counted storage drops in the removing request itself, so a person at the
  // limit can upload again at once; fails if pending_delete still counted or the queue ran later.
  it('frees counted storage in the same request (AC-3)', async () => {
    const s = await scene('storage');
    const issue = async (scopes: string[]) => {
      const issued = await runHostKeyCommand(h.pool, {
        kind: 'issue',
        label: `removal ${scopes.join(' ')}`,
        scopes: scopes as never,
        expiresInDays: null,
      });
      if (issued.kind !== 'issue') throw new Error('expected a key');
      return issued.secret;
    };
    const key = await issue(['communities:read', 'communities:write']);
    const usage = async () =>
      await body<{ storage: { countedBytes: number }; limits: { limitsVersion: number } }>(
        await h.call(`/api/v1/host/communities/${s.communityId}/usage`, { bearer: key }),
        200,
        'usage'
      );
    const size = 4096;
    const fileId = await upload(
      h,
      s.communityId,
      s.channelId,
      s.p.cookie,
      'big.txt',
      'x'.repeat(size)
    );
    const entryId = await say(s, { cookie: s.p.cookie }, 'with a big file', {
      attachmentIds: [fileId],
    });
    const before = await usage();
    await body(
      await h.call(`/api/v1/host/communities/${s.communityId}/limits`, {
        method: 'PUT',
        bearer: key,
        body: {
          limitsVersion: before.limits.limitsVersion,
          maxActiveMembers: null,
          maxStorageBytes: before.storage.countedBytes + size - 1,
        },
      }),
      200,
      'set limit'
    );
    const tryUpload = () =>
      h.call(`${s.base}/channels/${s.channelId}/attachments`, {
        method: 'POST',
        cookie: s.p.cookie,
        headers: {
          'content-type': 'text/plain',
          'idempotency-key': `after-${++keyCounter}`,
          'x-file-name': 'next.txt',
          'x-file-size': String(size),
        },
        raw: 'y'.repeat(size),
      });
    expect((await tryUpload()).status).toBe(409);
    await removed(await removeMessage(s, entryId, { cookie: s.p.cookie }), 'delete');
    expect((await usage()).storage.countedBytes).toBe(before.storage.countedBytes - size);
    expect((await tryUpload()).status).toBe(201);
  });

  // Purpose (AC-6): a repeat changes nothing and a retry of the original post can never bring
  // the deleted content back, with its own payload or a different one.
  it('answers a repeat and a retried post with the tombstone (AC-6)', async () => {
    const s = await scene('repeat');
    const original = { text: 'regret this', idempotencyKey: 'regret' };
    const entryId = (await post(h, s.communityId, s.channelId, { cookie: s.p.cookie }, original))
      .id;
    const first = await removed(await removeMessage(s, entryId, { cookie: s.p.cookie }), 'first');
    const second = await removed(await removeMessage(s, entryId, { cookie: s.p.cookie }), 'second');
    expect(second).toEqual(first);
    expect(await redactionsOf(entryId)).toBe(1);
    expect(await count('SELECT 1 FROM audit_events WHERE subject_id=$1', [entryId])).toBe(1);
    const entries = await count('SELECT 1 FROM entries WHERE community_id=$1', [s.communityId]);
    for (const retry of [original, { ...original, text: 'something else entirely' }]) {
      const replay = await body<{ entry: CommunityWireEntry }>(
        await h.call(`${s.base}/channels/${s.channelId}/entries`, {
          cookie: s.p.cookie,
          body: retry,
        }),
        200,
        'retry'
      );
      expect(replay.entry).toMatchObject({ id: entryId, text: REMOVED_ENTRY_TEXT.author });
    }
    expect(await count('SELECT 1 FROM entries WHERE community_id=$1', [s.communityId])).toBe(
      entries
    );
  });
});

describe('who may remove (AC-4)', { timeout: 180_000 }, () => {
  // Purpose: every cell of the rank rule over HTTP, including agent content ranked by its
  // owner, former admins, erased husks, credential kinds, and another community's ids. Every
  // refusal leaves the community's rows byte-for-byte unchanged.
  it('applies the rank rule to every actor and author', async () => {
    const s = await scene('matrix');
    const admin = await admitPerson(s, 'admin');
    await setRole(s, admin.memberId, 'admin');
    const peerAdmin = await admitPerson(s, 'peer');
    await setRole(s, peerAdmin.memberId, 'admin');
    const former = await admitPerson(s, 'former');
    await setRole(s, former.memberId, 'admin');
    const erased = await admitPerson(s, 'erased');
    const pSibling = await enrollAgent(s, s.p.cookie, `sib-${s.slug}`);
    const ownerAgent = await enrollAgent(s, s.owner.cookie, `own-${s.slug}`);
    const peerAgent = await enrollAgent(s, peerAdmin.cookie, `peer-${s.slug}`);
    const readOnly = await pairInstall(h, s.communityId, s.p.cookie, ['read'], `ro-${s.slug}`);
    const historyGrant = await pairInstall(
      h,
      s.communityId,
      s.p.cookie,
      ['read', 'post'],
      `hist-${s.slug}`
    );
    await h.pool.query(
      // A history-only grant reads and nothing else (connection_grants_history_only_scope).
      "UPDATE connection_grants SET history_only=true,scopes=ARRAY['read'] WHERE install_name=$1 AND community_id=$2",
      [`hist-${s.slug}`, s.communityId]
    );
    const hostKey = await runHostKeyCommand(h.pool, {
      kind: 'issue',
      label: 'removal matrix',
      scopes: ['communities:read', 'communities:write'] as never,
      expiresInDays: null,
    });
    if (hostKey.kind !== 'issue') throw new Error('expected a key');
    const formerEntry = await say(s, { cookie: former.cookie });
    await expectStatus(
      await h.call(`${s.base}/members/${former.memberId}`, {
        method: 'DELETE',
        cookie: s.owner.cookie,
      }),
      204,
      'remove former admin'
    );
    const erasedEntry = await say(s, { cookie: erased.cookie });
    expect(
      await eraseMembership(h.pool, s.communityId, erased.memberId, { log: () => undefined })
    ).toBe('erased');
    const other = await scene('matrixother');
    const otherEntry = await say(other, { cookie: other.p.cookie });

    const P = { cookie: s.p.cookie };
    const cells: [string, () => Promise<string>, Auth, number, string?][] = [
      ['member deletes own', () => say(s, P), P, 200],
      ['member deletes own agent', () => say(s, { bearer: s.agent.token }), P, 200],
      ['member deletes another member', () => say(s, { cookie: s.q.cookie }), P, 403],
      [
        'agent deletes own',
        () => say(s, { bearer: s.agent.token }),
        { bearer: s.agent.token },
        200,
      ],
      [
        'agent deletes sibling',
        () => say(s, { bearer: pSibling.token }),
        { bearer: s.agent.token },
        403,
      ],
      ['admin removes member', () => say(s, { cookie: s.q.cookie }), { cookie: admin.cookie }, 200],
      [
        'admin removes member agent',
        () => say(s, { bearer: s.agent.token }),
        { cookie: admin.cookie },
        200,
      ],
      [
        'admin removes owner',
        () => say(s, { cookie: s.owner.cookie }),
        { cookie: admin.cookie },
        403,
      ],
      [
        'admin removes owner agent',
        () => say(s, { bearer: ownerAgent.token }),
        { cookie: admin.cookie },
        403,
      ],
      [
        'admin removes active admin',
        () => say(s, { cookie: peerAdmin.cookie }),
        { cookie: admin.cookie },
        403,
      ],
      [
        'admin removes admin agent',
        () => say(s, { bearer: peerAgent.token }),
        { cookie: admin.cookie },
        403,
      ],
      ['admin removes former admin', async () => formerEntry, { cookie: admin.cookie }, 200],
      ['admin removes erased husk', async () => erasedEntry, { cookie: admin.cookie }, 200],
      [
        'owner removes admin',
        () => say(s, { cookie: peerAdmin.cookie }),
        { cookie: s.owner.cookie },
        200,
      ],
      [
        'owner removes admin agent',
        () => say(s, { bearer: peerAgent.token }),
        { cookie: s.owner.cookie },
        200,
      ],
      ['grant with post deletes own', () => say(s, P), { bearer: s.grant }, 200],
      ['grant without post', () => say(s, P), { bearer: readOnly }, 403],
      ['history-only grant', () => say(s, P), { bearer: historyGrant }, 403],
      ['host API key', () => say(s, P), { bearer: hostKey.secret }, 401],
      ['another community entry', async () => otherEntry, { cookie: s.owner.cookie }, 404],
      ['not a uuid', async () => 'not-a-uuid', { cookie: s.owner.cookie }, 404],
    ];
    const outcomes: string[] = [];
    for (const [name, make, actor] of cells) {
      const entryId = await make();
      const digestBefore = await communityDigest(h.pool, s.communityId);
      const otherBefore = await communityDigest(h.pool, other.communityId);
      const response = await removeMessage(s, entryId, actor);
      outcomes.push(`${name}: ${response.status}`);
      if (response.status === 200) {
        const entry = await removed(response, name);
        expect(entry.text, name).toMatch(
          /^This message was (deleted|removed by a community admin|erased)\.$/
        );
      } else {
        await response.body?.cancel();
        expect(await communityDigest(h.pool, s.communityId), name).toBe(digestBefore);
        expect(await communityDigest(h.pool, other.communityId), name).toBe(otherBefore);
      }
    }
    expect(outcomes).toEqual(cells.map(([name, , , status]) => `${name}: ${status}`));
    // The right audit action and actor: a moderator's removal names the admin; an agent's
    // deletion names its owner; an already-erased entry wrote no audit row.
    const audit = await h.pool.query<{ action: string; actor_member_id: string; n: number }>(
      `SELECT action,actor_member_id,count(*)::int AS n FROM audit_events
       WHERE community_id=$1 AND action LIKE 'entry.%' GROUP BY 1,2 ORDER BY 1,2`,
      [s.communityId]
    );
    expect(audit.rows).toEqual(
      expect.arrayContaining([
        { action: 'entry.remove', actor_member_id: admin.memberId, n: 3 },
        { action: 'entry.remove', actor_member_id: s.owner.memberId, n: 2 },
        { action: 'entry.delete', actor_member_id: s.p.memberId, n: 4 },
      ])
    );
    expect(await count('SELECT 1 FROM audit_events WHERE subject_id=$1', [erasedEntry])).toBe(0);
    const texts = await h.pool.query<{ text: string; removed_by: string }>(
      'SELECT text,removed_by FROM entries WHERE id=$1',
      [formerEntry]
    );
    expect(texts.rows[0]).toEqual({ text: REMOVED_ENTRY_TEXT.moderator, removed_by: 'moderator' });
  });

  // Purpose: removal is not a way to read a channel. An admin who has not joined it gets no
  // message text, files, or cursor back, and cannot tell a message it may not remove from one
  // that does not exist; its author still gets the result.
  it('answers an admin outside the channel without showing it anything', async () => {
    const s = await scene('outside');
    const admin = await person(
      h,
      await admit(h, s.communityId, s.owner.cookie, {
        name: `Outside ${s.slug}`,
        email: `outside-${s.slug}@x.test`,
      })
    );
    await setRole(s, admin.memberId, 'admin');
    const fileId = await upload(h, s.communityId, s.channelId, s.q.cookie, 'q.txt', 'q file');
    const withFile = await say(s, { cookie: s.q.cookie }, 'private words', {
      attachmentIds: [fileId],
    });
    const plain = await say(s, { cookie: s.q.cookie }, 'more private words');
    const ownerEntry = await say(s, { cookie: s.owner.cookie }, 'owner words');
    const outside = { cookie: admin.cookie };

    const file = await removeFile(s, fileId, outside);
    expect(file.status).toBe(204);
    expect(await file.text()).toBe('');
    expect(await count('SELECT 1 FROM attachments WHERE id=$1', [fileId])).toBe(0);
    const message = await removeMessage(s, plain, outside);
    expect(message.status).toBe(204);
    expect(await message.text()).toBe('');
    expect((await h.pool.query('SELECT text FROM entries WHERE id=$1', [plain])).rows[0].text).toBe(
      REMOVED_ENTRY_TEXT.moderator
    );

    // A refusal looks exactly like an unknown id.
    const refused = await removeMessage(s, ownerEntry, outside);
    const unknown = await removeMessage(s, '00000000-0000-4000-8000-000000000000', outside);
    expect([refused.status, unknown.status]).toEqual([404, 404]);
    expect(await refused.json()).toEqual(await unknown.json());
    const ownerFile = await upload(h, s.communityId, s.channelId, s.owner.cookie, 'o.txt', 'o');
    await say(s, { cookie: s.owner.cookie }, 'owner file', { attachmentIds: [ownerFile] });
    const refusedFile = await removeFile(s, ownerFile, outside);
    const unknownFile = await removeFile(s, '00000000-0000-4000-8000-000000000000', outside);
    expect([refusedFile.status, unknownFile.status]).toEqual([404, 404]);
    expect(await refusedFile.json()).toEqual(await unknownFile.json());

    // Joined, the same admin sees the result and a plain refusal.
    await joinChannel(s, admin.cookie);
    expect((await removeMessage(s, ownerEntry, outside)).status).toBe(403);
    expect((await removed(await removeMessage(s, withFile, outside), 'joined')).text).toBe(
      REMOVED_ENTRY_TEXT.moderator
    );

    // The author gets their own message back even after leaving the channel.
    const own = await say(s, { cookie: s.p.cookie }, 'mine');
    await body(
      await h.call(`${s.base}/channels/${s.channelId}/leave`, { cookie: s.p.cookie, body: {} }),
      200,
      'leave'
    );
    expect((await removed(await removeMessage(s, own, { cookie: s.p.cookie }), 'own')).text).toBe(
      REMOVED_ENTRY_TEXT.author
    );
  });

  // Purpose (AC-5 and the archived cells of AC-4): removal is not growth, so it runs in an
  // archived community for a browser session, but a history-only grant cannot, and a
  // suspended or closing community refuses it as it refuses every member request.
  it('follows the removal lifecycle rule (AC-5)', async () => {
    const s = await scene('lifecycle');
    const ids = await Promise.all([1, 2, 3, 4].map(() => say(s, { cookie: s.p.cookie })));
    const history = await pairInstall(
      h,
      s.communityId,
      s.p.cookie,
      ['read', 'post'],
      `h-${s.slug}`
    );
    await h.pool.query(
      "UPDATE connection_grants SET history_only=true,scopes=ARRAY['read'] WHERE install_name=$1 AND community_id=$2",
      [`h-${s.slug}`, s.communityId]
    );
    const setLifecycle = (sql: string) =>
      h.pool.query(`UPDATE communities SET ${sql} WHERE id=$1`, [s.communityId]);
    expect((await removeMessage(s, ids[0], { cookie: s.p.cookie })).status).toBe(200);
    await setLifecycle("lifecycle='archived',archived_at=now()");
    expect((await removeMessage(s, ids[1], { bearer: history })).status).toBe(403);
    expect((await removeMessage(s, ids[1], { cookie: s.p.cookie })).status).toBe(200);
    await setLifecycle(
      "lifecycle='suspended',suspended_from_state='archived',suspended_at=now(),archived_at=NULL"
    );
    const suspended = await removeMessage(s, ids[2], { cookie: s.p.cookie });
    expect(suspended.status).toBe(503);
    expect((await suspended.json()).code).toBe('COMMUNITY_SUSPENDED');
    await setLifecycle(
      `lifecycle='deletion_pending',suspended_from_state=NULL,suspended_at=NULL,
       delete_requested_at=now(),delete_after=now()+interval '7 days',
       delete_requested_by=(SELECT id FROM members WHERE community_id=$1 AND role='owner'),
       deletion_from_state='active'`
    );
    const closing = await removeMessage(s, ids[3], { cookie: s.p.cookie });
    expect(closing.status).toBe(423);
    expect((await closing.json()).code).toBe('COMMUNITY_DELETION_PENDING');
    expect(
      await count('SELECT 1 FROM entries WHERE id=ANY($1::uuid[]) AND removed_at IS NULL', [ids])
    ).toBe(2);
  });
});

describe('removing a file (AC-7)', { timeout: 120_000 }, () => {
  // Purpose: a file leaves its message without taking the text or the other file; a message
  // with nothing left becomes a tombstone; an unposted upload goes with no redaction row.
  it('removes one file from its message, and tombstones a message left empty', async () => {
    const s = await scene('files');
    const first = await upload(h, s.communityId, s.channelId, s.p.cookie, 'one.txt', 'one');
    const second = await upload(h, s.communityId, s.channelId, s.p.cookie, 'two.txt', 'two');
    const entryId = await say(s, { cookie: s.p.cookie }, 'two files', {
      attachmentIds: [first, second],
    });
    const after = await removed(await removeFile(s, first, { cookie: s.p.cookie }), 'file');
    expect(after.text).toBe('two files');
    expect(after.attachments.map((file) => file.id)).toEqual([second]);
    expect(await redactionsOf(entryId)).toBe(1);
    expect((await h.call(`${s.base}/attachments/${first}`, { cookie: s.q.cookie })).status).toBe(
      404
    );
    expect((await h.call(`${s.base}/attachments/${second}`, { cookie: s.q.cookie })).status).toBe(
      200
    );
    expect((await removeFile(s, first, { cookie: s.p.cookie })).status).toBe(404);
    const audit = await h.pool.query(
      'SELECT action,changed_fields FROM audit_events WHERE subject_id=$1',
      [first]
    );
    expect(audit.rows).toEqual([{ action: 'attachment.delete', changed_fields: ['attachments'] }]);

    // Posts always carry text; an entry with none (imported history) is modelled directly.
    const lone = await upload(h, s.communityId, s.channelId, s.p.cookie, 'lone.txt', 'lone');
    const loneEntry = await say(s, { cookie: s.p.cookie }, 'placeholder', {
      attachmentIds: [lone],
    });
    await h.pool.query("UPDATE entries SET text='' WHERE id=$1", [loneEntry]);
    const tomb = await removed(await removeFile(s, lone, { cookie: s.owner.cookie }), 'lone file');
    expect(tomb).toMatchObject({ text: REMOVED_ENTRY_TEXT.moderator, attachments: [] });
    expect(
      (await h.pool.query('SELECT removed_by FROM entries WHERE id=$1', [loneEntry])).rows[0]
        .removed_by
    ).toBe('moderator');
    expect(
      (
        await h.pool.query('SELECT action,changed_fields FROM audit_events WHERE subject_id=$1', [
          lone,
        ])
      ).rows
    ).toEqual([
      { action: 'attachment.remove', changed_fields: ['text', 'mentions', 'attachments'] },
    ]);

    const unbound = await upload(h, s.communityId, s.channelId, s.p.cookie, 'draft.txt', 'draft');
    const blobKey = (await h.pool.query('SELECT blob_key FROM attachments WHERE id=$1', [unbound]))
      .rows[0].blob_key;
    const redactionsBefore = await count('SELECT 1 FROM entry_redactions WHERE community_id=$1', [
      s.communityId,
    ]);
    const response = await removeFile(s, unbound, { cookie: s.p.cookie });
    expect(response.status).toBe(204);
    expect(
      await count("SELECT 1 FROM managed_blobs WHERE blob_key=$1 AND state='pending_delete'", [
        blobKey,
      ])
    ).toBe(1);
    expect(await count('SELECT 1 FROM pending_blob_deletions WHERE blob_key=$1', [blobKey])).toBe(
      1
    );
    expect(
      await count('SELECT 1 FROM entry_redactions WHERE community_id=$1', [s.communityId])
    ).toBe(redactionsBefore);
    // Another member's file is not theirs to remove.
    const qFile = await upload(h, s.communityId, s.channelId, s.q.cookie, 'q.txt', 'q');
    expect((await removeFile(s, qFile, { cookie: s.p.cookie })).status).toBe(403);
  });
});

describe('concurrency (AC-8)', { timeout: 120_000 }, () => {
  /** Hold the community row so every request queues behind it, then let them go together. */
  const together = <A, B>(s: Scene, waiters: number, start: () => [Promise<A>, Promise<B>]) =>
    holdingLock(
      h,
      'SELECT 1 FROM communities WHERE id=$1 FOR UPDATE',
      [s.communityId],
      async (release) => {
        const running = start();
        await waitForLockWaiters(h, waiters);
        await release();
        return Promise.all(running);
      }
    );

  // Purpose: a reply holds FOR KEY SHARE on its parent while it holds the channel; a removal
  // that took FOR UPDATE on the parent would deadlock with it.
  it('lets a reply and a delete of its parent both succeed', async () => {
    const s = await scene('reply');
    const root = await say(s, { cookie: s.p.cookie });
    const [reply, deletion] = await together(s, 2, () => [
      h.call(`${s.base}/channels/${s.channelId}/entries`, {
        cookie: s.q.cookie,
        body: { text: 'racing reply', idempotencyKey: 'race', parentEntryId: root },
      }),
      removeMessage(s, root, { cookie: s.p.cookie }),
    ]);
    expect([reply.status, deletion.status]).toEqual([201, 200]);
  });

  // Purpose: removal locks members before the entry, as erasure does, so the two never
  // deadlock, and erasure wins: the entry ends as an erased tombstone.
  it('converges on the erased tombstone when a delete races an erasure', async () => {
    const s = await scene('erase');
    const entryId = await say(s, { cookie: s.p.cookie });
    const [erasure, deletion] = await together(s, 2, () => [
      eraseMembership(h.pool, s.communityId, s.p.memberId, { log: () => undefined }),
      removeMessage(s, entryId, { cookie: s.owner.cookie }),
    ]);
    expect(erasure).toBe('erased');
    expect(deletion.status).toBe(200);
    const row = (await h.pool.query('SELECT text,erased_at FROM entries WHERE id=$1', [entryId]))
      .rows[0];
    expect(row.text).toBe(ERASED_ENTRY_TEXT);
    expect(row.erased_at).toBeInstanceOf(Date);
  });

  // Purpose: the removal bumps the content version, so an export snapshotted before it can
  // never commit the deleted message, and leaves no blob behind.
  it('refuses an export snapshotted before the delete and committed after it', async () => {
    const s = await scene('export');
    const entryId = await say(s, { cookie: s.p.cookie }, 'soon gone');
    const blobsBefore = new Set(await readdir(storageDirectory(h)));
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      exportGate = { entered: resolve, release: new Promise<void>((done) => (release = done)) };
    });
    const pending = h.call(`${s.base}/me/export`, { cookie: s.p.cookie, body: {} });
    await reached;
    exportGate = null;
    await removed(await removeMessage(s, entryId, { cookie: s.p.cookie }), 'delete');
    release();
    const response = await pending;
    expect(response.status).toBe(409);
    await drainCleanup(h);
    expect((await readdir(storageDirectory(h))).filter((key) => !blobsBefore.has(key))).toEqual([]);
  });

  /** Where the redaction id sequence stands; identity values are handed out outside commits. */
  async function redactionSequence(): Promise<string> {
    return (
      await h.pool.query<{ value: string }>(
        "SELECT COALESCE(last_value,0)::text AS value FROM pg_sequences WHERE sequencename='entry_redactions_id_seq'"
      )
    ).rows[0].value;
  }

  // Purpose: redaction ids become visible in the order they were assigned. Removal A bumps and
  // pauses before its row; removal B waits on the version row having taken no id. A reader
  // polling by id never sees B's row while A's lower id is missing. With the bump after the
  // insert, both ids would be taken before either waited, and B could commit first.
  it('makes redaction ids visible in the order they were assigned', async () => {
    const s = await scene('order');
    const [aId, bId] = [await say(s, { cookie: s.p.cookie }), await say(s, { cookie: s.p.cookie })];
    const sequenceBefore = await redactionSequence();
    const begin = async (client: PoolClient) => {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM communities WHERE id=$1 FOR SHARE', [s.communityId]);
    };
    const [a, b] = [await h.pool.connect(), await h.pool.connect()];
    const seen: string[][] = [];
    let polling = true;
    const reader = (async () => {
      while (polling) {
        const rows = await h.pool.query<{ entry_id: string }>(
          'SELECT entry_id FROM entry_redactions WHERE community_id=$1 ORDER BY id',
          [s.communityId]
        );
        seen.push(rows.rows.map((row) => row.entry_id));
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();
    try {
      let bumped!: () => void;
      let proceed!: () => void;
      const paused = new Promise<void>((resolve) => (bumped = resolve));
      const resume = new Promise<void>((resolve) => (proceed = resolve));
      await begin(a);
      const removalA = removeEntry(
        a,
        { communityId: s.communityId, entryId: aId, removedBy: 'author' },
        {
          afterVersionBump: async () => {
            bumped();
            await resume;
          },
        }
      ).then(() => a.query('COMMIT'));
      await paused;
      await begin(b);
      const removalB = removeEntry(b, {
        communityId: s.communityId,
        entryId: bId,
        removedBy: 'author',
      }).then(() => b.query('COMMIT'));
      await waitForLockWaiters(h, 1, 'community_content_versions');
      expect(await redactionSequence()).toBe(sequenceBefore);
      proceed();
      await Promise.all([removalA, removalB]);
    } finally {
      polling = false;
      await reader;
      a.release();
      b.release();
    }
    const ids = await h.pool.query<{ entry_id: string }>(
      'SELECT entry_id FROM entry_redactions WHERE community_id=$1 ORDER BY id',
      [s.communityId]
    );
    expect(ids.rows.map((row) => row.entry_id)).toEqual([aId, bId]);
    for (const snapshot of seen) if (snapshot.includes(bId)) expect(snapshot).toContain(aId);
  });

  // Purpose: removing a message and one of its files at once never deadlocks. Both removals take
  // the message first and the file second; a file removal that locked the file first would wait
  // on the message while the message removal waited on the file. The held message row queues
  // them in a known order, so each order is exercised every run.
  it.each(['message first', 'file first'] as const)(
    'removes a message and one of its files together (%s)',
    async (order) => {
      const s = await scene(order === 'message first' ? 'pairm' : 'pairf');
      const fileId = await upload(h, s.communityId, s.channelId, s.p.cookie, 'pair.txt', 'pair');
      const entryId = await say(s, { cookie: s.p.cookie }, 'text and a file', {
        attachmentIds: [fileId],
      });
      const [message, file] = await holdingLock(
        h,
        'SELECT 1 FROM entries WHERE id=$1 FOR NO KEY UPDATE',
        [entryId],
        async (release) => {
          const first =
            order === 'message first'
              ? removeMessage(s, entryId, { cookie: s.p.cookie })
              : removeFile(s, fileId, { cookie: s.p.cookie });
          await waitForLockWaiters(h, 1);
          const second =
            order === 'message first'
              ? removeFile(s, fileId, { cookie: s.p.cookie })
              : removeMessage(s, entryId, { cookie: s.p.cookie });
          await waitForLockWaiters(h, 2);
          await release();
          const [one, two] = await Promise.all([first, second]);
          return order === 'message first' ? [one, two] : [two, one];
        }
      );
      // The message removal took the file with it, so a file removal behind it finds nothing.
      expect([message.status, file.status]).toEqual(
        order === 'message first' ? [200, 404] : [200, 200]
      );
      expect(
        (await h.pool.query('SELECT text FROM entries WHERE id=$1', [entryId])).rows[0].text
      ).toBe(REMOVED_ENTRY_TEXT.author);
      expect(await count('SELECT 1 FROM attachments WHERE id=$1', [fileId])).toBe(0);
    }
  );

  // Purpose: removing a posted file bumps the version before it takes a redaction id, so the id
  // becomes visible in the order it was assigned (as for a message, above).
  it('bumps the version before taking a redaction id when removing a posted file', async () => {
    const s = await scene('fileorder');
    const fileId = await upload(h, s.communityId, s.channelId, s.p.cookie, 'order.txt', 'order');
    const entryId = await say(s, { cookie: s.p.cookie }, 'a file', { attachmentIds: [fileId] });
    const before = await redactionSequence();
    const response = await holdingLock(
      h,
      'SELECT 1 FROM community_content_versions WHERE community_id=$1 FOR UPDATE',
      [s.communityId],
      async (release) => {
        const pending = removeFile(s, fileId, { cookie: s.p.cookie });
        await waitForLockWaiters(h, 1, 'community_content_versions');
        expect(await redactionSequence()).toBe(before);
        await release();
        return pending;
      }
    );
    expect(response.status).toBe(200);
    expect(await redactionsOf(entryId)).toBe(1);
  });

  // Purpose: removing an unposted upload while a post binds it ends one of two honest ways:
  // the upload went first (the post is refused, the file gone) or the post went first (the file
  // is bound, then removed from that entry with a redaction row). Never a bound file whose blob
  // is queued with no redaction row.
  it.each(['removal first', 'post first'] as const)(
    'settles a binding race (%s)',
    async (order) => {
      const s = await scene(order === 'removal first' ? 'bindr' : 'bindp');
      const fileId = await upload(h, s.communityId, s.channelId, s.p.cookie, 'race.txt', 'race');
      const blobKey = (await h.pool.query('SELECT blob_key FROM attachments WHERE id=$1', [fileId]))
        .rows[0].blob_key;
      const postIt = () =>
        h.call(`${s.base}/channels/${s.channelId}/entries`, {
          cookie: s.p.cookie,
          body: { text: 'binding', idempotencyKey: `bind-${order}`, attachmentIds: [fileId] },
        });
      const removeIt = () => removeFile(s, fileId, { cookie: s.owner.cookie });
      const [posted, removal] = await holdingLock(
        h,
        'SELECT 1 FROM attachments WHERE id=$1 FOR UPDATE',
        [fileId],
        async (release) => {
          const firstCall = order === 'removal first' ? removeIt() : postIt();
          await waitForLockWaiters(h, 1);
          const secondCall = order === 'removal first' ? postIt() : removeIt();
          await waitForLockWaiters(h, 2);
          await release();
          const [one, two] = await Promise.all([firstCall, secondCall]);
          return order === 'removal first' ? [two, one] : [one, two];
        }
      );
      expect(await count('SELECT 1 FROM attachments WHERE id=$1', [fileId])).toBe(0);
      expect(await count('SELECT 1 FROM pending_blob_deletions WHERE blob_key=$1', [blobKey])).toBe(
        1
      );
      if (order === 'removal first') {
        expect([posted.status, removal.status]).toEqual([409, 204]);
      } else {
        expect([posted.status, removal.status]).toEqual([201, 200]);
        const entryId = (await posted.json()).entry.id;
        expect((await removal.json()).entry).toMatchObject({ id: entryId, attachments: [] });
        expect(await redactionsOf(entryId)).toBe(1);
      }
    }
  );
});

describe('erasure on the shared module (AC-10)', { timeout: 120_000 }, () => {
  // Purpose: the intended differences: every erasure transaction that writes redaction rows
  // bumps the version before it takes a redaction id. The version row is held when the file,
  // tombstone, and mention steps start; each must wait there with no id taken. Before the
  // refactor the tombstone and mention steps inserted first and bumped last, and the file step
  // (whose scene has a posted file, so it now writes a row) wrote none.
  it('bumps the content version before taking a redaction id', async () => {
    const s = await scene('erasureorder');
    const checks: { step: string; unchanged: boolean }[] = [];
    const background: Promise<void>[] = [];
    await eraseMembership(h.pool, s.communityId, s.p.memberId, {
      log: () => undefined,
      hooks: {
        afterStep: async (step) => {
          if (!['end-access', 'exports', 'tombstones'].includes(step)) return;
          const holder = await h.pool.connect();
          await holder.query('BEGIN');
          await holder.query(
            'SELECT 1 FROM community_content_versions WHERE community_id=$1 FOR UPDATE',
            [s.communityId]
          );
          const before = await redactionSequence();
          background.push(
            (async () => {
              try {
                await waitForLockWaiters(h, 1, 'community_content_versions');
                checks.push({ step, unchanged: (await redactionSequence()) === before });
              } finally {
                await holder.query('COMMIT');
                holder.release();
              }
            })()
          );
        },
      },
    });
    await Promise.all(background);
    expect(checks).toEqual([
      { step: 'end-access', unchanged: true },
      { step: 'exports', unchanged: true },
      { step: 'tombstones', unchanged: true },
    ]);
  });

  async function redactionSequence(): Promise<string> {
    return (
      await h.pool.query<{ value: string }>(
        "SELECT COALESCE(last_value,0)::text AS value FROM pg_sequences WHERE sequencename='entry_redactions_id_seq'"
      )
    ).rows[0].value;
  }
});
