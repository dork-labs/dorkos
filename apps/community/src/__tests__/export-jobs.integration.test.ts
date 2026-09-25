import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommunityExportAgentChannelMemberRowSchema,
  CommunityExportAgentRowSchema,
  CommunityExportAttachmentRowSchema,
  CommunityExportAuditEventRowSchema,
  CommunityExportChannelMemberRowSchema,
  CommunityExportChannelRowSchema,
  CommunityExportEntryRowSchema,
  CommunityExportMemberRowSchema,
  CommunityWireExportListSchema,
} from '@dorkos/shared/community-wire';
import { bufferReader, readWithYauzl } from '../archive/__tests__/archive-test-helpers.js';
import { purgeVersionTwoExports } from '../exports/purge-v2.js';
import { sweepExpiredExports } from '../exports/sweep.js';
import { sweepPendingBlobDeletions } from '../storage/pending-deletions.js';
import { openArchive } from './export-test-helpers.js';
import {
  downloadArchive,
  exportCommunity,
  exportMember,
  exportStatus,
  jobRow,
  orphanExportBlobs,
  requestOwnerExport,
  requestPersonalExport,
  runExport,
  seedEntries,
  seedFile,
  segmentsOf,
} from './export-jobs-fixture.js';
import {
  bootstrapHost,
  expectStatus,
  startTenancyHarness,
  type TenancyHarness,
} from './tenancy-test-harness.js';

let h: TenancyHarness;
let operatorCookie: string;

beforeAll(async () => {
  h = await startTenancyHarness('exportjobs');
  operatorCookie = (await bootstrapHost(h, 'Hana Host', 'hana@export-host.test')).cookie;
});

afterAll(async () => {
  await h?.close();
});

const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('0000000d49484452000000010000000108060000001f15c489', 'hex'),
]);

