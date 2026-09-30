import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { Context, Hono } from 'hono';
import type { Pool } from 'pg';
import {
  CommunityAdminImportCompleteRequestSchema,
  CommunityAdminImportPartListSchema,
  CommunityAdminImportPartSchema,
  CommunityAdminImportSchema,
  COMMUNITY_IMPORT_MAX_PARTS,
} from '@dorkos/shared/community-admin-wire';
import { SegmentedBlobSource } from '../archive/segmented-source.js';
import type { CommunityConfig } from '../config.js';
import { transaction } from '../data.js';
import { assertHostActor, recordHostAudit, type HostAuditActor } from '../host/authority.js';
import { ApiError, json, RateLimited, readJson } from '../http.js';
import { queuePartDeletions } from './job.js';
import {
  acquireUploadLease,
  archiveInvalid,
  assertTempSpace,
  leaseLost,
  receiveArchive,
  releaseUploadLease,
  renewUploadLease,
  type UploadSlots,
} from './upload.js';
import {
  IMPORT_PART_UPLOADS_PER_IMPORT,
  IMPORT_UPLOAD_LEASE_MS,
  importCreator,
  loadImport,
  projectImport,
  type ImportRow,
} from './store.js';
import {
  discardManagedBlob,
  managedBlobWriteSignal,
  queueCommittedBlobDeletion,
  reserveImportBlob,
  settleImportBlob,
  type BlobStore,
  type StoredBlob,
} from '../storage/index.js';
import type { Uploader } from '../routes/host/imports.js';

/** Part upload routes stream their bodies; the JSON body limit in `app.ts` skips them. */
export const IMPORT_PART_UPLOAD_PATH = /^\/api\/v1\/imports\/[^/]+\/archive\/parts\/[^/]+$/;

/** How long a refused part upload should wait before trying again. */
const PART_RETRY_AFTER_SECONDS = 5;

const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** One `community_import_parts` row as the routes read it. */
interface PartRow {
  part_number: number;
  blob_key: string;
  byte_size: string;
  sha256: string;
}

function projectPart(part: PartRow) {
  return {
    partNumber: part.part_number,
    byteSize: Number(part.byte_size),
    sha256: part.sha256,
  };
}

async function listParts(pool: Pick<Pool, 'query'>, importId: string): Promise<PartRow[]> {
  const parts = await pool.query<PartRow>(
    `SELECT part_number,blob_key,byte_size::text,sha256 FROM community_import_parts
     WHERE import_id=$1 ORDER BY part_number`,
    [importId]
  );
  return parts.rows;
}

function parsePartNumber(value: string | undefined): number {
  if (!value || !/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > COMMUNITY_IMPORT_MAX_PARTS)
    throw archiveInvalid(`Part numbers run from 1 to ${COMMUNITY_IMPORT_MAX_PARTS}.`);
  return Number(value);
}

/**
 * Take one of the import's part-upload leases, across every replica: at most
 * {@link IMPORT_PART_UPLOADS_PER_IMPORT} at once (`429` with `Retry-After` beyond that), one
 * per part number (`409`), none while a single upload or `complete` holds the upload lease, and
 * none that would take the parts received and arriving past the largest export this host
 * accepts in parts (`413`).
 */
