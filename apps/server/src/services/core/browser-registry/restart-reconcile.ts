import {
  and,
  eq,
  ne,
  sql,
  browserInstances,
  browserProfiles,
  browserAttachments,
  type Db,
} from '@dorkos/db';
import { BrowserReferenceSchema } from '@dorkos/shared/browser-schemas';
import { BrowserRegistryConflict } from './registry-store.js';

/**
 * Fence historical metadata before acquisition after restart. No engine lookup,
 * stop success, old-ID rebind, automatic launch or quarantine release occurs.
 * Failed writes abort boot readiness by throwing and rolling back the transaction.
 */
export function quarantineBrowserRegistryAfterRestart(db: Db, currentBootId: string) {
  const bootId = BrowserReferenceSchema.parse(currentBootId);
  return db.transaction(() => {
    const rows = db
      .select()
      .from(browserInstances)
      .where(and(ne(browserInstances.bootId, bootId), ne(browserInstances.status, 'stopped')))
      .all();
    let changed = 0;
    for (const row of rows) {
      if (row.status !== 'uncertain') {
        if (row.revision === Number.MAX_SAFE_INTEGER) throw new BrowserRegistryConflict();
        const result = db
          .update(browserInstances)
          .set({
            status: 'uncertain',
            revision: row.revision + 1,
            updatedAt: new Date().toISOString(),
          })
          .where(
            and(
              eq(browserInstances.browserId, row.browserId),
              eq(browserInstances.ownerAuthorId, row.ownerAuthorId),
              eq(browserInstances.browserGeneration, row.browserGeneration),
              eq(browserInstances.revision, row.revision)
            )
          )
          .run();
        if (result.changes !== 1) throw new BrowserRegistryConflict();
        changed++;
      }
      if (row.profileId !== null) {
        const profile = db
          .select()
          .from(browserProfiles)
          .where(
            and(
              eq(browserProfiles.profileId, row.profileId),
              eq(browserProfiles.ownerAuthorId, row.ownerAuthorId)
            )
          )
          .get();
        if (!profile) throw new BrowserRegistryConflict();
        if (profile.status !== 'quarantined') {
          if (profile.revision === Number.MAX_SAFE_INTEGER) throw new BrowserRegistryConflict();
          const result = db
            .update(browserProfiles)
            .set({
              status: 'quarantined',
              revision: profile.revision + 1,
              updatedAt: new Date().toISOString(),
            })
            .where(
              and(
                eq(browserProfiles.profileId, profile.profileId),
                eq(browserProfiles.ownerAuthorId, profile.ownerAuthorId),
                eq(browserProfiles.revision, profile.revision)
              )
            )
            .run();
          if (result.changes !== 1) throw new BrowserRegistryConflict();
        }
      }
      // Tombstone each attachment once. Its reference cannot attach an old ID to a new engine.
      const exhausted = db
        .select({ id: browserAttachments.attachmentId })
        .from(browserAttachments)
        .where(
          and(
            eq(browserAttachments.browserId, row.browserId),
            eq(browserAttachments.ownerAuthorId, row.ownerAuthorId),
            eq(browserAttachments.browserGeneration, row.browserGeneration),
            sql`${browserAttachments.detachedAt} IS NULL`,
            eq(browserAttachments.revision, Number.MAX_SAFE_INTEGER)
          )
        )
        .get();
      if (exhausted) throw new BrowserRegistryConflict();
      db.update(browserAttachments)
        .set({
          detachedAt: new Date().toISOString(),
          revision: sql`${browserAttachments.revision} + 1`,
        })
        .where(
          and(
            eq(browserAttachments.browserId, row.browserId),
            eq(browserAttachments.ownerAuthorId, row.ownerAuthorId),
            eq(browserAttachments.browserGeneration, row.browserGeneration),
            sql`${browserAttachments.detachedAt} IS NULL`
          )
        )
        .run();
    }
    return Object.freeze({ quarantinedInstances: changed });
  });
}
