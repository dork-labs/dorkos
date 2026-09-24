import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import {
  CommunityWireEntryPageSchema,
  CommunityWireErasureResponseSchema,
} from '@dorkos/shared/community-wire';
import {
  admit,
  bootstrapHost,
  claimAsNewAccount,
  createChannel,
  createPendingCommunity,
  startTenancyHarness,
  type TenancyHarness,
  type TenancyMember,
} from './tenancy-test-harness.js';
import {
  body,
  CANARY,
  drainCleanup,
  hoursFromNow,
  PASSWORD,
  person,
  personNeedles,
  post,
  PERSON,
  runErasures,
  scanBlobs,
  scanDatabase,
  scanUuidColumns,
  seedCanaries,
  sweepAbandonedPairings,
  storageDirectory,
  type Hit,
  type Person,
  type Seeded,
} from './member-erasure-fixture.js';

// Purpose: prove that erasing a person leaves no copy of their name, handle, email, account
// link, words, file names, file bytes, or hashes of them on the Community server (AC-1), that
// threads keep their shape (AC-2), that mentions of them are rewritten (AC-3), that files and
// exports go (AC-4), and that the only matches left are the named leftovers (AC-10).

let h: TenancyHarness;
let ownerA: TenancyMember;
let ownerB: TenancyMember;
let q: Person;
let pA: Person;
let pB: Person;
let seededA: Seeded;
let seededB: Seeded;
let communityA: string;
let communityB: string;
let needles: string[];
let before: {
  entries: {
    id: string;
    seq: string;
    parent_entry_id: string | null;
    thread_root_entry_id: string | null;
    created_at: Date;
  }[];
  pageCursor: string;
  liveCursor: string;
  qThanks: { id: string; text: string; key: string };
  qAgentMention: string;
  qCode: string;
  qFreeText: string;
  qEmailShaped: string;
  qReplyToP: string;
  exports: { personal: string; owner: string };
  blobsA: string[];
  blobsB: string[];
  adminChannelId: string;
};
const logs: string[] = [];

function scopedHits(hits: Hit[], communityId: string) {
  return hits.filter((hit) => hit.communityId === communityId);
}

/**
 * An unused pairing request names an install but no person, so erasure cannot find it; it
 * lives until the sweep, at most 70 minutes after it started. Named here until then.
 */
let abandonedPairingsSwept = false;

/** The matches erasure may leave, each named so nobody later claims otherwise (AC-10). */
function isNamedLeftover(hit: Hit): boolean {
  if (
    !abandonedPairingsSwept &&
    hit.table === 'connection_pairings' &&
    hit.column === 'install_name' &&
    hit.needle === CANARY.abandoned
  )
    return true;
  if (hit.table === 'channels' && hit.column === 'name' && hit.rowId === before.adminChannelId)
    return true;
  if (hit.table !== 'entries' || hit.column !== 'text') return false;
  return [before.qCode, before.qFreeText, before.qEmailShaped].includes(hit.rowId ?? '');
}