async function acquirePartLease(
  pool: Pool,
  importId: string,
  partNumber: number,
  bytes: number,
  maxArchiveBytes: number
): Promise<string> {
  return transaction(pool, async (client) => {
    const held = await client.query<{ state: string; leased: boolean }>(
      `SELECT state,COALESCE(upload_lease_until>=now(),false) AS leased
       FROM community_imports WHERE id=$1 FOR UPDATE`,
      [importId]
    );
    const row = held.rows[0];
    if (!row || row.state !== 'awaiting_upload')
      throw new ApiError(409, 'STATE_CONFLICT', 'This import is no longer accepting an export.');
    if (row.leased)
      throw new ApiError(409, 'STATE_CONFLICT', 'This export is already being uploaded.');
    await client.query(
      'DELETE FROM community_import_part_uploads WHERE import_id=$1 AND lease_until<now()',
      [importId]
    );
    const arriving = await client.query<{ part_number: number }>(
      'SELECT part_number FROM community_import_part_uploads WHERE import_id=$1',
      [importId]
    );
    if (arriving.rows.some((upload) => upload.part_number === partNumber))
      throw new ApiError(409, 'STATE_CONFLICT', 'This part is already being uploaded.');
    if (arriving.rows.length >= IMPORT_PART_UPLOADS_PER_IMPORT)
      throw new RateLimited(
        'Too many parts of this export are uploading. Try again soon.',
        PART_RETRY_AFTER_SECONDS
      );
    // Parts received, and parts still arriving at their declared sizes.
    const others = await client.query<{ bytes: string }>(
      `SELECT (
         (SELECT COALESCE(sum(byte_size),0) FROM community_import_parts
          WHERE import_id=$1 AND part_number<>$2)
         + (SELECT COALESCE(sum(declared_bytes),0) FROM community_import_part_uploads
            WHERE import_id=$1)
       )::text AS bytes`,
      [importId, partNumber]
    );
    if (Number(others.rows[0].bytes) + bytes > maxArchiveBytes)
      throw new ApiError(413, 'IMPORT_TOO_LARGE', 'This export is larger than an import accepts.');
    const leased = await client.query<{ lease_token: string }>(
      `INSERT INTO community_import_part_uploads(import_id,part_number,declared_bytes,lease_until)
       VALUES($1,$2,$3,now() + ($4 * interval '1 millisecond')) RETURNING lease_token`,
      [importId, partNumber, bytes, IMPORT_UPLOAD_LEASE_MS]
    );
    return leased.rows[0].lease_token;
  });
}

async function renewPartLease(pool: Pool, token: string): Promise<boolean> {
  const renewed = await pool.query(
    `UPDATE community_import_part_uploads
     SET lease_until=now() + ($2 * interval '1 millisecond') WHERE lease_token=$1`,
    [token, IMPORT_UPLOAD_LEASE_MS]
  );
  return renewed.rowCount === 1;
}

/**
 * Register the routes that upload an export in numbered parts, beside the single upload:
 * put a part, list the parts received (to resume after a crash), and put them together.
 *
 * Each is authorized like the single upload, by the import's upload token or host authority
 * with `communities:import`. A part is stored as its own managed blob and checked against the
 * SHA-256 its uploader declared; `complete` streams every part in order, checks the whole
 * export's size and SHA-256, and only then spends the token and hands the import to the
 * worker. No route here returns content.
 */
