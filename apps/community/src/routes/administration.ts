import type { Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  CommunityAdminDeletionRequestSchema,
  CommunityAdminDeletionStatusSchema,
  CommunityAdminOwnerLifecycleRequestSchema,
  CommunityAdminSettingsSchema,
  CommunityAdminSettingsUpdateRequestSchema,
} from '@dorkos/shared/community-admin-wire';
import type { CommunityAuth } from '../auth.js';
import type { ConfirmPassword } from '../password-confirmation.js';
import {
  communityHeld,
  requireMember,
  requireSessionUser,
  transaction,
  type Member,
} from '../data.js';
import { AdminSettingsConflict, ApiError, json, readJson } from '../http.js';
import { assertStorageRoom, assertStorageWithinLimit, countedBlobBytes } from '../host/limits.js';
import {
  BlobStoreError,
  completeManagedBlobCommit,
  discardManagedBlob,
  managedBlobWriteSignal,
  prepareManagedBlobCommit,
  queueCommittedBlobDeletion,
  reserveManagedBlob,
  type BlobStore,
} from '../storage/index.js';
import { prepareCommunityDeletionInventory } from '../deletion-worker.js';
import { resolveCommunityContext } from '../tenant-context.js';
import { revokeTenantAccess } from '../host/communities.js';

interface SettingsRow {
  id: string;
  name: string;
  description: string | null;
  admission_policy: 'invite_only' | 'closed';
  icon_blob_key: string | null;
  icon_content_type: string | null;
  settings_version: number;
  lifecycle: 'pending_owner' | 'active' | 'archived' | 'suspended' | 'held' | 'deletion_pending';
  lifecycle_version: number;
}

function projectSettings(row: SettingsRow) {
  return {
    communityId: row.id,
    name: row.name,
    description: row.description,
    admissionPolicy: row.admission_policy,
    hasIcon: row.icon_blob_key !== null,
    settingsVersion: row.settings_version,
    lifecycle: row.lifecycle,
    lifecycleVersion: row.lifecycle_version,
  };
}

function parseIfMatch(value: string | undefined): number | null {
  const match = value?.match(/^(?:W\/)?"?(\d+)"?$/);
  if (!match) return null;
  return Number(match[1]);
}

function settingsEtag(version: number): string {
  return `"${version}"`;
}

async function lockMember(
  client: PoolClient,
  actor: Member,
  roles: readonly Member['role'][]
): Promise<Member> {
  const current = await client.query<Member>(
    `SELECT id,user_id,display_name,role,community_id FROM members
     WHERE id=$1 AND community_id=$2 AND active FOR SHARE`,
    [actor.id, actor.community_id]
  );
  if (!current.rows[0] || !roles.includes(current.rows[0].role)) {
    throw new ApiError(403, 'FORBIDDEN', 'Your current role cannot perform this action.');
  }
  return current.rows[0];
}

/** Lock the Community before its acting member to match lifecycle and pairing transitions. */
async function lockSettings(client: PoolClient, communityId: string): Promise<SettingsRow> {
  const result = await client.query<SettingsRow>(
    `SELECT id,name,description,admission_policy,icon_blob_key,settings_version,
            icon_content_type,lifecycle,lifecycle_version
     FROM communities WHERE id=$1 FOR UPDATE`,
    [communityId]
  );
  if (!result.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
  return result.rows[0];
}

function assertReadableLifecycle(row: SettingsRow): void {
  if (row.lifecycle === 'suspended') {
    throw new ApiError(503, 'COMMUNITY_SUSPENDED', 'This community is suspended.');
  }
  if (row.lifecycle === 'deletion_pending') {
    throw new ApiError(423, 'COMMUNITY_DELETION_PENDING', 'This community is being deleted.');
  }
  if (row.lifecycle === 'pending_owner') {
    throw new ApiError(403, 'FORBIDDEN', 'This community has no owner.');
  }
}

async function* requestBytes(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) return;
      yield item.value;
    }
  } finally {
    reader.releaseLock();
  }
}