beforeAll(async () => {
  h = await startTenancyHarness('erasure');
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[method].bind(console);
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
      original(...args);
    });
  }
  const host = await bootstrapHost(h, 'Olive Host', 'olive@host.test');
  const a = await createPendingCommunity(h, host.cookie, 'Alpha');
  ownerA = await claimAsNewAccount(h, a.token, 'Ada Owner', 'ada@alpha.test');
  const b = await createPendingCommunity(h, host.cookie, 'Beta');
  ownerB = await claimAsNewAccount(h, b.token, 'Bea Owner', 'bea@beta.test');
  communityA = a.communityId;
  communityB = b.communityId;
  pA = await person(h, await admit(h, communityA, ownerA.cookie, PERSON));
  q = await person(
    h,
    await admit(h, communityA, ownerA.cookie, { name: 'Quentin Reader', email: 'qr@alpha.test' })
  );
  pB = await person(h, await admit(h, communityB, ownerB.cookie, { cookie: pA.cookie }));
  const channelA = await createChannel(h, communityA, ownerA.cookie, 'general', [
    pA.cookie,
    q.cookie,
  ]);
  const channelB = await createChannel(h, communityB, ownerB.cookie, 'general', [pB.cookie]);
  seededA = await seedCanaries(h, {
    communityId: communityA,
    channelId: channelA,
    p: pA,
    other: q,
  });
  seededB = await seedCanaries(h, {
    communityId: communityB,
    channelId: channelB,
    p: pB,
    other: ownerB,
  });

  const baseA = `/api/v1/communities/${communityA}`;
  // As an admin, P names a channel: a community setting, a named leftover.
  await body(
    await h.call(`${baseA}/members/${pA.memberId}/role`, {
      method: 'PATCH',
      cookie: ownerA.cookie,
      body: { role: 'admin' },
    }),
    200,
    'promote P'
  );
  const adminChannel = await body<{ channel: { id: string } }>(
    await h.call(`${baseA}/channels`, {
      cookie: pA.cookie,
      body: { name: CANARY.channel, visibility: 'public' },
    }),
    201,
    'P names a channel'
  );

  const qPost = (text: string, key: string, parentEntryId?: string) =>
    post(
      h,
      communityA,
      channelA,
      { cookie: q.cookie },
      { text, idempotencyKey: key, parentEntryId }
    );
  const thanks = await qPost(`@${pA.handle} thanks`, 'q-thanks');
  const agentMention = await qPost(`@${seededA.agent.handle} hello`, 'q-agent');
  const code = await qPost(`\`\`\`\n@${pA.handle}\n\`\`\``, 'q-code');
  const freeText = await qPost('thanks Zephyrine', 'q-free');
  const emailShaped = await qPost(`write to bob@${pA.handle}`, 'q-email');
  const qReply = await qPost('replying to your post', 'q-reply', seededA.rootEntryId);

  const personal = await body<{ archiveId: string }>(
    await h.call(`${baseA}/me/export`, { cookie: q.cookie, body: {} }),
    201,
    'personal export'
  );
  const owner = await body<{ archiveId: string }>(
    await h.call(`${baseA}/owner/export`, { cookie: ownerA.cookie, body: { password: PASSWORD } }),
    201,
    'owner export'
  );
  // Better Auth keeps one-time identifiers with the account id or email as the value.
  await h.pool.query(
    `INSERT INTO verification(id,identifier,value,"expiresAt")
     VALUES('v1','reset-password:token-one',$1,now()+interval '1 hour'),
           ('v2','email-verification',$2,now()+interval '1 hour')`,
    [pA.userId, PERSON.email]
  );

  const page = await body<{ nextCursor: string }>(
    await h.call(`${baseA}/channels/${channelA}/entries?limit=1`, { cookie: q.cookie }),
    200,
    'page before'
  );
  const blobs = async (communityId: string) =>
    (
      await h.pool.query<{ blob_key: string }>(
        'SELECT blob_key FROM managed_blobs WHERE community_id=$1',
        [communityId]
      )
    ).rows.map((row) => row.blob_key);
  before = {
    entries: (
      await h.pool.query(
        `SELECT e.id,e.seq,e.parent_entry_id,e.thread_root_entry_id,e.created_at FROM entries e
         LEFT JOIN agents a ON a.id=e.author_agent_id
         WHERE e.community_id=$1 AND (e.author_member_id=$2 OR a.owner_member_id=$2)
         ORDER BY e.id`,
        [communityA, pA.memberId]
      )
    ).rows,
    pageCursor: page.nextCursor,
    liveCursor: thanks.cursor,
    qThanks: { id: thanks.id, text: `@${pA.handle} thanks`, key: 'q-thanks' },
    qAgentMention: agentMention.id,
    qCode: code.id,
    qFreeText: freeText.id,
    qEmailShaped: emailShaped.id,
    qReplyToP: qReply.id,
    exports: { personal: personal.archiveId, owner: owner.archiveId },
    blobsA: await blobs(communityA),
    blobsB: await blobs(communityB),
    adminChannelId: adminChannel.channel.id,
  };
  needles = [
    ...(await personNeedles(h.pool, pA, [seededA.agent.handle, seededB.agent.handle])),
    pA.userId,
  ];
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await h?.close();
});

