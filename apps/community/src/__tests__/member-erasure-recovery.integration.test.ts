import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eraseMembership } from '../erasure/erasure.js';
import { parseErasureJournal, reapplyErasures } from '../erasure/reapply.js';
import { sweepExpiredPairings } from '../routes/pairings.js';
import {
  bootstrapHost,
  startTenancyHarness,
  waitForLockWaiters,
  type TenancyHarness,
} from './tenancy-test-harness.js';
import {
  body,
  drainCleanup,
  hoursFromNow,
  PASSWORD,
  runErasures,
  scanBlobs,
  scanDatabase,
  startPairing,
  storageDirectory,
} from './member-erasure-fixture.js';
import {
  communityDigest,
  makeScene,
  requestErasure as requestFor,
  shapeDigest,
} from './member-erasure-scenes.js';
import { drainExports, openArchive } from './export-test-helpers.js';

// Purpose: crash safety and idempotence (AC-8), the export and upload races (AC-4), lock
// behaviour (AC-11), pairing cleanup, and re-applying erasures after a backup restore (AC-12).

let h: TenancyHarness;
let host: { cookie: string; communityId: string };
const scene = (label: string) => makeScene(h, host.cookie, label);
const requestErasure = (cookie: string, communityId: string) => requestFor(h, cookie, communityId);

beforeAll(async () => {
  h = await startTenancyHarness('erasurerecovery');
  host = await bootstrapHost(h, 'Hana Host', 'hana@host.test');
}, 60_000);

afterAll(async () => {
  await h?.close();
});

