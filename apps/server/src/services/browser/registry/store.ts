import { randomBytes } from 'node:crypto';
import {
  and,
  eq,
  isNull,
  sql,
  browserProfiles,
  browserInstances,
  browserAttachments,
  type Db,
  type BrowserInstanceRow,
} from '@dorkos/db';
import {
  BrowserProfileSchema,
  BrowserInstanceSchema,
  BrowserAttachmentSchema,
  type BrowserProfile,
  type BrowserInstance,
  type BrowserAttachment,
} from '@dorkos/shared/browser-schemas';
import { BrowserRegistryError } from './errors.js';

/** Acquisition metadata never carries a native profile path or content. */
export type RegistryMode =
  Readonly<{ mode: 'persistent'; profileId: string }> | Readonly<{ mode: 'ephemeral' }>;

/** Owner-qualified durable metadata. All lifecycle writes are transactional. */
export class BrowserRegistryStore {
  /** Original database connection and immutable server boot identity. */
  constructor(
    private readonly db: Db,
    readonly bootId: string
  ) {}

  /** Create named metadata only; no native storage is created or copied. */
  createProfile(owner: string, label: string): BrowserProfile {
    const value = BrowserProfileSchema.parse({
      profileId: randomBytes(16).toString('base64url'),
      label,
      revision: 0,
      status: 'available',
    });
    const at = new Date().toISOString();
    this.db
      .insert(browserProfiles)
      .values({
        ...value,
        ownerAuthorId: owner,
        mode: 'persistent',
        metadataVersion: 1,
        createdAt: at,
        updatedAt: at,
      })
      .run();
    return value;
  }

  /** Return only this owner's nonsecret named metadata. */
  profiles(owner: string): BrowserProfile[] {
    return this.db
      .select()
      .from(browserProfiles)
      .where(eq(browserProfiles.ownerAuthorId, owner))
      .all()
      .map((row) =>
        BrowserProfileSchema.parse({
          profileId: row.profileId,
          label: row.label,
          revision: row.revision,
          status: row.status,
        })
      );
  }

  /** Read one exact owner/generation identity; missing and foreign references are indistinguishable. */
  instance(owner: string, browserId: string, generation: number): BrowserInstanceRow {
    const row = this.db
      .select()
      .from(browserInstances)
      .where(
        and(
          eq(browserInstances.ownerAuthorId, owner),
          eq(browserInstances.browserId, browserId),
          eq(browserInstances.browserGeneration, generation)
        )
      )
      .get();
    if (!row) throw new BrowserRegistryError('inaccessible');
    return row;
  }

  /** Internal metadata inventory, never a liveness observation. */
  rows(): BrowserInstanceRow[] {
    return this.db.select().from(browserInstances).all();
  }

