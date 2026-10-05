import {
  and,
  eq,
  isNull,
  sql,
  authors,
  browserProfiles,
  browserInstances,
  browserAttachments,
  type Db,
  type BrowserProfileRow,
  type BrowserInstanceRow,
} from '@dorkos/db';
import {
  BrowserAttachmentSchema,
  BrowserCounterSchema,
  BrowserInstanceSchema,
  BrowserProfileSchema,
  BrowserReferenceSchema,
  type BrowserAttachment,
  type BrowserInstance,
  type BrowserProfile,
} from '@dorkos/shared/browser-schemas';
import type { BrowserOwnerScope, createBrowserOwnerScopeResolver } from './owner-scope.js';

/** Fixed private metadata refusal; database errors retain their original cause. */
export class BrowserRegistryConflict extends Error {
  constructor() {
    super('Browser metadata is inaccessible or stale.');
    this.name = 'BrowserRegistryConflict';
  }
}
const conflict = (): never => {
  throw new BrowserRegistryConflict();
};
const ref = (value: string) => BrowserReferenceSchema.parse(value);
const counter = (value: number) => BrowserCounterSchema.parse(value);
const now = () => new Date().toISOString();
const incrementable = (value: number) => value < Number.MAX_SAFE_INTEGER;
const profileProjection = (row: BrowserProfileRow): Readonly<BrowserProfile> =>
  Object.freeze(
    BrowserProfileSchema.parse({
      profileId: row.profileId,
      label: row.label,
      revision: row.revision,
      status: row.status,
    })
  );
const instanceProjection = (row: BrowserInstanceRow): Readonly<BrowserInstance> => {
  // SQLite is not a live-engine producer. No persisted active status becomes live truth.
  const status = row.status === 'stopped' ? 'stopped' : 'uncertain';
  return row.mode === 'persistent'
    ? Object.freeze(
        BrowserInstanceSchema.parse({
          browserId: row.browserId,
          browserGeneration: row.browserGeneration,
          mode: 'persistent',
          profileId: row.profileId,
          status,
        })
      )
    : Object.freeze(
        BrowserInstanceSchema.parse({
          browserId: row.browserId,
          browserGeneration: row.browserGeneration,
          mode: 'ephemeral',
          status,
        })
      );
};

/**
 * Metadata-only store. Each operation consumes a fresh scope from trusted server composition.
 * Attachment target visibility is the caller's separate obligation; no grant is issued here.
 * There is deliberately no stop-success or quarantine-release operation.
 */