// Each test runs whole erasures several times over; under load they outlast the 30s default.
describe('crash and repeat (AC-8)', { timeout: 120_000 }, () => {
  // Purpose: a long erasure keeps its lease after every step, for its own request and for
  // the account request it belongs to, so a second worker never resumes it mid-run.
  it('renews the lease of the membership and its account request after each step', async () => {
    const s = await scene('lease');
    const account = await h.pool.query<{ id: string }>(
      `INSERT INTO erasure_requests(kind,user_id,state,execute_after,started_at,next_attempt_at)
       VALUES('account',$1,'running',now(),now(),now()+interval '1 minute') RETURNING id`,
      [s.p.userId]
    );
    await h.pool.query(
      `INSERT INTO erasure_requests(kind,community_id,member_id,parent_request_id,state,
         execute_after,started_at,next_attempt_at)
       VALUES('membership',$1,$2,$3,'running',now(),now(),now()+interval '1 minute')`,
      [s.communityId, s.p.memberId, account.rows[0].id]
    );
    const leases: { step: string; leased: boolean }[] = [];
    await eraseMembership(h.pool, s.communityId, s.p.memberId, {
      requestId: account.rows[0].id,
      log: () => undefined,
      hooks: {
        afterStep: async (step) => {
          const rows = await h.pool.query<{ leased: boolean }>(
            `SELECT next_attempt_at>now()+interval '4 minutes' AS leased FROM erasure_requests
             WHERE state='running' AND (id=$1 OR member_id=$2)`,
            [account.rows[0].id, s.p.memberId]
          );
          // Reset, so the next step must renew again.
          await h.pool.query(
            `UPDATE erasure_requests SET next_attempt_at=now()+interval '1 minute'
             WHERE state='running' AND (id=$1 OR member_id=$2)`,
            [account.rows[0].id, s.p.memberId]
          );
          if (step !== 'seal')
            leases.push({
              step,
              leased: rows.rows.every((row) => row.leased) && rows.rowCount === 2,
            });
        },
      },
    });
    expect(leases).toEqual(
      ['end-access', 'files', 'exports', 'tombstones', 'mentions'].map((step) => ({
        step,
        leased: true,
      }))
    );
  });

  it('ends in the same state whichever step the worker died after', async () => {
    const baseline = await scene('crash');
    await requestErasure(baseline.p.cookie, baseline.communityId);
    await runErasures(h.pool, hoursFromNow(73));
    const expected = await shapeDigest(h.pool, baseline);
    expect(expected).toContain('"erased":true');
    for (const step of [
      'end-access',
      'files',
      'exports',
      'tombstones',
      'mentions',
      'seal',
    ] as const) {
      const s = await scene('crash');
      const { erasure } = await requestErasure(s.p.cookie, s.communityId);
      await runErasures(h.pool, hoursFromNow(73), {
        hooks: {
          afterStep: async (at) => {
            if (at === step) throw new Error(`worker died after ${step}`);
          },
        },
      });
      // The run really died there: before the seal it is left running with an error class;
      // after the seal's commit it is already complete.
      expect(
        (
          await h.pool.query('SELECT state,last_error_class FROM erasure_requests WHERE id=$1', [
            erasure.id,
          ])
        ).rows[0],
        step
      ).toEqual(
        step === 'seal'
          ? { state: 'completed', last_error_class: null }
          : { state: 'running', last_error_class: 'ERASURE_FAILED' }
      );
      // Let the lease and backoff expire, then another worker resumes.
      await runErasures(h.pool, hoursFromNow(80));
      expect(await shapeDigest(h.pool, s), step).toBe(expected);
    }
  });

  it('ends in the same state when an account erasure dies between its steps', async () => {
    const shapes: string[] = [];
    for (const crashAt of [null, 'account', 'tombstones'] as const) {
      const s = await scene('crashaccount');
      const email = (await h.pool.query('SELECT email FROM "user" WHERE id=$1', [s.p.userId]))
        .rows[0].email;
      await body(
        await h.call('/api/v1/account/erasures', {
          cookie: s.p.cookie,
          body: { kind: 'account', confirmEmail: email, password: PASSWORD },
        }),
        201,
        'account erasure'
      );
      let died = false;
      await runErasures(h.pool, hoursFromNow(73), {
        hooks: {
          afterStep: async (at) => {
            if (at === crashAt && !died) {
              died = true;
              throw new Error('worker died');
            }
          },
        },
      });
      await runErasures(h.pool, hoursFromNow(80));
      expect((await h.pool.query('SELECT 1 FROM "user" WHERE id=$1', [s.p.userId])).rowCount).toBe(
        0
      );
      shapes.push(await shapeDigest(h.pool, s));
    }
    expect(new Set(shapes).size).toBe(1);
  });

  it('removes what slipped past a missed guard between steps 1 and 6', async () => {
    const s = await scene('slip');
    await requestErasure(s.p.cookie, s.communityId);
    await runErasures(h.pool, hoursFromNow(73), {
      hooks: {
        afterStep: async (step) => {
          if (step !== 'end-access') return;
          // Write as if a guard had missed: a post, an upload, an agent, and a connection.
          await h.pool.query(
            `WITH next AS (UPDATE channels SET last_seq=last_seq+1 WHERE id=$2 RETURNING last_seq)
             INSERT INTO entries(community_id,channel_id,seq,author_member_id,author_display_name,
               text,idempotency_key,payload_hash)
             SELECT $1,$2,last_seq,$3,'Pat','slipped text','slipped','x' FROM next`,
            [s.communityId, s.channelId, s.p.memberId]
          );
          const key = 'f'.repeat(64);
          await h.pool.query(
            `INSERT INTO managed_blobs(blob_key,community_id,purpose,community_lifecycle_version,
               state,byte_size,checksum,stored_at,committed_at)
             VALUES($1,$2,'attachment',2,'committed',4,$3,now(),now())`,
            [key, s.communityId, 'a'.repeat(64)]
          );
          await h.pool.query(
            `INSERT INTO attachments(community_id,channel_id,uploader_member_id,blob_key,
               display_name,content_type,byte_size,checksum)
             VALUES($1,$2,$3,$4,'slipped.txt','text/plain',4,$5)`,
            [s.communityId, s.channelId, s.p.memberId, key, 'a'.repeat(64)]
          );
          const agent = await h.pool.query<{ id: string }>(
            `INSERT INTO agents(community_id,owner_member_id,display_name,handle,local_agent_id)
             VALUES($1,$2,'Slipped Bot','slipped-bot','slipped-local') RETURNING id`,
            [s.communityId, s.p.memberId]
          );
          await h.pool.query(
            'INSERT INTO community_handles(community_id,handle,agent_id) VALUES($1,$2,$3)',
            [s.communityId, 'slipped-bot', agent.rows[0].id]
          );
          await h.pool.query(
            'INSERT INTO agent_credentials(community_id,agent_id,token_hash) VALUES($1,$2,$3)',
            [s.communityId, agent.rows[0].id, randomUUID()]
          );
          await h.pool.query(
            `INSERT INTO connection_grants(community_id,member_id,token_hash,install_name,scopes)
             VALUES($1,$2,$3,'slipped laptop',ARRAY['read'])`,
            [s.communityId, s.p.memberId, randomUUID()]
          );
        },
      },
    });
    const left = await scanDatabase(h.pool, ['slipped']);
    expect(left).toEqual([]);
    const agents = await h.pool.query(
      `SELECT display_name,active FROM agents WHERE owner_member_id=$1`,
      [s.p.memberId]
    );
    expect(agents.rows.every((row) => row.display_name === 'Erased agent' && !row.active)).toBe(
      true
    );
  });

  it('changes nothing when run again or re-applied after completion', async () => {
    const s = await scene('repeat');
    await requestErasure(s.p.cookie, s.communityId);
    await runErasures(h.pool, hoursFromNow(73));
    const settled = await communityDigest(h.pool, s.communityId, ['communities']);
    expect(await eraseMembership(h.pool, s.communityId, s.p.memberId)).toBe('already-erased');
    await reapplyErasures(h.pool, [
      { kind: 'member', communityId: s.communityId, memberId: s.p.memberId },
    ]);
    expect(await communityDigest(h.pool, s.communityId, ['communities'])).toBe(settled);
  });
});