describe('version 2 archive', () => {
  // Purpose (AC-9): the archive a job writes is version 2 end to end. Fails if manifest.json is
  // not the last entry, if any row does not parse with its strict schema, if counts disagree
  // with the rows, if the community's settings or icon are missing, if memberships differ from
  // the tables, if removal markers are lost, or if a file's name can escape its folder.
  it('writes the community, its rows, removal markers and files, with manifest.json last', async () => {
    const community = await exportCommunity(h, operatorCookie, 'Manifest Place');
    const bob = await exportMember(h, community, 'Bob Manifest');
    // Settings and icon, as the owner set them.
    const icon = await h.blobStore.put({
      source: (async function* () {
        yield PNG;
      })(),
      displayName: 'community-icon',
      maxBytes: 2 * 1024 * 1024,
      kind: 'icon',
    });
    await h.pool.query(
      `INSERT INTO managed_blobs(blob_key,community_id,purpose,community_lifecycle_version,state,
         byte_size,checksum,stored_at,committed_at)
       SELECT $1,$2,'icon',lifecycle_version,'committed',$3,$4,now(),now() FROM communities WHERE id=$2`,
      [icon.key, community.communityId, icon.byteSize, icon.sha256]
    );
    await h.pool.query(
      `UPDATE communities SET description='Where manifests live',admission_policy='closed',
         icon_blob_key=$2,icon_content_type='image/png',settings_version=settings_version+1
       WHERE id=$1`,
      [community.communityId, icon.key]
    );
    const agent = await h.pool.query<{ id: string }>(
      `INSERT INTO agents(community_id,owner_member_id,display_name,handle)
       VALUES($1,$2,'Manifest Bot','manifest-bot') RETURNING id`,
      [community.communityId, bob.memberId]
    );
    await h.pool.query(
      'INSERT INTO agent_channel_members(community_id,channel_id,agent_id) VALUES($1,$2,$3)',
      [community.communityId, community.channelId, agent.rows[0].id]
    );
    const [kept, removed, erased] = await seedEntries(h, community, {
      authorMemberId: community.owner.memberId,
      count: 3,
      textOf: (n) => `manifest text ${n}`,
    });
    const bobEntries = await seedEntries(h, community, {
      authorMemberId: bob.memberId,
      count: 2,
      textOf: (n) => `bob text ${n}`,
    });
    const file = await seedFile(h, community, {
      entryId: kept.id,
      uploaderMemberId: community.owner.memberId,
      name: 'notes.txt',
      bytes: Buffer.from('file bytes'),
    });
    const evil = await seedFile(h, community, {
      entryId: bobEntries[0].id,
      uploaderMemberId: bob.memberId,
      name: '../../evil',
      bytes: Buffer.from('evil bytes'),
    });
    await expectStatus(
      await h.call(`${community.base}/entries/${removed.id}`, {
        method: 'DELETE',
        cookie: community.owner.cookie,
      }),
      200,
      'remove own message'
    );
    await h.pool.query(
      "UPDATE entries SET erased_at=now(),text='This message was erased.' WHERE id=$1",
      [erased.id]
    );

    const requested = await requestOwnerExport(h, community);
    expect(requested.status).toBe(202);
    expect(requested.export).toMatchObject({ scope: 'owner', state: 'queued', byteSize: null });
    expect(await runExport(h)).toBe(requested.export.id);
    const status = await exportStatus(h, community, requested.export.id);
    expect(status.state).toBe('ready');
    expect(status.progress).toEqual({ done: 7, total: 7 });

    const bytes = await downloadArchive(h, community, requested.export.id);
    expect(bytes.length).toBe(status.byteSize);
    const archive = await openArchive(bytes);
    expect(archive.names.at(-1)).toBe('manifest.json');
    expect(archive.manifest).toMatchObject({
      version: 2,
      scope: 'owner',
      exportId: requested.export.id,
      requesterMemberId: community.owner.memberId,
      community: {
        id: community.communityId,
        name: 'Manifest Place',
        description: 'Where manifests live',
        admissionPolicy: 'closed',
        lifecycle: 'active',
        icon: { path: 'community/icon', contentType: 'image/png', byteSize: PNG.length },
      },
    });
    expect(archive.files.get('community/icon')).toEqual(PNG);
    expect(archive.manifest.community.icon?.checksum).toBe(icon.sha256);

    const schemas = {
      channels: CommunityExportChannelRowSchema,
      members: CommunityExportMemberRowSchema,
      agents: CommunityExportAgentRowSchema,
      channelMembers: CommunityExportChannelMemberRowSchema,
      agentChannelMembers: CommunityExportAgentChannelMemberRowSchema,
      auditEvents: CommunityExportAuditEventRowSchema,
      entries: CommunityExportEntryRowSchema,
      attachments: CommunityExportAttachmentRowSchema,
    } as const;
    for (const [key, schema] of Object.entries(schemas) as [
      keyof typeof schemas,
      (typeof schemas)[keyof typeof schemas],
    ][]) {
      const rows = archive.rows(key);
      for (const row of rows) schema.parse(row);
      expect(rows.length, `${key} count`).toBe(archive.manifest.counts[key]);
    }
    expect(archive.manifest.counts).toMatchObject({ entries: 5, attachments: 2, agents: 1 });

    const memberships = await h.pool.query(
      `SELECT channel_id,member_id FROM channel_members WHERE community_id=$1
       ORDER BY channel_id,member_id`,
      [community.communityId]
    );
    expect(
      archive
        .rows<{ channel_id: string; member_id: string }>('channelMembers')
        .map(({ channel_id, member_id }) => ({ channel_id, member_id }))
    ).toEqual(memberships.rows);
    expect(archive.rows<{ agent_id: string }>('agentChannelMembers')).toEqual([
      expect.objectContaining({ agent_id: agent.rows[0].id, channel_id: community.channelId }),
    ]);

    const entries = new Map(
      archive
        .rows<{ id: string; removal: string | null; text: string }>('entries')
        .map((row) => [row.id, row])
    );
    expect(entries.get(kept.id)).toMatchObject({
      removal: null,
      text: expect.stringContaining('manifest text'),
    });
    expect(entries.get(removed.id)).toMatchObject({
      removal: 'author',
      text: 'This message was deleted.',
    });
    expect(entries.get(erased.id)?.removal).toBe('erased');

    const attachments = archive.rows<{ id: string; archivePath: string }>('attachments');
    const note = attachments.find((row) => row.id === file.id)!;
    expect(note.archivePath).toBe(`files/${file.id}/notes.txt`);
    expect(archive.files.get(note.archivePath)?.toString()).toBe('file bytes');
    const evilPath = attachments.find((row) => row.id === evil.id)!.archivePath;
    expect(evilPath.startsWith(`files/${evil.id}/`)).toBe(true);
    expect(evilPath.slice(`files/${evil.id}/`.length)).not.toContain('/');
    expect(evilPath).toBe(`files/${evil.id}/_.._evil`);
    expect(archive.files.get(evilPath)?.toString()).toBe('evil bytes');
    // Members keep their email in an owner export; no credential or storage key leaks.
    expect(archive.rows<{ email: string | null }>('members').every((row) => row.email)).toBe(true);
    const everything = [...archive.files.values()]
      .map((value) => value.toString('latin1'))
      .join('');
    expect(everything).not.toContain(file.blobKey);
    expect(everything).not.toContain('token_hash');

    // An independent reader opens it too.
    const yauzl = await readWithYauzl(bufferReader(bytes), () => false);
    expect(yauzl.entries.map((entry) => entry.name)).toEqual(archive.names);
  });

  // Purpose: a personal export holds the requester's own messages and files and only their own
  // member row, as version 1 did. Fails if another member's text, file or email leaks into it.
  it('keeps a personal export to the requester’s own rows', async () => {
    const community = await exportCommunity(h, operatorCookie, 'Personal Place');
    const bob = await exportMember(h, community, 'Bob Personal');
    const [own] = await seedEntries(h, community, {
      authorMemberId: bob.memberId,
      count: 1,
      textOf: () => 'bob own words',
    });
    const [other] = await seedEntries(h, community, {
      authorMemberId: community.owner.memberId,
      count: 1,
      textOf: () => 'owner private words',
    });
    await seedFile(h, community, {
      entryId: own.id,
      uploaderMemberId: bob.memberId,
      name: 'bob.txt',
      bytes: Buffer.from('bob file'),
    });
    await seedFile(h, community, {
      entryId: other.id,
      uploaderMemberId: community.owner.memberId,
      name: 'owner.txt',
      bytes: Buffer.from('owner file'),
    });
    const requested = await requestPersonalExport(h, community, bob.cookie);
    expect(requested.status).toBe(202);
    await runExport(h);
    const archive = await openArchive(
      await downloadArchive(h, community, requested.export.id, bob.cookie)
    );
    expect(archive.manifest.scope).toBe('personal');
    expect(archive.rows<{ text: string }>('entries').map((row) => row.text)).toEqual([
      'bob own words',
    ]);
    expect(archive.rows<{ name: string }>('attachments').map((row) => row.name)).toEqual([
      'bob.txt',
    ]);
    expect(archive.rows<{ id: string }>('members').map((row) => row.id)).toEqual([bob.memberId]);
    expect(archive.manifest.files.auditEvents).toEqual([]);
    const everything = [...archive.files.values()].map((value) => value.toString()).join('');
    expect(everything).not.toContain('owner private words');
    expect(everything).not.toContain('owner file');
    expect(everything).not.toContain('personal-place-owner@export.test');
  });
});