export function registerImportPartRoutes(
  app: Hono,
  deps: {
    pool: Pool;
    config: CommunityConfig;
    blobStore: BlobStore;
    now: () => Date;
    /** Admit an upload request, as the single upload does. */
    admit: (c: Context, importId: string) => Promise<{ uploader: Uploader; row: ImportRow }>;
    parseImportId: (value: string | undefined) => string;
    /** Part uploads this replica receives at once. */
    partSlots: UploadSlots;
    /** Single uploads in flight on this replica, which share its temporary folder. */
    uploadSlots: UploadSlots;
    uploadIdleMs: number;
    freeTempBytes?: () => Promise<number>;
    /** The largest export one single upload accepts, as imports report it. */
    singleMaxBytes: number;
    /** Test seams. */
    hooks?: { beforeCompleteHash?: (importId: string) => Promise<void> };
  }
): void {
  const { pool, config, blobStore, now, partSlots, uploadSlots } = deps;
  const maxPartBytes = config.exports.segmentBytes;
  const maxArchiveBytes = config.imports.maxBytes;

  app.put('/imports/:id/archive/parts/:partNumber', async (c) => {
    const importId = deps.parseImportId(c.req.param('id'));
    const partNumber = parsePartNumber(c.req.param('partNumber'));
    const { uploader, row } = await deps.admit(c, importId);
    const length = c.req.header('content-length');
    if (!length || !/^[1-9][0-9]{0,15}$/.test(length))
      throw archiveInvalid('Send the part with its Content-Length.');
    const bytes = Number(length);
    if (bytes > maxPartBytes)
      throw new ApiError(413, 'IMPORT_TOO_LARGE', 'This part is larger than a part may be.');
    const sha256 = c.req.header('x-part-sha256');
    if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256))
      throw archiveInvalid('Send the part with its SHA-256 in X-Part-SHA256.');
    if (row.state !== 'awaiting_upload')
      throw new ApiError(409, 'STATE_CONFLICT', 'This import is no longer accepting an export.');
    if (row.upload_expires_at <= now())
      throw new ApiError(401, 'UNAUTHENTICATED', 'The upload window for this import has closed.');
    // The same part again, as a retry whose answer was lost: nothing to write.
    const existing = await pool.query<PartRow>(
      `SELECT part_number,blob_key,byte_size::text,sha256 FROM community_import_parts
       WHERE import_id=$1 AND part_number=$2`,
      [importId, partNumber]
    );
    if (existing.rows[0]?.sha256 === sha256 && Number(existing.rows[0].byte_size) === bytes)
      return json(c, CommunityAdminImportPartSchema, projectPart(existing.rows[0]));
    if (!c.req.raw.body) throw archiveInvalid('Send the part as the request body.');

    // Everything that can refuse happens before a byte of the body is read.
    const releaseSlot = partSlots.take(bytes);
    let lease: string | null = null;
    try {
      await assertTempSpace(
        bytes,
        deps.freeTempBytes,
        partSlots.reservedBytes + uploadSlots.reservedBytes - bytes * 2
      );
      lease = await acquirePartLease(pool, importId, partNumber, bytes, maxArchiveBytes);
      const leaseToken = lease;
      let renewedAt = Date.now();
      const received = await receiveArchive(
        c.req.raw.body,
        { bytes, sha256 },
        {
          signal: c.req.raw.signal,
          idleMs: deps.uploadIdleMs,
          zip: partNumber === 1,
          onProgress: async () => {
            if (Date.now() - renewedAt < IMPORT_UPLOAD_LEASE_MS / 4) return;
            renewedAt = Date.now();
            if (!(await renewPartLease(pool, leaseToken))) throw leaseLost();
          },
        }
      );
      try {
        return await storePart(c, importId, partNumber, uploader, received.path, leaseToken, {
          bytes,
          sha256,
        });
      } finally {
        await rm(received.directory, { recursive: true, force: true });
      }
    } finally {
      if (lease)
        await pool
          .query('DELETE FROM community_import_part_uploads WHERE lease_token=$1', [lease])
          .catch(() => undefined);
      releaseSlot();
    }
  });

  /** Store one received, verified part and record it, replacing a different earlier copy. */
  async function storePart(
    c: Context,
    importId: string,
    partNumber: number,
    uploader: Uploader,
    path: string,
    leaseToken: string,
    declared: { bytes: number; sha256: string }
  ): Promise<Response> {
    const reservation = await transaction(pool, (client) =>
      reserveImportBlob(client, importId, 'import_staging', 'awaiting_upload')
    );
    const lost = new AbortController();
    const renewal = setInterval(() => {
      void renewPartLease(pool, leaseToken)
        .then((held) => {
          if (!held) lost.abort();
        })
        .catch(() => undefined);
    }, IMPORT_UPLOAD_LEASE_MS / 4);
    let stored: StoredBlob;
    try {
      stored = await blobStore.put({
        key: reservation.key,
        source: createReadStream(path),
        displayName: 'community-import.part',
        maxBytes: declared.bytes,
        kind: 'import_part',
        signal: AbortSignal.any([managedBlobWriteSignal(), lost.signal]),
      });
    } catch (error) {
      await discardManagedBlob(pool, blobStore, reservation).catch(() => undefined);
      if (lost.signal.aborted) throw leaseLost();
      console.error(
        'Community import part could not be stored',
        error instanceof Error ? error.name : 'unknown'
      );
      throw new ApiError(503, 'UNAVAILABLE', 'The part could not be stored. Try again.');
    } finally {
      clearInterval(renewal);
    }
    try {
      const part = await transaction(pool, async (client) => {
        const current = await loadImport(client, importId, 'FOR UPDATE');
        if (!current) throw new ApiError(404, 'NOT_FOUND', 'Import not found.');
        if (uploader.kind === 'host') await assertHostActor(client, uploader.actor, now());
        if (current.state !== 'awaiting_upload')
          throw new ApiError(
            409,
            'STATE_CONFLICT',
            'This import is no longer accepting an export.'
          );
        if (current.upload_expires_at <= now())
          throw new ApiError(
            401,
            'UNAUTHENTICATED',
            'The upload window for this import has closed.'
          );
        const held = await client.query(
          `SELECT 1 FROM community_import_part_uploads
           WHERE lease_token=$1 AND import_id=$2 AND part_number=$3 AND lease_until>=now()`,
          [leaseToken, importId, partNumber]
        );
        if (!held.rowCount) throw leaseLost();
        if (stored.byteSize !== declared.bytes || stored.sha256 !== declared.sha256)
          throw archiveInvalid('The part does not match its declared SHA-256.');
        await settleImportBlob(client, reservation, stored, 'committed');
        const replaced = await client.query<{ blob_key: string }>(
          'SELECT blob_key FROM community_import_parts WHERE import_id=$1 AND part_number=$2',
          [importId, partNumber]
        );
        const written = await client.query<PartRow>(
          `INSERT INTO community_import_parts(import_id,part_number,blob_key,byte_size,sha256)
           VALUES($1,$2,$3,$4,$5)
           ON CONFLICT(import_id,part_number) DO UPDATE
             SET blob_key=EXCLUDED.blob_key,byte_size=EXCLUDED.byte_size,sha256=EXCLUDED.sha256,
               created_at=now()
           RETURNING part_number,blob_key,byte_size::text,sha256`,
          [importId, partNumber, stored.key, stored.byteSize, stored.sha256]
        );
        // A different part under the same number replaces it; the old bytes go.
        if (replaced.rows[0])
          await queueCommittedBlobDeletion(
            client,
            current.community_id!,
            replaced.rows[0].blob_key
          );
        return written.rows[0];
      });
      return json(c, CommunityAdminImportPartSchema, projectPart(part));
    } catch (error) {
      await discardManagedBlob(pool, blobStore, reservation, stored).catch(() => undefined);
      throw error;
    }
  }

  app.get('/imports/:id/archive/parts', async (c) => {
    const importId = deps.parseImportId(c.req.param('id'));
    await deps.admit(c, importId);
    c.header('Cache-Control', 'no-store');
    return json(c, CommunityAdminImportPartListSchema, {
      parts: (await listParts(pool, importId)).map(projectPart),
      maxPartBytes,
      maxArchiveBytes,
    });
  });

  app.post('/imports/:id/archive/complete', async (c) => {
    const importId = deps.parseImportId(c.req.param('id'));
    const { uploader, row } = await deps.admit(c, importId);
    const body = await readJson(c, CommunityAdminImportCompleteRequestSchema);
    if (row.state !== 'awaiting_upload') {
      // A retry of a `complete` that already succeeded, whose answer was lost.
      if (row.upload_kind === 'parts' && row.archive_sha256 === body.archiveSha256)
        return json(c, CommunityAdminImportSchema, projectImport(row, deps.singleMaxBytes));
      throw new ApiError(409, 'STATE_CONFLICT', 'This import is no longer accepting an export.');
    }
    if (row.upload_expires_at <= now())
      throw new ApiError(401, 'UNAUTHENTICATED', 'The upload window for this import has closed.');
    if (body.archiveBytes > maxArchiveBytes)
      throw new ApiError(413, 'IMPORT_TOO_LARGE', 'This export is larger than an import accepts.');

    // A `complete` already checking these parts (one whose caller gave up waiting, say behind a
    // proxy timeout) carries on without its caller; a retry is told to ask again shortly.
    const stillChecking = async () =>
      Boolean(
        (
          await pool.query(
            `SELECT 1 FROM community_imports i
             WHERE i.id=$1 AND i.upload_lease_until>=now()
               AND EXISTS(SELECT 1 FROM community_import_parts p WHERE p.import_id=i.id)`,
            [importId]
          )
        ).rowCount
      );
    const askAgain = () => {
      c.header('Retry-After', String(PART_RETRY_AFTER_SECONDS));
      return json(c, CommunityAdminImportSchema, projectImport(row, deps.singleMaxBytes), 202);
    };
    if (await stillChecking()) return askAgain();
    let lease: string;
    try {
      lease = await acquireUploadLease(pool, importId, 'complete');
    } catch (error) {
      // Another `complete` took the lease between the look above and this one.
      if (error instanceof ApiError && error.status === 409 && (await stillChecking()))
        return askAgain();
      throw error;
    }
    try {
      const parts = await listParts(pool, importId);
      if (
        parts.length !== body.parts ||
        parts.some((part, index) => part.part_number !== index + 1)
      )
        throw archiveInvalid(`Upload parts 1 to ${body.parts}, and no others, first.`);
      const source = new SegmentedBlobSource(
        blobStore,
        parts.map((part) => ({ key: part.blob_key, byteSize: Number(part.byte_size) }))
      );
      // A size that does not add up is a mistake in the request, not in the parts: they stay.
      if (source.size !== body.archiveBytes)
        throw archiveInvalid('The parts do not add up to the declared size.');
      await deps.hooks?.beforeCompleteHash?.(importId);
      // Not the request's signal: a caller that disconnects does not stop the check, which then
      // settles the import on its own, so a retried `complete` finds the answer.
      const matches = await wholeExportMatches(source, body.archiveSha256, async () => {
        if (!(await renewUploadLease(pool, importId, lease))) throw leaseLost();
      });
      if (!matches) {
        // The parts do not add up to the export the uploader meant; none of them can be trusted.
        await transaction(pool, async (client) => {
          const current = await loadImport(client, importId, 'FOR UPDATE');
          if (current?.state === 'awaiting_upload' && current.community_id)
            await queuePartDeletions(client, importId, current.community_id);
        });
        throw archiveInvalid(
          'The parts do not add up to the declared size and SHA-256. Upload them again.'
        );
      }
      const fingerprint = partFingerprint(parts);
      const updated = await transaction(pool, async (client) => {
        const current = await loadImport(client, importId, 'FOR UPDATE');
        if (!current) throw new ApiError(404, 'NOT_FOUND', 'Import not found.');
        if (uploader.kind === 'host') await assertHostActor(client, uploader.actor, now());
        // The window was open when this check began, and an import whose lease is held does
        // not expire (see `expireImports`), so a long check finishes even past the window.
        if (current.state !== 'awaiting_upload' || current.upload_lease_token !== lease)
          throw leaseLost();
        // Belt and braces: no part can change while this request holds the upload lease (a part
        // upload refuses to start under it), but the parts checked must be the parts committed.
        if (partFingerprint(await listParts(client, importId)) !== fingerprint) throw leaseLost();
        const moved = await client.query<ImportRow>(
          `UPDATE community_imports
           SET state='validating',archive_sha256=$2,archive_bytes=$3,archive_received_at=now(),
             upload_kind='parts',attempts=0,next_attempt_at=now(),updated_at=now()
           WHERE id=$1 RETURNING *`,
          [importId, body.archiveSha256, body.archiveBytes]
        );
        const actor: HostAuditActor =
          uploader.kind === 'host' ? uploader.actor : importCreator(current);
        await recordHostAudit(client, actor, {
          action: 'import.upload',
          communityId: current.community_id,
          priorState: 'awaiting_upload',
          nextState: 'validating',
          changedFields: ['archive'],
        });
        return moved.rows[0];
      });
      return json(c, CommunityAdminImportSchema, projectImport(updated, deps.singleMaxBytes));
    } finally {
      await releaseUploadLease(pool, importId, lease).catch(() => undefined);
    }
  });
}

/** Which parts, with which bytes, an import holds: changes when any part is replaced. */
function partFingerprint(parts: PartRow[]): string {
  return parts.map((part) => `${part.part_number}:${part.blob_key}:${part.sha256}`).join(',');
}

/**
 * Stream the parts in order and compare the whole with the declared SHA-256. The export must
 * start a zip archive, as a single upload must.
 */
async function wholeExportMatches(
  source: SegmentedBlobSource,
  sha256: string,
  keepLease: () => Promise<void>
): Promise<boolean> {
  const hash = createHash('sha256');
  let head = Buffer.alloc(0);
  let renewedAt = Date.now();
  for await (const chunk of source.read(0, source.size - 1)) {
    if (head.length < ZIP_LOCAL_HEADER.length)
      head = Buffer.concat([head, chunk.subarray(0, ZIP_LOCAL_HEADER.length - head.length)]);
    hash.update(chunk);
    if (Date.now() - renewedAt >= IMPORT_UPLOAD_LEASE_MS / 4) {
      renewedAt = Date.now();
      await keepLease();
    }
  }
  return head.equals(ZIP_LOCAL_HEADER) && hash.digest('hex') === sha256;
}