describe('files and export races (AC-4)', () => {
  /** Ask for an owner export in a scene and return its id. */
  async function ownerExport(s: Awaited<ReturnType<typeof scene>>): Promise<string> {
    const created = await body<{ export: { id: string } }>(
      await h.call(`${s.base}/owner/export`, {
        cookie: s.owner.cookie,
        body: { password: PASSWORD },
      }),
      202,
      'owner export'
    );
    return created.export.id;
  }

  /** The archive's member row and messages for one person. */
  async function exportedPerson(
    s: Awaited<ReturnType<typeof scene>>,
    exportId: string,
    memberId: string
  ) {
    const response = await h.call(`${s.base}/exports/${exportId}/archive`, {
      cookie: s.owner.cookie,
    });
    expect(response.status).toBe(200);
    const archive = await openArchive(Buffer.from(await response.arrayBuffer()));
    return {
      member: archive
        .rows<{ id: string; display_name: string; email: string | null }>('members')
        .find((row) => row.id === memberId),
      entries: archive
        .rows<{ author_member_id: string | null; removal: string | null }>('entries')
        .filter((row) => row.author_member_id === memberId),
    };
  }

  // Purpose (AC-4, on the job model): an export whose segments were written before an erasure
  // never commits them unchanged: the erasure's redaction rows and version bumps make it
  // rebuild, so the archive holds the husk and tombstones only. Fails if a pre-erasure segment
  // or member row reaches the finished archive.
  it('never commits content an erasure changed after the export read it', async () => {
    const s = await scene('exportrace');
    await requestErasure(s.p.cookie, s.communityId);
    const exportId = await ownerExport(s);
    let erased = false;
    await drainExports(h.pool, h.blobStore, {
      hooks: {
        afterSegment: async ({ kind }) => {
          if (kind !== 'data' || erased) return;
          erased = true;
          await runErasures(h.pool, hoursFromNow(73));
        },
      },
    });
    expect(erased).toBe(true);
    const exported = await exportedPerson(s, exportId, s.p.memberId);
    expect(exported.member).toMatchObject({ display_name: 'Erased member', email: null });
    expect(exported.entries.length).toBeGreaterThan(0);
    expect(exported.entries.every((row) => row.removal === 'erased')).toBe(true);
  });

  // Purpose (AC-4): the seal bumps the content version in its own transaction, so an export
  // whose final commit waits on it goes round again and holds the husk. Fails if the tail
  // commits the member as they were before the seal.
  it('rebuilds an export whose commit waits on the seal, because the seal bumps in its own transaction', async () => {
    const s = await scene('sealrace');
    await requestErasure(s.p.cookie, s.communityId);
    const exportId = await ownerExport(s);
    let job: Promise<string[]> | undefined;
    await runErasures(h.pool, hoursFromNow(73), {
      hooks: {
        inBatch: async (step) => {
          if (step !== 'seal' || job) return;
          job = drainExports(h.pool, h.blobStore);
          await waitForLockWaiters(h, 1, 'community_content_versions');
        },
      },
    });
    expect(await job!).toEqual([exportId]);
    const exported = await exportedPerson(s, exportId, s.p.memberId);
    expect(exported.member).toMatchObject({ display_name: 'Erased member' });
  });

  it('refuses an upload that started before the erasure and committed after it', async () => {
    const s = await scene('uploadrace');
    await requestErasure(s.p.cookie, s.communityId);
    let push!: (chunk: Uint8Array | null) => void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => (chunk ? controller.enqueue(chunk) : controller.close());
      },
    });
    const text = 'late bytes';
    const uploadResponse = fetch(`${h.baseUrl}${s.base}/channels/${s.channelId}/attachments`, {
      method: 'POST',
      headers: {
        cookie: s.p.cookie,
        origin: h.config.publicUrl,
        'content-type': 'text/plain',
        'idempotency-key': 'late',
        'x-file-name': 'late.txt',
        'x-file-size': String(text.length),
      },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    // The client sends the request once it has a first chunk; the rest arrives after erasure.
    const bytes = new TextEncoder().encode(text);
    push(bytes.slice(0, 4));
    let reserved = false;
    for (let attempt = 0; attempt < 250 && !reserved; attempt++) {
      reserved = Boolean(
        (
          await h.pool.query(
            "SELECT 1 FROM managed_blobs WHERE community_id=$1 AND state='reserved'",
            [s.communityId]
          )
        ).rowCount
      );
      if (!reserved) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(reserved).toBe(true);
    await runErasures(h.pool, hoursFromNow(73));
    push(bytes.slice(4));
    push(null);
    expect([401, 403]).toContain((await uploadResponse).status);
    await drainCleanup(h);
    expect(await scanBlobs(storageDirectory(h), [text])).toEqual([]);
    expect(
      (await h.pool.query('SELECT 1 FROM attachments WHERE uploader_member_id=$1', [s.p.memberId]))
        .rowCount
    ).toBe(0);
  });
});

