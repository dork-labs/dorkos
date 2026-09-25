import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { Context, Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  CommunityAdminImportCreateRequestSchema,
  CommunityAdminImportCreateResponseSchema,
  CommunityAdminImportMutationRequestSchema,
  CommunityAdminImportSchema,
} from '@dorkos/shared/community-admin-wire';
import { transaction } from '../data.js';
import type { CommunityConfig } from '../config.js';
import { createCommunityGated } from '../host/communities.js';
import { assignShortName, shortNameHoldKey, type ShortNameHolds } from '../host/short-names.js';
import {
  assertHostActor,
  recordHostAudit,
  type HostActor,
  type HostAuditActor,
  type HostAuthority,
} from '../host/authority.js';
import { ApiError, json, readJson } from '../http.js';
import {
  acquireUploadLease,
  archiveInvalid,
  assertTempSpace,
  leaseLost,
  receiveArchive,
  releaseUploadLease,
  renewUploadLease,
  type ReceivedArchive,
  type UploadSlots,
} from '../imports/upload.js';
import {
  IMPORT_UPLOAD_LEASE_MS,
  IMPORT_UPLOAD_WINDOW_MS,
  MAX_IMPORT_ARCHIVE_BYTES,
  importCreator,
  loadImport,
  projectImport,
  type ImportRow,
} from '../imports/store.js';
import { HOST_API_KEY_PATTERN, bearerCredential, hashSecret, randomToken } from '../security.js';
import {
  discardManagedBlob,
  managedBlobWriteSignal,
  reserveImportBlob,
  settleImportBlob,
  type BlobStore,
  type StoredBlob,
} from '../storage/index.js';

type CreateRequest = z.infer<typeof CommunityAdminImportCreateRequestSchema>;

/** The route pattern an upload streams to; the JSON body limit in `app.ts` skips it. */
export const IMPORT_ARCHIVE_UPLOAD_PATH = /^\/api\/v1\/imports\/[^/]+\/archive$/;

function payloadHash(body: CreateRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        name: body.name,
        description: body.description ?? null,
        admissionPolicy: body.admissionPolicy ?? 'invite_only',
        limits: body.limits
          ? {
              maxActiveMembers: body.limits.maxActiveMembers,
              maxStorageBytes: body.limits.maxStorageBytes,
            }
          : null,
        autoCommit: body.autoCommit ?? false,
        shortName: body.shortName ?? null,
      })
    )
    .digest('hex');
}

function parseImportId(value: string | undefined): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new ApiError(404, 'NOT_FOUND', 'Import not found.');
  return parsed.data;
}

/** The declared size and digest of an upload, checked before a byte of the body is read. */
function uploadHeaders(c: Context): { bytes: number; sha256: string } {
  const length = c.req.header('content-length');
  if (!length || !/^[1-9][0-9]{0,15}$/.test(length))
    throw archiveInvalid('Send the export with its Content-Length.');
  const bytes = Number(length);
  if (bytes > MAX_IMPORT_ARCHIVE_BYTES)
    throw new ApiError(413, 'IMPORT_TOO_LARGE', 'This export is larger than an import accepts.');
  const sha256 = c.req.header('x-archive-sha256');
  if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256))
    throw archiveInvalid('Send the export with its SHA-256 in X-Archive-SHA256.');
  return { bytes, sha256 };
}

/** Who may upload: the import's upload token, or host authority with `communities:import`. */
type Uploader = { kind: 'token'; tokenHash: string } | { kind: 'host'; actor: HostActor };

/**
 * Answer an upload that arrives after the export was already received: the same bytes again
 * are a success (a retry whose first answer was lost), different bytes a conflict.
 */
function repeatedUpload(row: ImportRow, sha256: string) {
  if (row.archive_sha256 === null)
    throw new ApiError(409, 'STATE_CONFLICT', 'This import is no longer accepting an export.');
  if (row.archive_sha256 !== sha256)
    throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'A different export was already uploaded.');
  return projectImport(row);
}

/**
 * Register the host's import routes: create, read, upload, commit, and cancel.
 *
 * An import writes an owner export's content into a brand-new, unclaimed community the host
 * cannot read back through any host route. No route here returns content: a read carries
 * state, counts, and sizes only.
 */