describe('residue scan (AC-1, AC-10)', () => {
  it('finds every canary before erasure, so a clean scan later means something', async () => {
    const hits = await scanDatabase(h.pool, needles);
    const blobHits = await scanBlobs(storageDirectory(h), needles);
    for (const communityId of [communityA, communityB]) {
      const found = new Set(scopedHits(hits, communityId).map((hit) => hit.needle));
      for (const canary of Object.values(CANARY)) {
        if (canary === CANARY.bytes || canary === CANARY.unboundBytes) continue;
        if (canary === CANARY.channel && communityId === communityB) continue;
        expect(found, `${canary} in ${communityId}`).toContain(canary.toLowerCase());
      }
      for (const needle of [pA.handle, 'zephyrine', 'quill'])
        expect(found, `${needle} in ${communityId}`).toContain(needle);
    }
    // Declined and abandoned pairings, the agent's local id, and the idempotency key each sit
    // in their own column; name them so a scan that skipped one could not pass.
    const columns = new Set(hits.map((hit) => `${hit.table}.${hit.column}:${hit.needle}`));
    for (const expected of [
      `connection_pairings.install_name:${CANARY.declined}`,
      `connection_pairings.install_name:${CANARY.abandoned}`,
      `connection_grants.install_name:${CANARY.laptop}`,
      `agents.local_agent_id:${CANARY.localAgent}`,
      `entries.idempotency_key:${CANARY.key}`,
      `attachments.display_name:${CANARY.file}`,
      `members.display_name:zephyrine quill`,
      `user.email:${PERSON.email}`,
      `verification.value:${PERSON.email}`,
    ])
      expect(columns, expected).toContain(expected);
    // The account id sits in every admission record in A; name them so the scan must see them.
    const inAColumns = new Set(
      scopedHits(hits, communityA)
        .filter((hit) => hit.needle === pA.userId.toLowerCase())
        .map((hit) => `${hit.table}.${hit.column}`)
    );
    for (const expected of [
      'members.user_id',
      'invite_uses.user_id',
      'pending_admissions.account_id',
      'admission_receipts.account_id',
    ])
      expect(inAColumns, expected).toContain(expected);
    // So does the member id, in uuid columns the text scan cannot see.
    expect(await scanUuidColumns(h.pool, communityA, pA.memberId)).toEqual(
      expect.arrayContaining(['admission_receipts.member_id', 'connection_grants.member_id'])
    );
    // Hashes of P's payloads and file bytes are found where they are stored.
    const hashes = needles.filter((needle) => /^[a-f0-9]{64}$/.test(needle));
    expect(hashes.length).toBeGreaterThanOrEqual(6);
    for (const hash of hashes)
      expect(
        hits.some((hit) => hit.needle === hash),
        hash
      ).toBe(true);
    const blobNeedles = new Set(blobHits.map((hit) => hit.needle));
    expect(blobNeedles).toContain(CANARY.bytes);
    expect(blobNeedles).toContain(CANARY.unboundBytes);
    // The exports are archives of the canary rows.
    expect(blobHits.some((hit) => hit.needle === PERSON.email)).toBe(true);
  });

  it('erases P from A: nothing of P is left in A, its blobs, or the logs; B keeps everything', async () => {
    const requested = await body<{ erasure: { id: string; state: string } }>(
      await h.call('/api/v1/account/erasures', {
        cookie: pA.cookie,
        body: { kind: 'membership', communityId: communityA, password: PASSWORD },
      }),
      201,
      'request membership erasure'
    );
    expect(requested.erasure.state).toBe('scheduled');
    const lines: string[] = [];
    expect(await runErasures(h.pool, hoursFromNow(73), { log: (line) => lines.push(line) })).toBe(
      1
    );
    expect(lines).toEqual([
      JSON.stringify({
        event: 'community.member_erased',
        communityId: communityA,
        memberId: pA.memberId,
      }),
    ]);
    await drainCleanup(h);

    const hits = await scanDatabase(h.pool, needles);
    const inA = scopedHits(hits, communityA);
    expect(inA.filter((hit) => !isNamedLeftover(hit))).toEqual([]);
    // Each named leftover is really there, so the allowance above is exact.
    const leftoverRows = new Set(inA.map((hit) => hit.rowId));
    for (const row of [before.qCode, before.qFreeText, before.qEmailShaped, before.adminChannelId])
      expect(leftoverRows).toContain(row);
    // The member id survives only where the husk must be pointed at: the husk itself, its
    // entries, agents and handle, the audit trail, and the erasure request.
    expect(await scanUuidColumns(h.pool, communityA, pA.memberId)).toEqual([
      'agents.owner_member_id',
      'audit_events.actor_member_id',
      'community_handles.member_id',
      'entries.author_member_id',
      'erasure_requests.member_id',
      'members.id',
    ]);
    // The unused pairing request is gone once the sweep reaches it.
    await sweepAbandonedPairings(h, [communityA]);
    abandonedPairingsSwept = true;
    expect(
      scopedHits(await scanDatabase(h.pool, needles), communityA).filter(
        (hit) => !isNamedLeftover(hit)
      )
    ).toEqual([]);

    // B still holds every canary of P.
    const inB = new Set(scopedHits(hits, communityB).map((hit) => hit.needle));
    for (const canary of Object.values(CANARY)) {
      if ([CANARY.bytes, CANARY.unboundBytes, CANARY.channel].includes(canary as never)) continue;
      expect(inB, canary).toContain(canary.toLowerCase());
    }
    const blobHits = await scanBlobs(storageDirectory(h), needles);
    expect(blobHits.filter((hit) => !before.blobsB.includes(hit.key))).toEqual([]);
    expect(new Set(blobHits.map((hit) => hit.needle))).toContain(CANARY.bytes);
    expect(
      logs.filter((line) =>
        needles.some((needle) => line.toLowerCase().includes(needle.toLowerCase()))
      )
    ).toEqual([]);

    // The husk: nothing leads back to the account, and the audit row names only the husk.
    const husk = (
      await h.pool.query(
        'SELECT display_name,handle,user_id,active,erased_at FROM members WHERE id=$1',
        [pA.memberId]
      )
    ).rows[0];
    expect(husk).toMatchObject({ display_name: 'Erased member', user_id: null, active: false });
    expect(husk.handle).toMatch(/^erased-[a-z2-7]{12}$/);
    const audit = await h.pool.query(
      `SELECT actor_member_id,actor_kind,subject_id,prior_state,next_state,changed_fields
       FROM audit_events WHERE community_id=$1 AND action='member.erase.complete'`,
      [communityA]
    );
    expect(audit.rows).toEqual([
      {
        actor_member_id: null,
        actor_kind: 'system',
        subject_id: pA.memberId,
        prior_state: null,
        next_state: null,
        changed_fields: [],
      },
    ]);
  });

  it('keeps every thread in shape and parses with the unchanged wire (AC-2)', async () => {
    const base = `/api/v1/communities/${communityA}/channels/${seededA.channelId}`;
    const after = (
      await h.pool.query(
        `SELECT id,seq,parent_entry_id,thread_root_entry_id,created_at FROM entries
         WHERE id=ANY($1::uuid[]) ORDER BY id`,
        [before.entries.map((entry) => entry.id)]
      )
    ).rows;
    expect(after).toEqual(before.entries);
    const page = CommunityWireEntryPageSchema.parse(
      await body(await h.call(`${base}/entries?limit=100`, { cookie: q.cookie }), 200, 'history')
    );
    const erased = page.entries.filter((entry) =>
      before.entries.some((row) => row.id === entry.id)
    );
    expect(erased.length).toBeGreaterThanOrEqual(3);
    for (const entry of erased) {
      expect(entry.text).toBe('This message was erased.');
      expect(entry.authorDisplayName).toBe(
        entry.authorKind === 'agent' ? 'Erased agent' : 'Erased member'
      );
      expect(entry.mentions).toEqual([]);
      expect(entry.attachments).toEqual([]);
    }
    expect(erased.some((entry) => entry.authorKind === 'agent')).toBe(true);
    const thread = CommunityWireEntryPageSchema.parse(
      await body(
        await h.call(`${base}/entries?thread=${seededA.rootEntryId}`, { cookie: q.cookie }),
        200,
        'thread'
      )
    );
    expect(thread.entries.map((entry) => entry.id)).toEqual([
      seededA.rootEntryId,
      before.qReplyToP,
    ]);
    expect(thread.entries[1].parentEntryId).toBe(seededA.rootEntryId);
    // Cursors taken before erasure still work: seq and epoch did not move.
    await body(
      await h.call(`${base}/entries?cursor=${encodeURIComponent(before.pageCursor)}`, {
        cookie: q.cookie,
      }),
      200,
      'page cursor after erasure'
    );
    const controller = new AbortController();
    const live = await fetch(`${h.baseUrl}${base}/events`, {
      headers: { cookie: q.cookie, 'last-event-id': before.liveCursor },
      signal: controller.signal,
    });
    expect(live.status).toBe(200);
    controller.abort();
  });

  it('rewrites mentions of P and P’s agent, and leaves code alone (AC-3)', async () => {
    const texts = new Map(
      (
        await h.pool.query<{ id: string; text: string; payload_hash: string }>(
          'SELECT id,text,payload_hash FROM entries WHERE id=ANY($1::uuid[])',
          [[before.qThanks.id, before.qAgentMention, before.qCode, before.qEmailShaped]]
        )
      ).rows.map((row) => [row.id, row.text])
    );
    expect(texts.get(before.qThanks.id)).toBe('@[erased] thanks');
    expect(texts.get(before.qAgentMention)).toBe('@[erased] hello');
    expect(texts.get(before.qCode)).toBe(`\`\`\`\n@${pA.handle}\n\`\`\``);
    expect(texts.get(before.qEmailShaped)).toBe(`write to bob@${pA.handle}`);
    const mentions = await h.pool.query(
      'SELECT 1 FROM entry_mentions WHERE mentioned_member_id=$1 OR mentioned_agent_id=$2',
      [pA.memberId, seededA.agent.id]
    );
    expect(mentions.rowCount).toBe(0);
    // Q's own retry still replays: their payload hash and key did not change.
    const retry = await h.call(
      `/api/v1/communities/${communityA}/channels/${seededA.channelId}/entries`,
      { cookie: q.cookie, body: { text: before.qThanks.text, idempotencyKey: before.qThanks.key } }
    );
    expect(retry.status).toBe(200);
    // Every changed entry of P and of Q has exactly one redaction row for the feed.
    const redactions = await h.pool.query<{ entry_id: string }>(
      'SELECT entry_id FROM entry_redactions WHERE community_id=$1',
      [communityA]
    );
    const redacted = redactions.rows.map((row) => row.entry_id).sort();
    expect(redacted).toEqual(
      [
        ...before.entries.map((entry) => entry.id),
        before.qThanks.id,
        before.qAgentMention,
        // Today's resolver read `bob@handle` as a mention; its row went, so the entry changed.
        before.qEmailShaped,
      ].sort()
    );
  });

  it('removes P’s files and every live export, and a new export keeps only the husk (AC-4)', async () => {
    const base = `/api/v1/communities/${communityA}`;
    expect(
      (await h.call(`${base}/attachments/${seededA.attachmentId}`, { cookie: q.cookie })).status
    ).toBe(404);
    const blobs = await scanBlobs(storageDirectory(h), []);
    for (const key of before.blobsA) {
      expect(blobs.some((blob) => blob.key === key)).toBe(false);
      const managed = await h.pool.query('SELECT 1 FROM managed_blobs WHERE blob_key=$1', [key]);
      expect(managed.rowCount).toBe(0);
    }
    expect(
      (await h.call(`${base}/exports/${before.exports.personal}`, { cookie: q.cookie })).status
    ).toBe(404);
    expect(
      (await h.call(`${base}/exports/${before.exports.owner}`, { cookie: ownerA.cookie })).status
    ).toBe(404);

    const fresh = await body<{ archiveId: string }>(
      await h.call(`${base}/owner/export`, { cookie: ownerA.cookie, body: { password: PASSWORD } }),
      201,
      'owner export after erasure'
    );
    const download = await h.call(`${base}/exports/${fresh.archiveId}`, { cookie: ownerA.cookie });
    expect(download.status).toBe(200);
    const archive = unzipSync(new Uint8Array(await download.arrayBuffer()));
    const manifest = JSON.parse(strFromU8(archive['manifest.json'])) as {
      members: { id: string; display_name: string; email: string | null }[];
    };
    expect(manifest.members.find((member) => member.id === pA.memberId)).toMatchObject({
      display_name: 'Erased member',
      email: null,
    });
    const text = strFromU8(archive['manifest.json']).toLowerCase();
    // Only the named leftovers' words may appear: Q's free text, code, and email-shaped text,
    // and the channel P named.
    const leftoverWords = [CANARY.channel, pA.handle, 'Zephyrine', 'Quill'];
    expect(
      needles.filter(
        (needle) => text.includes(needle.toLowerCase()) && !leftoverWords.includes(needle)
      )
    ).toEqual([]);
  });

  it('deletes P’s account: no canary anywhere but the named leftovers', async () => {
    const requested = CommunityWireErasureResponseSchema.parse(
      await body(
        await h.call('/api/v1/account/erasures', {
          cookie: pA.cookie,
          body: { kind: 'account', confirmEmail: PERSON.email, password: PASSWORD },
        }),
        201,
        'request account erasure'
      )
    );
    expect(requested.erasure.kind).toBe('account');
    expect(await runErasures(h.pool, hoursFromNow(73))).toBeGreaterThanOrEqual(1);
    await drainCleanup(h);
    await sweepAbandonedPairings(h, [communityA, communityB]);
    const hits = await scanDatabase(h.pool, needles);
    expect(hits.filter((hit) => !isNamedLeftover(hit))).toEqual([]);
    expect(await scanUuidColumns(h.pool, communityB, pB.memberId)).toEqual([
      'agents.owner_member_id',
      'audit_events.actor_member_id',
      'community_handles.member_id',
      'entries.author_member_id',
      'erasure_requests.member_id',
      'members.id',
    ]);
    // The only object left holding any needle is the owner export made after the first
    // erasure, which copies the named leftovers and nothing else.
    const leftoverWords = [CANARY.channel, pA.handle, 'Zephyrine', 'Quill'];
    expect(
      (await scanBlobs(storageDirectory(h), needles)).filter(
        (hit) => !leftoverWords.includes(hit.needle)
      )
    ).toEqual([]);
    for (const [table, column] of [
      ['"user"', 'id'],
      ['session', '"userId"'],
      ['account', '"userId"'],
      ['verification', 'value'],
    ])
      expect(
        (await h.pool.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`, [pA.userId])).rowCount
      ).toBe(0);
    // The one line that names the account id is the completion record hosts keep outside
    // their backups to re-apply the erasure; it carries the random id and nothing else.
    const record = JSON.stringify({ event: 'community.account_erased', userId: pA.userId });
    expect(
      logs.filter(
        (line) =>
          line !== record &&
          needles.some((needle) => line.toLowerCase().includes(needle.toLowerCase()))
      )
    ).toEqual([]);
    expect(logs).toContain(record);
    const husk = (
      await h.pool.query('SELECT display_name,user_id FROM members WHERE id=$1', [pB.memberId])
    ).rows[0];
    expect(husk).toEqual({ display_name: 'Erased member', user_id: null });
  });

  it('lets a newcomer take the released handle, and it then names only them (AC-3)', async () => {
    const newcomer = await person(
      h,
      await admit(h, communityA, ownerA.cookie, { name: PERSON.name, email: 'newcomer@alpha.test' })
    );
    expect(newcomer.handle).toBe(pA.handle);
    await body(
      await h.call(`/api/v1/communities/${communityA}/channels/${seededA.channelId}/join`, {
        cookie: newcomer.cookie,
        body: {},
      }),
      200,
      'newcomer joins'
    );
    const response = await body<{ entry: { mentions: string[] } }>(
      await h.call(`/api/v1/communities/${communityA}/channels/${seededA.channelId}/entries`, {
        cookie: q.cookie,
        body: { text: `@${pA.handle} welcome`, idempotencyKey: 'welcome' },
      }),
      201,
      'mention newcomer'
    );
    expect(response.entry.mentions).toEqual([newcomer.memberId]);
  });
});