describe('locks (AC-11)', () => {
  it('lets others post, reply, and read while an erasure batch is open', async () => {
    for (const step of ['tombstones', 'mentions'] as const) {
      const s = await scene(`locks${step}`);
      await requestErasure(s.p.cookie, s.communityId);
      let opened!: () => void;
      const inside = new Promise<void>((resolve) => (opened = resolve));
      let close!: () => void;
      const closed = new Promise<void>((resolve) => (close = resolve));
      const run = runErasures(h.pool, hoursFromNow(73), {
        hooks: {
          inBatch: async (at) => {
            if (at !== step) return;
            opened();
            await closed;
          },
        },
      });
      await inside;
      const timed = async (response: Promise<Response>, label: string) => {
        const outcome = await Promise.race([
          response,
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5_000)),
        ]);
        expect(outcome, `${label} during ${step}`).not.toBe('timeout');
        return outcome as Response;
      };
      const entries = `${s.base}/channels/${s.channelId}/entries`;
      expect(
        (
          await timed(
            h.call(entries, {
              cookie: s.q.cookie,
              body: { text: 'new', idempotencyKey: `new-${step}` },
            }),
            'post'
          )
        ).status
      ).toBe(201);
      const parent = step === 'tombstones' ? s.pEntryId : s.qMentionId;
      expect(
        (
          await timed(
            h.call(entries, {
              cookie: s.q.cookie,
              body: { text: 'reply', idempotencyKey: `reply-${step}`, parentEntryId: parent },
            }),
            'reply'
          )
        ).status
      ).toBe(201);
      expect(
        (await timed(h.call(`${entries}?limit=100`, { cookie: s.q.cookie }), 'read')).status
      ).toBe(200);
      close();
      await run;
      expect(
        (await h.pool.query('SELECT erased_at FROM members WHERE id=$1', [s.p.memberId])).rows[0]
          .erased_at
      ).not.toBeNull();
    }
  });
});