export function registerImportRoutes(
  app: Hono,
  deps: {
    pool: Pool;
    config: CommunityConfig;
    blobStore: BlobStore;
    authority: HostAuthority;
    now: () => Date;
    /** Count one failed upload-token attempt against the caller. */
    limitTokenMiss: (c: Context) => void;
    /** Uploads this replica receives at once. */
    uploadSlots: UploadSlots;
    /** How long an upload may go without a byte. Tests shorten it. */
    uploadIdleMs: number;
    /** Free bytes in the temporary folder. Tests replace it. */
    freeTempBytes?: () => Promise<number>;
  }
): void {
  const { pool, blobStore, authority, now, limitTokenMiss, uploadSlots, uploadIdleMs } = deps;
  const freeTempBytes = deps.freeTempBytes;
  const { config } = deps;
  const holds: ShortNameHolds = {
    key: shortNameHoldKey(config.authSecret),
    cooloffDays: config.limits.shortNameCooloffDays,
  };

  app.post('/host/imports', async (c) => {
    const actor = await authority.require(c, 'communities:import');
    const body = await readJson(c, CommunityAdminImportCreateRequestSchema);
    const token = randomToken();
    const hash = payloadHash(body);
    const result = await createCommunityGated(pool, blobStore, async (client: PoolClient) => {
      // The creation lock orders this against community creation and owner claims.
      await client.query('SELECT pg_advisory_xact_lock(77281503)');
      await assertHostActor(client, actor, now());
      const existing = await client.query<ImportRow>(
        'SELECT * FROM community_imports WHERE idempotency_key=$1 FOR UPDATE',
        [body.idempotencyKey]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].payload_hash !== hash)
          throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'That import key has different inputs.');
        return { row: existing.rows[0], replayed: true };
      }
      const community = await client.query<{ id: string }>(
        `INSERT INTO communities(name,description,admission_policy,lifecycle)
         VALUES($1,$2,$3,'pending_owner') RETURNING id`,
        [body.name, body.description ?? null, body.admissionPolicy ?? 'invite_only']
      );
      const communityId = community.rows[0].id;
      if (body.limits)
        await client.query(
          `INSERT INTO community_limits(community_id,max_active_members,max_storage_bytes)
           VALUES($1,$2,$3)`,
          [communityId, body.limits.maxActiveMembers, body.limits.maxStorageBytes]
        );
      if (body.shortName)
        await assignShortName(client, {
          communityId,
          shortName: body.shortName,
          reservedNames: config.reservedShortNames,
          holds,
          at: now(),
        });
      const created = await client.query<ImportRow>(
        `INSERT INTO community_imports(
           community_id,idempotency_key,payload_hash,auto_commit,upload_token_hash,
           upload_expires_at,created_by_user_id,created_by_api_key_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          communityId,
          body.idempotencyKey,
          hash,
          body.autoCommit ?? false,
          hashSecret(token),
          new Date(now().getTime() + IMPORT_UPLOAD_WINDOW_MS),
          actor.kind === 'person' ? actor.userId : null,
          actor.kind === 'api_key' ? actor.keyId : null,
        ]
      );
      await recordHostAudit(client, actor, {
        action: 'import.create',
        communityId,
        nextState: 'pending_owner',
        changedFields: [
          'name',
          'description',
          'admission_policy',
          ...(body.limits ? ['limits'] : []),
          ...(body.shortName ? ['short_name'] : []),
        ],
      });
      return { row: created.rows[0], replayed: false };
    });
    c.header('Cache-Control', 'no-store');
    return json(
      c,
      CommunityAdminImportCreateResponseSchema,
      {
        import: projectImport(result.row),
        uploadToken: result.replayed ? null : token,
        replayed: result.replayed,
      },
      result.replayed ? 200 : 201
    );
  });

  app.get('/host/imports/:id', async (c) => {
    await authority.require(c, 'communities:read');
    const row = await loadImport(pool, parseImportId(c.req.param('id')));
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Import not found.');
    return json(c, CommunityAdminImportSchema, projectImport(row));
  });

  app.post('/host/imports/:id/cancel', async (c) => {
    const actor = await authority.require(c, 'communities:import');
    await readJson(c, CommunityAdminImportMutationRequestSchema);
    const importId = parseImportId(c.req.param('id'));
    const row = await transaction(pool, async (client) => {
      const current = await loadImport(client, importId, 'FOR UPDATE');
      await assertHostActor(client, actor, now());
      if (!current) throw new ApiError(404, 'NOT_FOUND', 'Import not found.');
      if (current.state === 'cancelled') return current;
      if (current.state === 'ready' || current.state === 'failed')
        throw new ApiError(409, 'STATE_CONFLICT', 'This import has already finished.');
      // Clearing the lease fences a worker that holds this job: its next write finds no lease.
      const cancelled = await client.query<ImportRow>(
        `UPDATE community_imports SET state='cancelled',lease_token=NULL,next_attempt_at=now(),
           updated_at=now() WHERE id=$1 RETURNING *`,
        [importId]
      );
      await recordHostAudit(client, actor, {
        action: 'import.cancel',
        communityId: current.community_id,
        priorState: current.state,
        nextState: 'cancelled',
        changedFields: ['state'],
      });
      return cancelled.rows[0];
    });
    return json(c, CommunityAdminImportSchema, projectImport(row));
  });

  app.post('/host/imports/:id/commit', async (c) => {
    const actor = await authority.require(c, 'communities:import');
    await readJson(c, CommunityAdminImportMutationRequestSchema);
    const importId = parseImportId(c.req.param('id'));
    const row = await transaction(pool, async (client) => {
      const current = await loadImport(client, importId, 'FOR UPDATE');
      await assertHostActor(client, actor, now());
      if (!current) throw new ApiError(404, 'NOT_FOUND', 'Import not found.');
      if (current.state !== 'validated')
        throw new ApiError(409, 'STATE_CONFLICT', 'Only a checked import can be committed.');
      const committed = await client.query<ImportRow>(
        `UPDATE community_imports SET state='restoring',attempts=0,next_attempt_at=now(),
           updated_at=now() WHERE id=$1 RETURNING *`,
        [importId]
      );
      await recordHostAudit(client, actor, {
        action: 'import.commit',
        communityId: current.community_id,
        priorState: 'validated',
        nextState: 'restoring',
        changedFields: ['state'],
      });
      return committed.rows[0];
    });
    return json(c, CommunityAdminImportSchema, projectImport(row));
  });

  app.put('/imports/:id/archive', async (c) => {
    const importId = parseImportId(c.req.param('id'));
    const authorization = c.req.header('authorization');
    const bearer = bearerCredential(authorization);
    // A bearer that is not a host API key is the import's upload token; anything else goes
    // through host authority, which accepts a key or a host operator's session.
    const uploader: Uploader =
      authorization !== undefined && bearer !== null && !HOST_API_KEY_PATTERN.test(bearer)
        ? { kind: 'token', tokenHash: hashSecret(bearer) }
        : { kind: 'host', actor: await authority.require(c, 'communities:import') };
    const declared = uploadHeaders(c);

    const admitted = await loadImport(pool, importId);
    if (
      !admitted ||
      (uploader.kind === 'token' && admitted.upload_token_hash !== uploader.tokenHash)
    ) {
      if (uploader.kind === 'token') {
        limitTokenMiss(c);
        throw new ApiError(401, 'UNAUTHENTICATED', 'This upload link is not valid.');
      }
      throw new ApiError(404, 'NOT_FOUND', 'Import not found.');
    }
    // The token lives only as long as its window, even for a repeat of a finished upload.
    if (uploader.kind === 'token' && admitted.upload_expires_at <= now())
      throw new ApiError(401, 'UNAUTHENTICATED', 'The upload window for this import has closed.');
    if (admitted.state !== 'awaiting_upload')
      return json(c, CommunityAdminImportSchema, repeatedUpload(admitted, declared.sha256));
    if (admitted.upload_expires_at <= now())
      throw new ApiError(401, 'UNAUTHENTICATED', 'The upload window for this import has closed.');
    if (!c.req.raw.body) throw archiveInvalid('Send the export as the request body.');

    // Everything that can refuse happens before a byte of the body is read.
    const releaseSlot = uploadSlots.take(declared.bytes);
    let lease: string | null = null;
    try {
      await assertTempSpace(
        declared.bytes,
        freeTempBytes,
        uploadSlots.reservedBytes - declared.bytes * 2
      );
      lease = await acquireUploadLease(pool, importId);
      const leaseToken = lease;
      let renewedAt = Date.now();
      const received = await receiveArchive(c.req.raw.body, declared, {
        signal: c.req.raw.signal,
        idleMs: uploadIdleMs,
        onProgress: async () => {
          if (Date.now() - renewedAt < IMPORT_UPLOAD_LEASE_MS / 4) return;
          renewedAt = Date.now();
          if (!(await renewUploadLease(pool, importId, leaseToken))) throw leaseLost();
        },
      });
      try {
        return await storeArchive(c, importId, uploader, declared, received, leaseToken);
      } finally {
        await rm(received.directory, { recursive: true, force: true });
      }
    } finally {
      if (lease) await releaseUploadLease(pool, importId, lease).catch(() => undefined);
      releaseSlot();
    }
  });

  /** Store a received, verified export and move its import on to `validating`. */
  async function storeArchive(
    c: Context,
    importId: string,
    uploader: Uploader,
    declared: { bytes: number; sha256: string },
    received: ReceivedArchive,
    leaseToken: string
  ): Promise<Response> {
    const reservation = await transaction(pool, (client) =>
      reserveImportBlob(client, importId, 'import_staging', 'awaiting_upload')
    );
    // Storing a large export can outlast the lease, so it is renewed while the put runs; if
    // another upload took it meanwhile, this one stops.
    const lost = new AbortController();
    const renewal = setInterval(() => {
      void renewUploadLease(pool, importId, leaseToken)
        .then((held) => {
          if (!held) lost.abort();
        })
        .catch(() => undefined);
    }, IMPORT_UPLOAD_LEASE_MS / 4);
    let stored: StoredBlob;
    try {
      stored = await blobStore.put({
        key: reservation.key,
        source: createReadStream(received.path),
        displayName: 'community-import.zip',
        maxBytes: declared.bytes,
        kind: 'export',
        signal: AbortSignal.any([managedBlobWriteSignal(), lost.signal]),
      });
    } catch (error) {
      await discardManagedBlob(pool, blobStore, reservation).catch(() => undefined);
      if (lost.signal.aborted) throw leaseLost();
      console.error(
        'Community import upload could not be stored',
        error instanceof Error ? error.name : 'unknown'
      );
      throw new ApiError(503, 'UNAVAILABLE', 'The export could not be stored. Try again.');
    } finally {
      clearInterval(renewal);
    }
    const outcome = await transaction(pool, async (client) => {
      const current = await loadImport(client, importId, 'FOR UPDATE');
      if (!current) throw new ApiError(404, 'NOT_FOUND', 'Import not found.');
      if (uploader.kind === 'host') await assertHostActor(client, uploader.actor, now());
      if (current.state !== 'awaiting_upload') return { repeat: current };
      if (current.upload_expires_at <= now())
        throw new ApiError(401, 'UNAUTHENTICATED', 'The upload window for this import has closed.');
      await settleImportBlob(client, reservation, stored, 'committed');
      const updated = await client.query<ImportRow>(
        `UPDATE community_imports
         SET state='validating',staging_blob_key=$2,archive_sha256=$3,archive_bytes=$4,
           archive_received_at=now(),attempts=0,next_attempt_at=now(),updated_at=now()
         WHERE id=$1 RETURNING *`,
        [importId, stored.key, stored.sha256, stored.byteSize]
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
      return { row: updated.rows[0] };
    }).catch(async (error: unknown) => {
      await discardManagedBlob(pool, blobStore, reservation, stored).catch(() => undefined);
      throw error;
    });
    if ('repeat' in outcome && outcome.repeat) {
      // A host upload that raced another one; this copy is not needed either way.
      await discardManagedBlob(pool, blobStore, reservation, stored).catch(() => undefined);
      return json(c, CommunityAdminImportSchema, repeatedUpload(outcome.repeat, declared.sha256));
    }
    return json(c, CommunityAdminImportSchema, projectImport(outcome.row!));
  }
}
