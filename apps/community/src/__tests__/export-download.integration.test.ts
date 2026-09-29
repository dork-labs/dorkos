import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eraseMembership } from '../erasure/erasure.js';
import { DOWNLOAD_RECHECK_BYTES } from '../routes/exports.js';
import {
  exportCommunity,
  exportMember,
  requestOwnerExport,
  runExport,
  seedEntries,
  seedFile,
  segmentsOf,
  sha256,
  type ExportCommunity,
} from './export-jobs-fixture.js';
import {
  bootstrapHost,
  expectStatus,
  startTenancyHarness,
  TENANCY_PASSWORD,
  type TenancyHarness,
} from './tenancy-test-harness.js';

const MIB = 1024 * 1024;
let h: TenancyHarness;
let operatorCookie: string;

beforeAll(async () => {
  h = await startTenancyHarness('exportdownload');
  operatorCookie = (await bootstrapHost(h, 'Dee Host', 'dee@export-host.test')).cookie;
});

afterAll(async () => {
  await h?.close();
});

/**
 * A ready owner export of about 40 MiB in several segments (one 20 MiB file each), with a
 * member whose erasure deletes it.
 */
async function largeExport(label: string) {
  const community = await exportCommunity(h, operatorCookie, label);
  const xena = await exportMember(h, community, `Xena ${label}`);
  const entries = await seedEntries(h, community, {
    authorMemberId: community.owner.memberId,
    count: 2,
  });
  for (const [index, entry] of entries.entries())
    await seedFile(h, community, {
      entryId: entry.id,
      uploaderMemberId: community.owner.memberId,
      name: `big-${index}.bin`,
      bytes: 20 * MIB,
    });
  await seedEntries(h, community, { authorMemberId: xena.memberId, count: 1 });
  const requested = await requestOwnerExport(h, community);
  await runExport(h, { segmentBytes: 8 * MIB });
  return { community, xena, id: requested.export.id };
}

function archive(community: ExportCommunity, id: string, headers: Record<string, string> = {}) {
  return h.call(`${community.base}/exports/${id}/archive`, {
    cookie: community.owner.cookie,
    headers,
  });
}

/**
 * Hold the download after its first byte: the archive's first segment answers one byte, then
 * waits for `release`. Returns the spy and the release.
 */
function holdAfterFirstByte(firstKey: string) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = h.blobStore.get.bind(h.blobStore);
  const spy = vi.spyOn(h.blobStore, 'get').mockImplementation(async (key, options) => {
    const read = await original(key, options);
    if (key !== firstKey || options?.range?.start !== 0) return read;
    return {
      byteSize: read.byteSize,
      body: Readable.from(
        (async function* () {
          let first = true;
          for await (const chunk of read.body as AsyncIterable<Buffer>) {
            if (first) {
              first = false;
              yield chunk.subarray(0, 1);
              await held;
              yield chunk.subarray(1);
            } else yield chunk;
          }
        })()
      ),
    };
  });
  return { spy, release };
}

/** Read a body until it ends or fails; how many bytes arrived, and whether it failed. */
async function drain(response: Response, afterFirst?: () => Promise<void>) {
  const reader = response.body!.getReader();
  const first = await reader.read();
  let received = first.value?.byteLength ?? 0;
  await afterFirst?.();
  let afterward = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return { received, afterward, failed: false };
      received += next.value.byteLength;
      afterward += next.value.byteLength;
    }
  } catch {
    return { received, afterward, failed: true };
  }
}