describe('pairings', () => {
  it('records who declined, so erasure removes it without waiting for the sweep', async () => {
    const s = await scene('decline');
    const pairingId = await startPairing(h, s.communityId, 'declined install');
    await body(
      await h.call(`${s.base}/pairings/decline`, { cookie: s.p.cookie, body: { pairingId } }),
      200,
      'decline'
    );
    expect(
      (await h.pool.query('SELECT member_id FROM connection_pairings WHERE id=$1', [pairingId]))
        .rows[0].member_id
    ).toBe(s.p.memberId);
    await requestErasure(s.p.cookie, s.communityId);
    await runErasures(h.pool, hoursFromNow(73));
    expect(
      (await h.pool.query('SELECT 1 FROM connection_pairings WHERE id=$1', [pairingId])).rowCount
    ).toBe(0);
  });

  it('sweeps pairings that expired over an hour ago unused, and keeps the rest', async () => {
    const s = await scene('sweep');
    const stale = await startPairing(h, s.communityId, 'stale install');
    const recent = await startPairing(h, s.communityId, 'recent install');
    await h.pool.query(
      `UPDATE connection_pairings SET expires_at=now()-interval '61 minutes' WHERE id=$1`,
      [stale]
    );
    await h.pool.query(
      `UPDATE connection_pairings SET expires_at=now()-interval '59 minutes' WHERE id=$1`,
      [recent]
    );
    await sweepExpiredPairings(h.pool);
    const left = await h.pool.query<{ id: string }>(
      'SELECT id FROM connection_pairings WHERE id=ANY($1::uuid[])',
      [[stale, recent]]
    );
    expect(left.rows.map((row) => row.id)).toEqual([recent]);
    // The consumed pairing behind the grant stays however old it is.
    await h.pool.query(
      `UPDATE connection_pairings SET expires_at=now()-interval '2 days' WHERE community_id=$1 AND consumed_at IS NOT NULL`,
      [s.communityId]
    );
    await sweepExpiredPairings(h.pool);
    expect(
      (
        await h.pool.query(
          'SELECT 1 FROM connection_pairings WHERE community_id=$1 AND consumed_at IS NOT NULL',
          [s.communityId]
        )
      ).rowCount
    ).toBe(1);
  });
});