export function createBrowserRegistryStore(
  db: Db,
  resolver: ReturnType<typeof createBrowserOwnerScopeResolver>
) {
  function owner(scope: BrowserOwnerScope | null): string {
    const namespace = resolver.consume(scope);
    if (!namespace) return conflict();
    const author = db
      .select({ kind: authors.kind })
      .from(authors)
      .where(eq(authors.id, namespace.ownerAuthorId))
      .get();
    if (author?.kind !== 'human') return conflict();
    return namespace.ownerAuthorId;
  }
  function transact<T>(scope: BrowserOwnerScope | null, write: (ownerId: string) => T): T {
    return db.transaction(() => write(owner(scope)));
  }
  return Object.freeze({
    createProfile(scope: BrowserOwnerScope | null, input: { profileId: string; label: string }) {
      const value = BrowserProfileSchema.parse({ ...input, revision: 0, status: 'available' });
      return transact(scope, (ownerId) => {
        const stamp = now();
        db.insert(browserProfiles)
          .values({
            ...value,
            ownerAuthorId: ownerId,
            mode: 'persistent',
            metadataVersion: 1,
            createdAt: stamp,
            updatedAt: stamp,
          })
          .run();
        return Object.freeze(value);
      });
    },
    listProfiles(scope: BrowserOwnerScope | null) {
      return transact(scope, (ownerId) =>
        Object.freeze(
          db
            .select()
            .from(browserProfiles)
            .where(eq(browserProfiles.ownerAuthorId, ownerId))
            .all()
            .map(profileProjection)
        )
      );
    },
    renameProfile(
      scope: BrowserOwnerScope | null,
      input: { profileId: string; expectedRevision: number; label: string }
    ) {
      const profileId = ref(input.profileId),
        revision = counter(input.expectedRevision);
      const value = BrowserProfileSchema.parse({
        profileId,
        label: input.label,
        revision,
        status: 'available',
      });
      if (!incrementable(revision)) return conflict();
      return transact(scope, (ownerId) => {
        const rows = db
          .update(browserProfiles)
          .set({ label: value.label, revision: revision + 1, updatedAt: now() })
          .where(
            and(
              eq(browserProfiles.profileId, profileId),
              eq(browserProfiles.ownerAuthorId, ownerId),
              eq(browserProfiles.revision, revision)
            )
          )
          .returning()
          .all();
        if (rows.length !== 1) return conflict();
        return profileProjection(rows[0]!);
      });
    },
    reserveInstance(
      scope: BrowserOwnerScope | null,
      input: { browserId: string; browserGeneration: number; bootId: string } & (
        | { mode: 'persistent'; profileId: string; expectedProfileRevision: number }
        | { mode: 'ephemeral' }
      )
    ) {
      const browserId = ref(input.browserId),
        generation = counter(input.browserGeneration),
        bootId = ref(input.bootId);
      const profileId = input.mode === 'persistent' ? ref(input.profileId) : null;
      const profileRevision =
        input.mode === 'persistent' ? counter(input.expectedProfileRevision) : null;
      return transact(scope, (ownerId) => {
        const stamp = now();
        if (profileId !== null) {
          const reserved = db
            .update(browserProfiles)
            .set({
              status: 'inUse',
              revision: sql`${browserProfiles.revision} + 1`,
              updatedAt: stamp,
            })
            .where(
              and(
                eq(browserProfiles.profileId, profileId),
                eq(browserProfiles.ownerAuthorId, ownerId),
                eq(browserProfiles.status, 'available'),
                eq(browserProfiles.revision, profileRevision!),
                sql`${browserProfiles.revision} < 9007199254740991`
              )
            )
            .returning()
            .all();
          if (reserved.length !== 1) return conflict();
        }
        db.insert(browserInstances)
          .values({
            browserId,
            ownerAuthorId: ownerId,
            profileId,
            mode: input.mode,
            browserGeneration: generation,
            revision: 0,
            metadataVersion: 1,
            status: 'opening',
            bootId,
            createdAt: stamp,
            updatedAt: stamp,
          })
          .run();
        return Object.freeze({ browserId, browserGeneration: generation, revision: 0 });
      });
    },
    listInstances(scope: BrowserOwnerScope | null) {
      return transact(scope, (ownerId) =>
        Object.freeze(
          db
            .select()
            .from(browserInstances)
            .where(eq(browserInstances.ownerAuthorId, ownerId))
            .all()
            .map(instanceProjection)
        )
      );
    },
    attach(
      scope: BrowserOwnerScope | null,
      input: {
        attachmentId: string;
        browserId: string;
        browserGeneration: number;
        expectedInstanceRevision: number;
        attachment: BrowserAttachment;
      }
    ) {
      const attachmentId = ref(input.attachmentId),
        browserId = ref(input.browserId);
      const generation = counter(input.browserGeneration),
        revision = counter(input.expectedInstanceRevision);
      const target = BrowserAttachmentSchema.parse(input.attachment);
      return transact(scope, (ownerId) => {
        const instance = db
          .select()
          .from(browserInstances)
          .where(
            and(
              eq(browserInstances.browserId, browserId),
              eq(browserInstances.ownerAuthorId, ownerId),
              eq(browserInstances.browserGeneration, generation),
              eq(browserInstances.revision, revision)
            )
          )
          .get();
        if (
          !instance ||
          !['opening', 'running'].includes(instance.status) ||
          !incrementable(revision)
        )
          return conflict();
        const changed = db
          .update(browserInstances)
          .set({ revision: revision + 1, updatedAt: now() })
          .where(
            and(
              eq(browserInstances.browserId, browserId),
              eq(browserInstances.ownerAuthorId, ownerId),
              eq(browserInstances.browserGeneration, generation),
              eq(browserInstances.revision, revision)
            )
          )
          .run();
        if (changed.changes !== 1) return conflict();
        db.insert(browserAttachments)
          .values({
            attachmentId,
            ownerAuthorId: ownerId,
            browserId,
            browserGeneration: generation,
            revision: 0,
            kind: target.kind,
            sessionId: target.kind === 'session' ? target.sessionId : null,
            roomId: target.kind === 'room' ? target.roomId : null,
            attachedAt: now(),
            detachedAt: null,
          })
          .run();
        return Object.freeze({ attachmentId, revision: 0, attachment: Object.freeze(target) });
      });
    },
    detach(
      scope: BrowserOwnerScope | null,
      input: { attachmentId: string; expectedRevision: number }
    ) {
      const attachmentId = ref(input.attachmentId),
        revision = counter(input.expectedRevision);
      if (!incrementable(revision)) return conflict();
      return transact(scope, (ownerId) => {
        const rows = db
          .update(browserAttachments)
          .set({ detachedAt: now(), revision: revision + 1 })
          .where(
            and(
              eq(browserAttachments.attachmentId, attachmentId),
              eq(browserAttachments.ownerAuthorId, ownerId),
              eq(browserAttachments.revision, revision),
              isNull(browserAttachments.detachedAt)
            )
          )
          .returning({
            attachmentId: browserAttachments.attachmentId,
            revision: browserAttachments.revision,
          })
          .all();
        if (rows.length !== 1) return conflict();
        return Object.freeze(rows[0]!);
      });
    },
  });
}
