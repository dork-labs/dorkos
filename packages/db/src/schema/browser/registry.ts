import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { authors, rooms } from '../rooms.js';

/** Durable metadata only; no native profile, Page, credential or grant is stored. */
export const browserProfiles = sqliteTable(
  'browser_profiles',
  {
    profileId: text('profile_id').primaryKey(),
    ownerAuthorId: text('owner_author_id')
      .notNull()
      .references(() => authors.id, { onDelete: 'restrict' }),
    label: text('label').notNull(),
    mode: text('mode', { enum: ['persistent'] }).notNull(),
    metadataVersion: integer('metadata_version').notNull(),
    revision: integer('revision').notNull(),
    status: text('status', { enum: ['available', 'inUse', 'quarantined'] }).notNull(),
    /** Initialization failure is durable and independent of ordinary native quarantine. */
    importState: text('import_state', { enum: ['none', 'pending', 'failed', 'ready'] })
      .notNull()
      .default('none'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('browser_profiles_owner_identity').on(t.profileId, t.ownerAuthorId),
    index('browser_profiles_owner').on(t.ownerAuthorId),
    check('browser_profiles_mode', sql`${t.mode} = 'persistent'`),
    check('browser_profiles_version', sql`${t.metadataVersion} = 1`),
    check(
      'browser_profiles_revision',
      sql`typeof(${t.revision}) = 'integer' AND ${t.revision} BETWEEN 0 AND 9007199254740991`
    ),
    check(
      'browser_profiles_import_state',
      sql`${t.importState} IN ('none', 'pending', 'failed', 'ready')`
    ),
    check('browser_profiles_status', sql`${t.status} IN ('available', 'inUse', 'quarantined')`),
  ]
);

/** Old browser identities are retained and never rebound to a new engine. */
export const browserInstances = sqliteTable(
  'browser_instances',
  {
    browserId: text('browser_id').primaryKey(),
    ownerAuthorId: text('owner_author_id')
      .notNull()
      .references(() => authors.id, { onDelete: 'restrict' }),
    profileId: text('profile_id'),
    mode: text('mode', { enum: ['persistent', 'ephemeral'] }).notNull(),
    browserGeneration: integer('browser_generation').notNull(),
    revision: integer('revision').notNull(),
    metadataVersion: integer('metadata_version').notNull(),
    status: text('status', {
      enum: ['opening', 'running', 'stopping', 'stopped', 'uncertain'],
    }).notNull(),
    bootId: text('boot_id').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('browser_instances_owner_identity').on(t.browserId, t.ownerAuthorId),
    uniqueIndex('browser_instances_generation_identity').on(
      t.browserId,
      t.ownerAuthorId,
      t.browserGeneration
    ),
    index('browser_instances_owner').on(t.ownerAuthorId),
    foreignKey({
      columns: [t.profileId, t.ownerAuthorId],
      foreignColumns: [browserProfiles.profileId, browserProfiles.ownerAuthorId],
    }).onDelete('restrict'),
    uniqueIndex('browser_instances_reserved_profile')
      .on(t.profileId)
      .where(sql`${t.status} IN ('opening', 'running', 'stopping', 'uncertain')`),
    check(
      'browser_instances_mode_profile',
      sql`(${t.mode} = 'persistent' AND ${t.profileId} IS NOT NULL) OR (${t.mode} = 'ephemeral' AND ${t.profileId} IS NULL)`
    ),
    check(
      'browser_instances_generation',
      sql`typeof(${t.browserGeneration}) = 'integer' AND ${t.browserGeneration} BETWEEN 0 AND 9007199254740991`
    ),
    check(
      'browser_instances_revision',
      sql`typeof(${t.revision}) = 'integer' AND ${t.revision} BETWEEN 0 AND 9007199254740991`
    ),
    check('browser_instances_version', sql`${t.metadataVersion} = 1`),
    check(
      'browser_instances_status',
      sql`${t.status} IN ('opening', 'running', 'stopping', 'stopped', 'uncertain')`
    ),
  ]
);

/** References are associations, never browser access or engine-stop instructions. */
export const browserAttachments = sqliteTable(
  'browser_attachments',
  {
    attachmentId: text('attachment_id').primaryKey(),
    ownerAuthorId: text('owner_author_id')
      .notNull()
      .references(() => authors.id, { onDelete: 'restrict' }),
    browserId: text('browser_id').notNull(),
    browserGeneration: integer('browser_generation').notNull(),
    revision: integer('revision').notNull(),
    kind: text('kind', { enum: ['session', 'room'] }).notNull(),
    sessionId: text('session_id'),
    roomId: text('room_id').references(() => rooms.id, { onDelete: 'cascade' }),
    attachedAt: text('attached_at').notNull(),
    detachedAt: text('detached_at'),
  },
  (t) => [
    foreignKey({
      columns: [t.browserId, t.ownerAuthorId, t.browserGeneration],
      foreignColumns: [
        browserInstances.browserId,
        browserInstances.ownerAuthorId,
        browserInstances.browserGeneration,
      ],
    }).onDelete('restrict'),
    uniqueIndex('browser_attachments_session')
      .on(t.browserId, t.browserGeneration, t.sessionId)
      .where(sql`${t.detachedAt} IS NULL AND ${t.kind} = 'session'`),
    uniqueIndex('browser_attachments_room')
      .on(t.browserId, t.browserGeneration, t.roomId)
      .where(sql`${t.detachedAt} IS NULL AND ${t.kind} = 'room'`),
    check(
      'browser_attachments_target',
      sql`(${t.kind} = 'session' AND ${t.sessionId} IS NOT NULL AND ${t.roomId} IS NULL) OR (${t.kind} = 'room' AND ${t.roomId} IS NOT NULL AND ${t.sessionId} IS NULL)`
    ),
    check(
      'browser_attachments_generation',
      sql`typeof(${t.browserGeneration}) = 'integer' AND ${t.browserGeneration} BETWEEN 0 AND 9007199254740991`
    ),
    check(
      'browser_attachments_revision',
      sql`typeof(${t.revision}) = 'integer' AND ${t.revision} BETWEEN 0 AND 9007199254740991`
    ),
  ]
);

export type BrowserProfileRow = typeof browserProfiles.$inferSelect;
export type BrowserInstanceRow = typeof browserInstances.$inferSelect;
export type BrowserAttachmentRow = typeof browserAttachments.$inferSelect;