function mapIconBlobError(error: unknown): never {
  if (error instanceof BlobStoreError) {
    if (error.code === 'BLOB_TOO_LARGE')
      throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', 'The icon is larger than 2 MiB.');
    if (error.code === 'BLOB_TYPE_REJECTED' || error.code === 'BLOB_EMPTY')
      throw new ApiError(415, 'UNSUPPORTED_ATTACHMENT_TYPE', 'Use a PNG, JPEG, GIF, or WebP icon.');
    if (error.code === 'BLOB_NOT_FOUND')
      throw new ApiError(404, 'NOT_FOUND', 'Community icon not found.');
  }
  throw error;
}

function deletionProjection(row: {
  community_id: string;
  lifecycle: string;
  lifecycle_version: number;
  delete_after: Date | null;
  state: 'waiting' | 'deleting' | 'retrying' | null;
  attempts: number | null;
  requested_by: 'owner' | 'host' | null;
  returns_to: 'archived' | 'suspended' | 'held' | null;
}) {
  return {
    communityId: row.community_id,
    lifecycle: row.lifecycle as 'active' | 'archived' | 'suspended' | 'held' | 'deletion_pending',
    lifecycleVersion: row.lifecycle_version,
    deleteAfter: row.delete_after?.toISOString() ?? null,
    state: row.state,
    attempts: row.attempts ?? 0,
    requestedBy: row.requested_by,
    returnsTo: row.returns_to,
    takedown: null,
  };
}

/** Who asked for a pending deletion, and where cancelling it would return the community. */
const deletionOrigin = `CASE WHEN c.delete_requested_by_host_actor IS NOT NULL THEN 'host'
    WHEN c.delete_requested_by IS NOT NULL THEN 'owner' END AS requested_by,
  CASE WHEN c.lifecycle<>'deletion_pending' THEN NULL
    WHEN c.deletion_from_state IN ('held','suspended') THEN c.deletion_from_state
    ELSE 'archived' END AS returns_to`;

/**
 * Lifecycles the owner may ask to delete from. Neither a suspension nor a host's hold may trap
 * an owner: a hold stops growth, never an owner's own decision to delete.
 */
const DELETABLE: readonly string[] = ['active', 'archived', 'suspended', 'held'];