describe('resumable download', () => {
  // Purpose (AC-8): an archive downloads in ranges that concatenate to the whole file, across a
  // segment boundary, with the headers a browser needs to resume. Fails without range mapping
  // onto segments, or if If-Range, a range past the end, or several ranges are mishandled.
  it('serves ranges across segments that add up to the full download', async () => {
    const { community, id } = await largeExport('Range Place');
    const segments = await segmentsOf(h, id);
    expect(segments.filter((segment) => segment.kind === 'data').length).toBeGreaterThan(1);

    const full = await archive(community, id);
    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('cache-control')).toBe('private, no-store');
    expect(full.headers.get('content-disposition')).toContain('community-export.zip');
    const etag = full.headers.get('etag')!;
    expect(etag).toMatch(new RegExp(`^"${id}\\.\\d+"$`));
    const whole = Buffer.from(await full.arrayBuffer());
    const size = whole.length;
    expect(Number(full.headers.get('content-length'))).toBe(size);

    // The middle range starts inside the first segment and ends inside a later one.
    const boundary = segments[0].byte_size;
    const cuts = [0, 999, boundary - 500, boundary + 500, size - 1];
    const ranges = [
      `bytes=${cuts[0]}-${cuts[1]}`,
      `bytes=${cuts[1] + 1}-${cuts[3]}`,
      `bytes=${cuts[3] + 1}-`,
    ];
    const parts: Buffer[] = [];
    for (const range of ranges) {
      const response = await archive(community, id, { range, 'if-range': etag });
      expect(response.status, range).toBe(206);
      parts.push(Buffer.from(await response.arrayBuffer()));
      expect(response.headers.get('content-range')).toMatch(new RegExp(`/${size}$`));
    }
    expect(sha256(Buffer.concat(parts))).toBe(sha256(whole));
    const suffix = await archive(community, id, { range: 'bytes=-100' });
    expect(suffix.status).toBe(206);
    expect(Buffer.from(await suffix.arrayBuffer())).toEqual(whole.subarray(size - 100));

    const stale = await archive(community, id, { range: 'bytes=0-9', 'if-range': '"other.1"' });
    expect(stale.status).toBe(200);
    expect(Buffer.from(await stale.arrayBuffer()).length).toBe(size);
    const past = await archive(community, id, { range: `bytes=${size}-` });
    expect(past.status).toBe(416);
    expect(past.headers.get('content-range')).toBe(`bytes */${size}`);
    await past.body?.cancel();
    const multi = await archive(community, id, { range: 'bytes=0-1,5-6' });
    expect(multi.status).toBe(200);
    expect(Buffer.from(await multi.arrayBuffer()).length).toBe(size);
  });

  // Purpose (AC-8): a download re-checks the requester while it runs. Fails if a demoted
  // owner's download runs to the end instead of stopping within 16 MiB.
  it('stops a download within 16 MiB once the owner is demoted', async () => {
    const { community, xena, id } = await largeExport('Demote Download Place');
    const [first] = await segmentsOf(h, id);
    const { spy, release } = holdAfterFirstByte(first.blob_key);
    try {
      const response = await archive(community, id);
      expect(response.status).toBe(200);
      const size = Number(response.headers.get('content-length'));
      expect(size).toBeGreaterThan(2 * DOWNLOAD_RECHECK_BYTES);
      const outcome = await drain(response, async () => {
        const lifecycle = await h.pool.query<{ lifecycle_version: number }>(
          'SELECT lifecycle_version FROM communities WHERE id=$1',
          [community.communityId]
        );
        await expectStatus(
          await h.call(`${community.base}/owner/transfer`, {
            cookie: community.owner.cookie,
            body: {
              successorMemberId: xena.memberId,
              password: TENANCY_PASSWORD,
              lifecycleVersion: lifecycle.rows[0].lifecycle_version,
            },
          }),
          200,
          'transfer ownership'
        );
        release();
      });
      expect(outcome.failed).toBe(true);
      expect(outcome.received).toBeLessThan(size);
      expect(outcome.afterward).toBeLessThanOrEqual(DOWNLOAD_RECHECK_BYTES);
    } finally {
      release();
      spy.mockRestore();
    }
  });

  // Purpose (AC-8): an erasure that deletes the export stops a download already running, and
  // the next ranged request finds nothing. Fails if a download keeps streaming an erased
  // person's data after their erasure deleted the archive.
  it('stops a download within 16 MiB once an erasure deletes the export', async () => {
    const { community, xena, id } = await largeExport('Erase Download Place');
    const [first] = await segmentsOf(h, id);
    const { spy, release } = holdAfterFirstByte(first.blob_key);
    try {
      const response = await archive(community, id);
      const size = Number(response.headers.get('content-length'));
      const outcome = await drain(response, async () => {
        expect(
          await eraseMembership(h.pool, community.communityId, xena.memberId, {
            log: () => undefined,
          })
        ).toBe('erased');
        release();
      });
      expect(outcome.failed).toBe(true);
      expect(outcome.received).toBeLessThan(size);
      expect(outcome.afterward).toBeLessThanOrEqual(DOWNLOAD_RECHECK_BYTES);
    } finally {
      release();
      spy.mockRestore();
    }
    const after = await archive(community, id, { range: 'bytes=0-99' });
    expect(after.status).toBe(404);
  });
});
