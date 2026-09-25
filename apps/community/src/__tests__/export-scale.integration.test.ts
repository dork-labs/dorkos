import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readWithYauzl } from '../archive/__tests__/archive-test-helpers.js';
import { SegmentedBlobSource } from '../archive/segmented-source.js';
import { openZipArchive } from '../archive/zip-reader.js';
import {
  exportCommunity,
  requestOwnerExport,
  runExport,
  seedEntries,
  seedFile,
  segmentsOf,
  expectUnique,
} from './export-jobs-fixture.js';
import { bootstrapHost, startTenancyHarness, type TenancyHarness } from './tenancy-test-harness.js';

const MIB = 1024 * 1024;
let h: TenancyHarness;
let operatorCookie: string;

beforeAll(async () => {
  h = await startTenancyHarness('exportscale');
  operatorCookie = (await bootstrapHost(h, 'Sol Host', 'sol@export-host.test')).cookie;
});

afterAll(async () => {
  await h?.close();
});

describe('any size', () => {
  // Purpose (AC-1, AC-3): a community past every version 1 limit (more than 10,000 messages and
  // members, more than 1 GiB of files) exports into one archive of several segments that yauzl
  // and our reader both open, with every message, member and file once and every file intact,
  // while local staging never holds more than one segment and the heap stays small. Fails at any
  // old cap, or if the whole archive is staged or buffered.
  it('exports 12,000 messages, 11,000 members and 1.2 GiB of files in bounded pieces', async () => {
    const community = await exportCommunity(h, operatorCookie, 'Scale Place');
    await h.pool.query(
      `INSERT INTO "user"(id,name,email,"emailVerified")
         SELECT 'scale-user-'||n,'Scale '||n,'scale-'||n||'@scale.test',true
         FROM generate_series(1,11000) n`
    );
    await h.pool.query(
      `INSERT INTO members(community_id,user_id,display_name,handle,role)
         SELECT $1,'scale-user-'||n,'Scale '||n,'scale-'||n,'member' FROM generate_series(1,11000) n`,
      [community.communityId]
    );
    const entries = await seedEntries(h, community, {
      authorMemberId: community.owner.memberId,
      count: 12_000,
    });
    const files: { id: string; checksum: string }[] = [];
    // 49 files of 25 MiB: 1.2 GiB.
    for (let index = 0; index < 49; index++)
      files.push(
        await seedFile(h, community, {
          entryId: entries[index * 240].id,
          uploaderMemberId: community.owner.memberId,
          name: `part-${index}.txt`,
          bytes: 25 * MIB,
        })
      );
    const requested = await requestOwnerExport(h, community);
    let maxStaged = 0;
    let maxHeap = 0;
    if (h.config.storage.kind !== 'filesystem') throw new Error('The scale test stages on disk');
    const directory = h.config.storage.directory;
    // Uploads being written are `.<key>.upload` files in the storage folder.
    const staged = async () =>
      (await readdir(directory)).filter((name) => name.endsWith('.upload')).length;
    await runExport(h, {
      segmentBytes: 64 * MIB,
      hooks: {
        afterSegment: async () => {
          maxStaged = Math.max(maxStaged, await staged());
          maxHeap = Math.max(maxHeap, process.memoryUsage().heapUsed);
        },
        beforeFile: async () => {
          maxStaged = Math.max(maxStaged, await staged());
          maxHeap = Math.max(maxHeap, process.memoryUsage().heapUsed);
        },
      },
    });
    expect(maxStaged).toBeLessThanOrEqual(1);
    expect(maxHeap).toBeLessThan(256 * MIB);
    const segments = await segmentsOf(h, requested.export.id);
    expect(segments.filter((segment) => segment.kind === 'data').length).toBeGreaterThan(1);
    const source = new SegmentedBlobSource(
      h.blobStore,
      segments.map((segment) => ({ key: segment.blob_key, byteSize: segment.byte_size }))
    );
    expect(source.size).toBeGreaterThan(1024 * MIB);

    const archive = await openZipArchive(source, { allowName: () => true });
    const names: string[] = [];
    const listed = [];
    for await (const entry of archive.entries()) listed.push(entry);
    const text = new Map<string, string>();
    const hashes = new Map<string, string>();
    for (const entry of listed) {
      names.push(entry.name);
      const hash = createHash('sha256');
      const chunks: Buffer[] = [];
      for await (const chunk of archive.openEntry(entry)) {
        if (entry.name.startsWith('files/')) hash.update(chunk);
        else chunks.push(Buffer.from(chunk));
      }
      if (entry.name.startsWith('files/')) hashes.set(entry.name, hash.digest('hex'));
      else text.set(entry.name, Buffer.concat(chunks).toString('utf8'));
    }
    expectUnique(names, 'entry names');
    const manifest = JSON.parse(text.get('manifest.json')!);
    const rows = (key: string) =>
      (manifest.files[key] as string[]).flatMap((name) =>
        text
          .get(name)!
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      );
    const entryIds = rows('entries').map((row) => row.id as string);
    expect(entryIds).toHaveLength(12_000);
    expectUnique(entryIds, 'messages');
    const memberIds = rows('members').map((row) => row.id as string);
    expect(memberIds).toHaveLength(11_001);
    expectUnique(memberIds, 'members');
    const attachments = rows('attachments') as { id: string; archivePath: string }[];
    expect(attachments.map((row) => row.id).sort()).toEqual(files.map((file) => file.id).sort());
    for (const file of files) {
      const path = attachments.find((row) => row.id === file.id)!.archivePath;
      expect(hashes.get(path), path).toBe(file.checksum);
    }

    // An independent ZIP64 reader lists the same entries at the same offsets.
    const yauzl = await readWithYauzl(source, () => false);
    expect(yauzl.entries.map((entry) => entry.name)).toEqual(names);
  }, 600_000);
});