/** Register settings and owner lifecycle operations for one tenant-qualified Community. */
export function registerAdministrationRoutes(
  app: Hono,
  {
    pool,
    auth,
    blobStore,
    confirmPassword,
  }: { pool: Pool; auth: CommunityAuth; blobStore: BlobStore; confirmPassword: ConfirmPassword }
): void {
  app.get('/settings', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const result = await pool.query<SettingsRow>(
      `SELECT id,name,description,admission_policy,icon_blob_key,settings_version,
              icon_content_type,lifecycle,lifecycle_version
       FROM communities WHERE id=$1`,
      [actor.community_id]
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Community not found.');
    assertReadableLifecycle(row);
    c.header('ETag', settingsEtag(row.settings_version));
    return json(c, CommunityAdminSettingsSchema, projectSettings(row));
  });

  app.patch('/settings', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const expectedVersion = parseIfMatch(c.req.header('if-match'));
    const body = await readJson(c, CommunityAdminSettingsUpdateRequestSchema);
    const row = await transaction(pool, async (client) => {
      const current = await lockSettings(client, actor.community_id);
      const currentActor = await lockMember(client, actor, ['owner', 'admin']);
      if (current.lifecycle !== 'active') {
        if (current.lifecycle === 'archived') {
          throw new ApiError(423, 'COMMUNITY_ARCHIVED', 'This community is archived.');
        }
        if (current.lifecycle === 'held') throw communityHeld();
        assertReadableLifecycle(current);
      }
      if (current.settings_version !== expectedVersion) {
        throw new AdminSettingsConflict(projectSettings(current));
      }
      if (
        currentActor.role !== 'owner' &&
        (body.name !== undefined || body.admissionPolicy !== undefined)
      ) {
        throw new ApiError(403, 'FORBIDDEN', 'Only the owner can change identity or access.');
      }
      const changed = Object.keys(body);
      const updated = await client.query<SettingsRow>(
        `UPDATE communities SET
           name=COALESCE($2,name),
           description=CASE WHEN $3::boolean THEN $4 ELSE description END,
           admission_policy=COALESCE($5,admission_policy),
           settings_version=settings_version+1
         WHERE id=$1
         RETURNING id,name,description,admission_policy,icon_blob_key,settings_version,
                   icon_content_type,lifecycle,lifecycle_version`,
        [
          current.id,
          body.name ?? null,
          body.description !== undefined,
          body.description ?? null,
          body.admissionPolicy ?? null,
        ]
      );
      if (body.admissionPolicy === 'closed' && current.admission_policy !== 'closed') {
        await client.query(
          'UPDATE invites SET revoked_at=COALESCE(revoked_at,now()) WHERE community_id=$1',
          [current.id]
        );
        await client.query('DELETE FROM pending_admissions WHERE community_id=$1', [current.id]);
      }
      await client.query(
        `INSERT INTO audit_events(community_id,actor_member_id,action,changed_fields)
         VALUES($1,$2,'settings.update',$3)`,
        [current.id, currentActor.id, changed]
      );
      return updated.rows[0];
    });
    c.header('ETag', settingsEtag(row.settings_version));
    return json(c, CommunityAdminSettingsSchema, projectSettings(row));
  });

  app.put('/settings/icon', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const expectedVersion = parseIfMatch(c.req.header('if-match'));
    if (!c.req.raw.body) throw new ApiError(400, 'STATE_CONFLICT', 'Icon bytes are required.');
    const reservation = await transaction(pool, async (client) => {
      const current = await lockSettings(client, actor.community_id);
      await lockMember(client, actor, ['owner', 'admin']);
      if (current.lifecycle !== 'active') {
        if (current.lifecycle === 'archived')
          throw new ApiError(423, 'COMMUNITY_ARCHIVED', 'This community is archived.');
        if (current.lifecycle === 'held') throw communityHeld();
        assertReadableLifecycle(current);
      }
      if (current.settings_version !== expectedVersion)
        throw new AdminSettingsConflict(projectSettings(current));
      // Icons are at most 2 MiB; refuse early on the declared size, counting the icon replaced.
      await assertStorageRoom(
        client,
        current.id,
        Math.min(Number(c.req.header('content-length')) || 0, 2 * 1024 * 1024),
        current.icon_blob_key
      );
      return reserveManagedBlob(client, current.id, 'icon');
    });
    let stored;
    try {
      stored = await blobStore.put({
        key: reservation.key,
        source: requestBytes(c.req.raw.body),
        displayName: 'community-icon',
        maxBytes: 2 * 1024 * 1024,
        kind: 'icon',
        signal: managedBlobWriteSignal(c.req.raw.signal),
      });
    } catch (error) {
      await discardManagedBlob(pool, blobStore, reservation).catch(() => undefined);
      mapIconBlobError(error);
    }
    try {
      const row = await transaction(pool, async (client) => {
        const current = await lockSettings(client, actor.community_id);
        const currentActor = await lockMember(client, actor, ['owner', 'admin']);
        if (current.lifecycle === 'held') throw communityHeld();
        if (current.lifecycle !== 'active' || current.settings_version !== expectedVersion)
          throw new AdminSettingsConflict(projectSettings(current));
        await prepareManagedBlobCommit(client, reservation, stored);
        const updated = await client.query<SettingsRow>(
          `UPDATE communities SET icon_blob_key=$2,icon_content_type=$3,
             settings_version=settings_version+1 WHERE id=$1
           RETURNING id,name,description,admission_policy,icon_blob_key,icon_content_type,
                     settings_version,lifecycle,lifecycle_version`,
          [current.id, stored.key, stored.contentType]
        );
        await completeManagedBlobCommit(client, reservation);
        const replacedBytes = current.icon_blob_key
          ? await countedBlobBytes(client, current.id, current.icon_blob_key)
          : 0;
        if (current.icon_blob_key)
          await queueCommittedBlobDeletion(client, current.id, current.icon_blob_key);
        // After the old icon is queued for deletion, so replacing an icon counts only the new
        // one, and an icon no larger than the one it replaces always fits.
        await assertStorageWithinLimit(client, current.id, stored.byteSize - replacedBytes);
        await client.query(
          `INSERT INTO audit_events(community_id,actor_member_id,action,changed_fields)
           VALUES($1,$2,'settings.icon.update',ARRAY['icon'])`,
          [current.id, currentActor.id]
        );
        return updated.rows[0];
      });
      c.header('ETag', settingsEtag(row.settings_version));
      return json(c, CommunityAdminSettingsSchema, projectSettings(row));
    } catch (error) {
      await discardManagedBlob(pool, blobStore, reservation, stored).catch(() => undefined);
      throw error;
    }
  });

  app.delete('/settings/icon', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const expectedVersion = parseIfMatch(c.req.header('if-match'));
    const row = await transaction(pool, async (client) => {
      const current = await lockSettings(client, actor.community_id);
      const currentActor = await lockMember(client, actor, ['owner', 'admin']);
      if (current.lifecycle === 'held') throw communityHeld();
      if (current.lifecycle !== 'active' || current.settings_version !== expectedVersion)
        throw new AdminSettingsConflict(projectSettings(current));
      const updated = await client.query<SettingsRow>(
        `UPDATE communities SET icon_blob_key=NULL,icon_content_type=NULL,
           settings_version=settings_version+1 WHERE id=$1
         RETURNING id,name,description,admission_policy,icon_blob_key,icon_content_type,
                   settings_version,lifecycle,lifecycle_version`,
        [current.id]
      );
      if (current.icon_blob_key)
        await queueCommittedBlobDeletion(client, current.id, current.icon_blob_key);
      await client.query(
        `INSERT INTO audit_events(community_id,actor_member_id,action,changed_fields)
         VALUES($1,$2,'settings.icon.clear',ARRAY['icon'])`,
        [current.id, currentActor.id]
      );
      return updated.rows[0];
    });
    c.header('ETag', settingsEtag(row.settings_version));
    return json(c, CommunityAdminSettingsSchema, projectSettings(row));
  });

  app.get('/icon', async (c) => {
    const user = await requireSessionUser(c, auth);
    const tenant = await resolveCommunityContext(c, pool);
    const authorized = await pool.query(
      `SELECT 1 FROM members WHERE community_id=$1 AND user_id=$2 AND active
       UNION ALL
       SELECT 1 FROM host_operators WHERE user_id=$2 AND revoked_at IS NULL LIMIT 1`,
      [tenant.communityId, user.id]
    );
    if (!authorized.rowCount) throw new ApiError(403, 'FORBIDDEN', 'Icon access is unavailable.');
    const result = await pool.query<{
      icon_blob_key: string | null;
      icon_content_type: string | null;
    }>('SELECT icon_blob_key,icon_content_type FROM communities WHERE id=$1', [tenant.communityId]);
    const icon = result.rows[0];
    if (!icon?.icon_blob_key || !icon.icon_content_type)
      throw new ApiError(404, 'NOT_FOUND', 'Community icon not found.');
    let blob;
    try {
      blob = await blobStore.get(icon.icon_blob_key, { signal: c.req.raw.signal });
    } catch (error) {
      mapIconBlobError(error);
    }
    const iterator = blob.body[Symbol.asyncIterator]();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          blob.body.destroy();
          controller.error(error);
        }
      },
      async cancel() {
        blob.body.destroy();
        await iterator.return?.();
      },
    });
    return new Response(body, {
      headers: {
        'content-type': icon.icon_content_type,
        'content-length': String(blob.byteSize),
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  });

  app.post('/owner/lifecycle', async (c) => {
    const actor = await requireMember(c, auth, pool);
    const body = await readJson(c, CommunityAdminOwnerLifecycleRequestSchema);
    await confirmPassword(c, actor.user_id, body.password);
    const row = await transaction(pool, async (client) => {
      const current = await lockSettings(client, actor.community_id);
      const currentActor = await lockMember(client, actor, ['owner']);
      if (current.lifecycle_version !== body.lifecycleVersion) {
        throw new AdminSettingsConflict(projectSettings(current));
      }
      // Only the host releases a hold; an owner cannot archive or restore their way out of one.
      if (current.lifecycle === 'held') throw communityHeld();
      if (body.action === 'archive') {
        if (current.lifecycle !== 'active') {
          throw new ApiError(409, 'STATE_CONFLICT', 'Only an active community can be archived.');
        }
        if (body.confirmName !== current.name) {
          throw new ApiError(409, 'STATE_CONFLICT', 'Community name confirmation did not match.');
        }
        await revokeTenantAccess(client, current.id);
        await client.query(
          `UPDATE communities SET lifecycle='archived',archived_at=now(),
             lifecycle_version=lifecycle_version+1 WHERE id=$1`,
          [current.id]
        );
      } else {
        if (current.lifecycle !== 'archived') {
          throw new ApiError(409, 'STATE_CONFLICT', 'Only an archived community can be restored.');
        }
        await client.query(
          `UPDATE communities SET lifecycle='active',archived_at=NULL,
             lifecycle_version=lifecycle_version+1 WHERE id=$1`,
          [current.id]
        );
      }
      await client.query(
        `INSERT INTO audit_events(
           community_id,actor_member_id,action,prior_state,next_state,changed_fields
         ) VALUES($1,$2,$3,$4,$5,ARRAY['lifecycle'])`,
        [
          current.id,
          currentActor.id,
          `community.${body.action}`,
          current.lifecycle,
          body.action === 'archive' ? 'archived' : 'active',
        ]
      );
      return lockSettings(client, current.id);
    });
    return json(c, CommunityAdminSettingsSchema, projectSettings(row));
  });

  app.get('/owner/deletion', async (c) => {
    const actor = await requireMember(c, auth, pool, { allowDeletionPending: true });
    const result = await transaction(pool, async (client) => {
      const current = await lockSettings(client, actor.community_id);
      const currentActor = await lockMember(client, actor, ['owner']);
      const status = await client.query(
        `SELECT c.id AS community_id,c.lifecycle,c.lifecycle_version,c.delete_after,
                c.delete_requested_by,j.state,j.attempts,${deletionOrigin}
         FROM communities c LEFT JOIN community_deletion_jobs j ON j.community_id=c.id
         WHERE c.id=$1`,
        [current.id]
      );
      const row = status.rows[0];
      // The owner sees their own deletion, and one the host started; never another member's.
      if (
        current.lifecycle === 'deletion_pending' &&
        row.delete_requested_by !== null &&
        row.delete_requested_by !== currentActor.id
      ) {
        throw new ApiError(403, 'FORBIDDEN', 'Only the requesting owner can view this deletion.');
      }
      if (!['active', 'archived', 'held', 'deletion_pending'].includes(current.lifecycle)) {
        throw new ApiError(409, 'STATE_CONFLICT', 'Deletion status is unavailable.');
      }
      return row;
    });
    return json(c, CommunityAdminDeletionStatusSchema, deletionProjection(result));
  });

  app.post('/owner/deletion', async (c) => {
    // The one member route a suspension does not close: an owner must be able to delete a
    // suspended community, or they could never delete their own account.
    const actor = await requireMember(c, auth, pool, {
      allowDeletionPending: true,
      allowSuspended: true,
    });
    const body = await readJson(c, CommunityAdminDeletionRequestSchema);
    await confirmPassword(c, actor.user_id, body.password);
    const existing = await transaction(pool, async (client) => {
      const current = await lockSettings(client, actor.community_id);
      await lockMember(client, actor, ['owner']);
      if (current.lifecycle === 'deletion_pending') {
        const pending = await client.query(
          `SELECT c.id AS community_id,c.lifecycle,c.lifecycle_version,c.delete_after,
                  j.state,j.attempts,${deletionOrigin}
           FROM communities c JOIN community_deletion_jobs j ON j.community_id=c.id
           WHERE c.id=$1`,
          [current.id]
        );
        return pending.rows[0];
      }
      if (!DELETABLE.includes(current.lifecycle)) {
        throw new ApiError(409, 'STATE_CONFLICT', 'This community cannot be deleted now.');
      }
      if (current.lifecycle_version !== body.lifecycleVersion) {
        throw new AdminSettingsConflict(projectSettings(current));
      }
      if (body.confirmName !== current.name || body.confirmIdSuffix !== current.id.slice(-8)) {
        throw new ApiError(409, 'STATE_CONFLICT', 'Deletion confirmation did not match.');
      }
      return null;
    });
    if (existing) {
      return json(c, CommunityAdminDeletionStatusSchema, deletionProjection(existing));
    }
    if (!(await prepareCommunityDeletionInventory(pool, blobStore, actor.community_id))) {
      throw new ApiError(
        409,
        'STATE_CONFLICT',
        'Storage ownership must be reconciled before deleting this community.'
      );
    }
    const result = await transaction(pool, async (client) => {
      const current = await lockSettings(client, actor.community_id);
      const currentActor = await lockMember(client, actor, ['owner']);
      if (current.lifecycle === 'deletion_pending') {
        const existing = await client.query(
          `SELECT c.id AS community_id,c.lifecycle,c.lifecycle_version,c.delete_after,
                  j.state,j.attempts,${deletionOrigin}
           FROM communities c JOIN community_deletion_jobs j ON j.community_id=c.id
           WHERE c.id=$1`,
          [current.id]
        );
        return existing.rows[0];
      }
      if (!DELETABLE.includes(current.lifecycle)) {
        throw new ApiError(409, 'STATE_CONFLICT', 'This community cannot be deleted now.');
      }
      if (current.lifecycle_version !== body.lifecycleVersion) {
        throw new AdminSettingsConflict(projectSettings(current));
      }
      if (body.confirmName !== current.name || body.confirmIdSuffix !== current.id.slice(-8)) {
        throw new ApiError(409, 'STATE_CONFLICT', 'Deletion confirmation did not match.');
      }
      await revokeTenantAccess(client, current.id);
      const requestedAt = new Date();
      const deleteAfter = new Date(requestedAt.getTime() + 7 * 24 * 60 * 60_000);
      // Entering deletion_pending clears the suspension, so remember where a cancel returns. A
      // hold's own origin stays in held_from_state for as long as the hold lasts.
      const updated = await client.query<{ lifecycle_version: number }>(
        `UPDATE communities SET lifecycle='deletion_pending',archived_at=NULL,
           deletion_from_state=lifecycle,
           deletion_from_prior_state=CASE lifecycle
             WHEN 'suspended' THEN suspended_from_state WHEN 'held' THEN held_from_state END,
           suspended_from_state=NULL,suspended_at=NULL,
           delete_requested_at=$2,delete_after=$3,delete_requested_by=$4,
           lifecycle_version=lifecycle_version+1
         WHERE id=$1 RETURNING lifecycle_version`,
        [current.id, requestedAt, deleteAfter, currentActor.id]
      );
      await client.query(
        `INSERT INTO community_deletion_jobs(
           community_id,requested_by_member_id,lifecycle_version,delete_after,next_attempt_at
         ) VALUES($1,$2,$3,$4,$4)`,
        [current.id, currentActor.id, updated.rows[0].lifecycle_version, deleteAfter]
      );
      await client.query(
        `INSERT INTO audit_events(
           community_id,actor_member_id,action,prior_state,next_state,changed_fields
         ) VALUES($1,$2,'community.delete.request',$3,'deletion_pending',
                  ARRAY['lifecycle','delete_after'])`,
        [current.id, currentActor.id, current.lifecycle]
      );
      return {
        community_id: current.id,
        lifecycle: 'deletion_pending',
        lifecycle_version: updated.rows[0].lifecycle_version,
        delete_after: deleteAfter,
        state: 'waiting',
        attempts: 0,
        requested_by: 'owner',
        returns_to:
          current.lifecycle === 'held' || current.lifecycle === 'suspended'
            ? current.lifecycle
            : 'archived',
      };
    });
    return json(c, CommunityAdminDeletionStatusSchema, deletionProjection(result));
  });

  app.post('/owner/deletion/cancel', async (c) => {
    const actor = await requireMember(c, auth, pool, { allowDeletionPending: true });
    const body = await readJson(
      c,
      z.strictObject({ lifecycleVersion: z.int().positive(), password: z.string().min(1) })
    );
    await confirmPassword(c, actor.user_id, body.password);
    const result = await transaction(pool, async (client) => {
      const current = await client.query<
        SettingsRow & {
          delete_after: Date | null;
          delete_requested_by: string | null;
          deletion_from_state: string | null;
          deletion_from_prior_state: 'active' | 'archived' | 'held' | null;
        }
      >(
        `SELECT id,name,description,admission_policy,icon_blob_key,settings_version,
                lifecycle,lifecycle_version,delete_after,delete_requested_by,
                deletion_from_state,deletion_from_prior_state
         FROM communities WHERE id=$1 FOR UPDATE`,
        [actor.community_id]
      );
      const row = current.rows[0];
      const currentActor = await lockMember(client, actor, ['owner']);
      if (row?.lifecycle === 'deletion_pending' && row.delete_requested_by === null) {
        throw new ApiError(
          409,
          'STATE_CONFLICT',
          'The host started this deletion after its notice date. Only the host can cancel it.'
        );
      }
      if (
        !row ||
        row.lifecycle !== 'deletion_pending' ||
        row.lifecycle_version !== body.lifecycleVersion ||
        row.delete_requested_by !== currentActor.id ||
        !row.delete_after ||
        row.delete_after <= new Date()
      ) {
        throw new ApiError(409, 'STATE_CONFLICT', 'This deletion can no longer be cancelled.');
      }
      // A deletion requested while suspended returns to that suspension, and one requested while
      // held returns to the hold, so a cancel can never lift either; one requested while active
      // or archived keeps its content out of use, as archived.
      const restored =
        row.deletion_from_state === 'held'
          ? { lifecycle: 'held' as const, suspendedFrom: null }
          : row.deletion_from_state === 'suspended' && row.deletion_from_prior_state
            ? { lifecycle: 'suspended' as const, suspendedFrom: row.deletion_from_prior_state }
            : { lifecycle: 'archived' as const, suspendedFrom: null };
      const updated = await client.query<{ lifecycle_version: number }>(
        `UPDATE communities SET lifecycle=$2,
           archived_at=CASE WHEN $2='archived' OR $3='archived' THEN now() END,
           suspended_from_state=$3,suspended_at=CASE WHEN $2='suspended' THEN now() END,
           delete_requested_at=NULL,delete_after=NULL,delete_requested_by=NULL,
           lifecycle_version=lifecycle_version+1 WHERE id=$1 RETURNING lifecycle_version`,
        [row.id, restored.lifecycle, restored.suspendedFrom]
      );
      await client.query('DELETE FROM community_deletion_jobs WHERE community_id=$1', [row.id]);
      await client.query(
        `INSERT INTO audit_events(
           community_id,actor_member_id,action,prior_state,next_state,changed_fields
         ) VALUES($1,$2,'community.delete.cancel','deletion_pending',$3,
                  ARRAY['lifecycle','delete_after'])`,
        [row.id, currentActor.id, restored.lifecycle]
      );
      return {
        community_id: row.id,
        lifecycle: restored.lifecycle,
        lifecycle_version: updated.rows[0].lifecycle_version,
        delete_after: null,
        state: null,
        attempts: 0,
        requested_by: null,
        returns_to: null,
      };
    });
    return json(c, CommunityAdminDeletionStatusSchema, deletionProjection(result));
  });
}