  /** Install an opening identity before native birth; never replace an old ID. */
  birth(owner: string, mode: RegistryMode, browserId: string, generation: number): void {
    const value = BrowserInstanceSchema.parse({
      browserId,
      browserGeneration: generation,
      ...mode,
      status: 'opening',
    });
    this.db.transaction((tx) => {
      if (tx.select().from(browserInstances).where(eq(browserInstances.browserId, browserId)).get())
        throw new BrowserRegistryError('staleBinding');
      if (mode.mode === 'persistent') {
        const profile = tx
          .select()
          .from(browserProfiles)
          .where(
            and(
              eq(browserProfiles.ownerAuthorId, owner),
              eq(browserProfiles.profileId, mode.profileId)
            )
          )
          .get();
        if (!profile) throw new BrowserRegistryError('inaccessible');
        if (profile.status === 'quarantined') throw new BrowserRegistryError('profileUncertain');
        if (profile.status !== 'available') throw new BrowserRegistryError('profileInUse');
        tx.update(browserProfiles)
          .set({
            status: 'inUse',
            revision: profile.revision + 1,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(browserProfiles.profileId, profile.profileId))
          .run();
      }
      const at = new Date().toISOString();
      tx.insert(browserInstances)
        .values({
          ...value,
          profileId: mode.mode === 'persistent' ? mode.profileId : null,
          ownerAuthorId: owner,
          revision: 0,
          metadataVersion: 1,
          bootId: this.bootId,
          createdAt: at,
          updatedAt: at,
        })
        .run();
    });
  }

  /** Persist an observed transition without releasing a profile on uncertainty. */
  transition(row: BrowserInstanceRow, status: BrowserInstanceRow['status']): void {
    this.db.transaction((tx) => {
      const current = this.instance(row.ownerAuthorId, row.browserId, row.browserGeneration);
      if (current.status === 'stopped' && status !== 'stopped')
        throw new BrowserRegistryError('staleBinding');
      if (current.status === status) return;
      const at = new Date().toISOString();
      tx.update(browserInstances)
        .set({ status, revision: current.revision + 1, updatedAt: at })
        .where(
          and(
            eq(browserInstances.browserId, current.browserId),
            eq(browserInstances.ownerAuthorId, current.ownerAuthorId),
            eq(browserInstances.browserGeneration, current.browserGeneration)
          )
        )
        .run();
      if (current.profileId) {
        const profile = tx
          .select()
          .from(browserProfiles)
          .where(
            and(
              eq(browserProfiles.profileId, current.profileId),
              eq(browserProfiles.ownerAuthorId, current.ownerAuthorId)
            )
          )
          .get();
        if (!profile) throw new BrowserRegistryError('inaccessible');
        tx.update(browserProfiles)
          .set({
            status:
              status === 'stopped' ? 'available' : status === 'uncertain' ? 'quarantined' : 'inUse',
            revision: profile.revision + 1,
            updatedAt: at,
          })
          .where(eq(browserProfiles.profileId, profile.profileId))
          .run();
      }
      if (status === 'stopped' || status === 'uncertain')
        tx.update(browserAttachments)
          .set({ detachedAt: at, revision: sql`${browserAttachments.revision} + 1` })
          .where(
            and(
              eq(browserAttachments.browserId, current.browserId),
              eq(browserAttachments.browserGeneration, current.browserGeneration),
              isNull(browserAttachments.detachedAt)
            )
          )
          .run();
    });
  }

  /** Project an owner-qualified identity; callers must refresh from the original engine first. */
  project(row: BrowserInstanceRow): BrowserInstance {
    return BrowserInstanceSchema.parse({
      browserId: row.browserId,
      browserGeneration: row.browserGeneration,
      mode: row.mode,
      ...(row.mode === 'persistent' ? { profileId: row.profileId } : {}),
      status: row.status,
    });
  }

  /** Associate an already authorized session/room; this row conveys no browser grant. */
  attach(row: BrowserInstanceRow, target: BrowserAttachment): string {
    const value = BrowserAttachmentSchema.parse(target);
    const id = randomBytes(16).toString('base64url');
    this.db
      .insert(browserAttachments)
      .values({
        attachmentId: id,
        ownerAuthorId: row.ownerAuthorId,
        browserId: row.browserId,
        browserGeneration: row.browserGeneration,
        revision: 0,
        kind: value.kind,
        sessionId: value.kind === 'session' ? value.sessionId : null,
        roomId: value.kind === 'room' ? value.roomId : null,
        attachedAt: new Date().toISOString(),
        detachedAt: null,
      })
      .run();
    return id;
  }

  /** Detach only this owner's association; never alter engine or profile lifecycle. */
  detach(owner: string, id: string): void {
    const row = this.db
      .select()
      .from(browserAttachments)
      .where(
        and(eq(browserAttachments.ownerAuthorId, owner), eq(browserAttachments.attachmentId, id))
      )
      .get();
    if (!row) throw new BrowserRegistryError('inaccessible');
    if (row.detachedAt !== null) return;
    this.db
      .update(browserAttachments)
      .set({ detachedAt: new Date().toISOString(), revision: row.revision + 1 })
      .where(
        and(eq(browserAttachments.attachmentId, id), eq(browserAttachments.ownerAuthorId, owner))
      )
      .run();
  }
}