describe('export routes', () => {
  // Purpose (AC-10): one export at a time and a lifetime. Fails if a second request while one is
  // building starts another, if a ready export outlives its TTL, or if the sweep leaves an
  // expired archive's segments stored.
  it('answers a second request with the open export, and expires a ready one after its TTL', async () => {
    const community = await exportCommunity(h, operatorCookie, 'Once Place');
    await seedEntries(h, community, { authorMemberId: community.owner.memberId, count: 3 });
    const first = await requestOwnerExport(h, community);
    expect(first.status).toBe(202);
    const again = await requestOwnerExport(h, community);
    expect(again.status).toBe(200);
    expect(again.export.id).toBe(first.export.id);
    await runExport(h);
    const ready = await requestOwnerExport(h, community);
    expect(ready).toMatchObject({ status: 200, export: { id: first.export.id, state: 'ready' } });

    const segments = await segmentsOf(h, first.export.id);
    expect(segments.length).toBeGreaterThan(0);
    const expiresAt = new Date((await exportStatus(h, community, first.export.id)).expiresAt!);
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(23 * 3600_000);
    // The sweep is host-wide; this archive's own row says what it did.
    const deletedAt = async () =>
      (await h.pool.query('SELECT deleted_at FROM export_archives WHERE id=$1', [first.export.id]))
        .rows[0].deleted_at;
    await sweepExpiredExports(h.pool, h.blobStore, { now: new Date(expiresAt.getTime() - 1) });
    expect(await deletedAt()).toBeNull();
    expect(await segmentsOf(h, first.export.id)).toHaveLength(segments.length);
    await sweepExpiredExports(h.pool, h.blobStore, { now: new Date(expiresAt.getTime() + 1000) });
    expect(await deletedAt()).not.toBeNull();
    expect(await segmentsOf(h, first.export.id)).toEqual([]);
    const queued = await h.pool.query(
      `SELECT count(*)::int AS count FROM managed_blobs
       WHERE blob_key=ANY($1::text[]) AND state='pending_delete'`,
      [segments.map((segment) => segment.blob_key)]
    );
    expect(queued.rows[0].count).toBe(segments.length);
    // The expired archive is still listed, as expired, and can no longer be downloaded.
    await h.pool.query(
      "UPDATE export_archives SET expires_at=now()-interval '1 second' WHERE id=$1",
      [first.export.id]
    );
    expect((await exportStatus(h, community, first.export.id)).state).toBe('expired');
    expect(
      (
        await h.call(`${community.base}/exports/${first.export.id}/archive`, {
          cookie: community.owner.cookie,
        })
      ).status
    ).toBe(404);
    const listed = CommunityWireExportListSchema.parse(
      await (await h.call(`${community.base}/exports`, { cookie: community.owner.cookie })).json()
    );
    expect(listed.exports.map((item) => [item.id, item.state])).toEqual([
      [first.export.id, 'expired'],
    ]);
    // With it gone, the next request starts a new export.
    const next = await requestOwnerExport(h, community);
    expect(next.status).toBe(202);
    expect(next.export.id).not.toBe(first.export.id);
    // Leave no job queued for the next test's worker.
    await expectStatus(
      await h.call(`${community.base}/exports/${next.export.id}/cancel`, {
        cookie: community.owner.cookie,
        body: {},
      }),
      200,
      'cancel the new export'
    );
  });

  // Purpose (AC-10): cancelling while building leaves nothing stored. Fails if cancel does not
  // stop the worker, or if the segments it wrote (or the one it was writing) survive cleanup.
  it('cancels a building export and leaves no segment after cleanup', async () => {
    const community = await exportCommunity(h, operatorCookie, 'Cancel Place');
    const entries = await seedEntries(h, community, {
      authorMemberId: community.owner.memberId,
      count: 6,
      textOf: (n) => `cancel ${n} ${'x'.repeat(3000)}`,
    });
    const requested = await requestOwnerExport(h, community);
    let segments = 0;
    await runExport(h, {
      segmentBytes: 4096,
      hooks: {
        afterSegment: async ({ kind }) => {
          if (kind !== 'data' || ++segments !== 2) return;
          const cancelled = await h.call(
            `${community.base}/exports/${requested.export.id}/cancel`,
            {
              cookie: community.owner.cookie,
              body: {},
            }
          );
          expect(cancelled.status).toBe(200);
          expect((await cancelled.json()).export.state).toBe('cancelled');
        },
      },
    });
    expect(segments).toBe(2);
    expect(entries).toHaveLength(6);
    expect(await jobRow(h, requested.export.id)).toMatchObject({ state: 'cancelled' });
    expect(await segmentsOf(h, requested.export.id)).toEqual([]);
    await h.pool.query(
      "UPDATE managed_blobs SET created_at=now()-interval '2 hours' WHERE community_id=$1 AND purpose='export'",
      [community.communityId]
    );
    await sweepPendingBlobDeletions(h.pool, h.blobStore);
    expect(
      (
        await h.pool.query(
          "SELECT count(*)::int AS count FROM managed_blobs WHERE community_id=$1 AND purpose='export'",
          [community.communityId]
        )
      ).rows[0].count
    ).toBe(0);
    expect(await orphanExportBlobs(h, community.communityId)).toEqual([]);
    // A cancelled export answers 409 to nothing; a ready one refuses to be cancelled.
    const second = await requestOwnerExport(h, community);
    await runExport(h);
    const refused = await h.call(`${community.base}/exports/${second.export.id}/cancel`, {
      cookie: community.owner.cookie,
      body: {},
    });
    expect(refused.status).toBe(409);
  });

  // Purpose: an export is its requester's alone. Fails if another member can read its status,
  // cancel it, or download it, even knowing its id.
  it('hides an export from everyone but its requester', async () => {
    const community = await exportCommunity(h, operatorCookie, 'Private Place');
    const bob = await exportMember(h, community, 'Bob Private');
    await seedEntries(h, community, { authorMemberId: community.owner.memberId, count: 1 });
    const requested = await requestOwnerExport(h, community);
    await runExport(h);
    for (const [method, path] of [
      ['GET', `/exports/${requested.export.id}`],
      ['GET', `/exports/${requested.export.id}/archive`],
      ['POST', `/exports/${requested.export.id}/cancel`],
    ] as const) {
      const response = await h.call(`${community.base}${path}`, {
        method,
        cookie: bob.cookie,
        ...(method === 'POST' ? { body: {} } : {}),
      });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    const listed = CommunityWireExportListSchema.parse(
      await (await h.call(`${community.base}/exports`, { cookie: bob.cookie })).json()
    );
    expect(listed.exports).toEqual([]);
  });
});

describe('backout', () => {
  // Purpose: the backout command leaves only version 1 archives, which the code from before
  // reads, with every version 2 segment queued for deletion. Fails if a version 2 row or a
  // committed segment blob survives, or if a version 1 archive is touched.
  it('removes every version 2 export and queues its segments, leaving version 1 archives', async () => {
    const community = await exportCommunity(h, operatorCookie, 'Backout Place');
    await seedEntries(h, community, { authorMemberId: community.owner.memberId, count: 2 });
    const ready = await requestOwnerExport(h, community);
    await runExport(h);
    const keys = (await segmentsOf(h, ready.export.id)).map((segment) => segment.blob_key);
    await expireAndQueue(community);
    const legacy = await h.pool.query<{ id: string }>(
      `INSERT INTO export_archives(community_id,requester_member_id,scope,blob_key,byte_size,expires_at)
       VALUES($1,$2,'owner',$3,1,now()+interval '1 hour') RETURNING id`,
      [community.communityId, community.owner.memberId, 'b'.repeat(64)]
    );
    expect(await purgeVersionTwoExports(h.pool)).toBeGreaterThanOrEqual(2);
    expect(
      (await h.pool.query('SELECT id FROM export_archives WHERE format_version=2')).rowCount
    ).toBe(0);
    expect(
      (await h.pool.query('SELECT 1 FROM export_archives WHERE id=$1', [legacy.rows[0].id]))
        .rowCount
    ).toBe(1);
    const states = await h.pool.query(
      'SELECT DISTINCT state FROM managed_blobs WHERE blob_key=ANY($1::text[])',
      [keys]
    );
    expect(states.rows).toEqual([{ state: 'pending_delete' }]);
  });

  /** Leave a queued job beside the ready archive, so both kinds are purged. */
  async function expireAndQueue(community: Awaited<ReturnType<typeof exportCommunity>>) {
    await h.pool.query(
      "UPDATE export_archives SET expires_at=now()-interval '1 second' WHERE community_id=$1",
      [community.communityId]
    );
    const queued = await requestOwnerExport(h, community);
    expect(queued.status).toBe(202);
  }
});