describe('backup re-application (AC-12)', () => {
  const tables = async () =>
    (
      await h.pool.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'community_migrations' ORDER BY tablename"
      )
    ).rows.map((row) => `"${row.tablename}"`);

  /** Copy every table, sequence, and blob, as a host's backup would. */
  async function snapshot(): Promise<{
    sequences: { name: string; value: string | null }[];
    blobs: string;
  }> {
    await h.pool.query('DROP SCHEMA IF EXISTS erasure_backup CASCADE');
    await h.pool.query('CREATE SCHEMA erasure_backup');
    for (const table of await tables())
      await h.pool.query(`CREATE TABLE erasure_backup.${table} AS TABLE public.${table}`);
    const sequences = await h.pool.query<{ name: string; value: string | null }>(
      "SELECT sequencename AS name,last_value::text AS value FROM pg_sequences WHERE schemaname='public'"
    );
    const blobs = await mkdtemp(join(tmpdir(), 'erasure-backup-'));
    await cp(storageDirectory(h), blobs, { recursive: true });
    return { sequences: sequences.rows, blobs };
  }

  /** Put the backup back, rewinding every sequence, as a restore would. */
  async function restore(backup: Awaited<ReturnType<typeof snapshot>>): Promise<void> {
    const client = await h.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      const all = await tables();
      await client.query(`TRUNCATE ${all.map((table) => `public.${table}`).join(',')}`);
      for (const table of all)
        await client.query(
          `INSERT INTO public.${table} OVERRIDING SYSTEM VALUE SELECT * FROM erasure_backup.${table}`
        );
      for (const sequence of backup.sequences)
        await client.query(
          sequence.value === null ? 'SELECT setval($1, 1, false)' : 'SELECT setval($1, $2::bigint)',
          sequence.value === null
            ? [`public.${sequence.name}`]
            : [`public.${sequence.name}`, sequence.value]
        );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const directory = storageDirectory(h);
    for (const name of await readdir(directory)) await rm(join(directory, name), { force: true });
    await cp(backup.blobs, directory, { recursive: true });
  }

  it('erases again after a restore, and gives each touched community a new epoch', async () => {
    const s = await scene('restore');
    const journal = join(await mkdtemp(join(tmpdir(), 'erasure-journal-')), 'journal.log');
    await writeFile(journal, '');
    const email = (await h.pool.query('SELECT email FROM "user" WHERE id=$1', [s.p.userId])).rows[0]
      .email as string;
    const needles = [
      s.p.handle,
      s.agent.handle,
      email,
      `hello from ${s.p.handle}`,
      'laptop restore',
    ];
    const fileText = `notes of ${s.slug}`;
    const epoch = async () =>
      (
        await h.pool.query('SELECT redaction_epoch::text AS epoch FROM communities WHERE id=$1', [
          s.communityId,
        ])
      ).rows[0].epoch as string;
    const original = await epoch();
    const backup = await snapshot();

    await body(
      await h.call('/api/v1/account/erasures', {
        cookie: s.p.cookie,
        body: { kind: 'account', confirmEmail: email, password: PASSWORD },
      }),
      201,
      'account erasure'
    );
    await runErasures(h.pool, hoursFromNow(73), { journalPath: journal });
    const journalText = await readFile(journal, 'utf8');
    expect(
      journalText
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).event)
    ).toEqual(['community.member_erased', 'community.account_erased']);
    expect(needles.some((needle) => journalText.includes(needle))).toBe(false);

    const epochs = new Set<string>([original]);
    for (let round = 0; round < 2; round++) {
      await restore(backup);
      expect(await epoch()).toBe(original);
      expect((await h.pool.query('SELECT 1 FROM "user" WHERE id=$1', [s.p.userId])).rowCount).toBe(
        1
      );
      const result = await reapplyErasures(h.pool, parseErasureJournal(journalText));
      expect(result).toMatchObject({ members: 1, accounts: 1 });
      await drainCleanup(h);
      const hits = (await scanDatabase(h.pool, needles)).filter(
        (hit) => hit.communityId === s.communityId || hit.communityId === null
      );
      expect(hits).toEqual([]);
      expect(await scanBlobs(storageDirectory(h), [fileText])).toEqual([]);
      expect((await h.pool.query('SELECT 1 FROM "user" WHERE id=$1', [s.p.userId])).rowCount).toBe(
        0
      );
      const next = await epoch();
      expect(epochs.has(next)).toBe(false);
      epochs.add(next);
    }
    await h.pool.query('DROP SCHEMA IF EXISTS erasure_backup CASCADE');
    await rm(backup.blobs, { recursive: true, force: true });
  });
});
