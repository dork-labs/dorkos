/**
 * Moderation tables: a space's bans, reports and slow-mode clocks, and the host's takedowns
 * with their held evidence. They reference the core tables in `../schema.ts`. Mute, rules and
 * slow-mode columns live on their parent tables there (0034).
 *
 * @module moderation/schema
 */
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { channels, communities, entries, hostApiKeys, members, users } from '../schema.js';

const time = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();

/**
 * A ban: refuses every way back into one community for an account and for its email (0033).
 * `email_hash` is keyed with the auth secret (`moderation/bans.ts`); a ban is lifted, never
 * deleted, so the moderators' record stays.
 */
export const bans = pgTable(
  'bans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
    memberId: uuid('member_id'),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    emailHash: text('email_hash'),
    reason: text('reason'),
    actorMemberId: uuid('actor_member_id'),
    liftedByMemberId: uuid('lifted_by_member_id'),
    /** `imported` for a ban an import restored from an owner export. */
    origin: text('origin').notNull().default('native'),
    createdAt: time('created_at'),
    liftedAt: timestamp('lifted_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'bans_email_hash_check',
      sql`${table.emailHash} IS NULL OR ${table.emailHash} ~ '^[a-f0-9]{64}$'`
    ),
    check(
      'bans_reason_check',
      sql`${table.reason} IS NULL OR char_length(${table.reason}) BETWEEN 1 AND 500`
    ),
    check('bans_origin_check', sql`${table.origin} IN ('native','imported')`),
    check(
      'bans_lifted_shape',
      sql`${table.liftedByMemberId} IS NULL OR ${table.liftedAt} IS NOT NULL`
    ),
    uniqueIndex('bans_community_id_unique').on(table.communityId, table.id),
    uniqueIndex('bans_standing_member_unique')
      .on(table.communityId, table.memberId)
      .where(sql`${table.liftedAt} IS NULL AND ${table.memberId} IS NOT NULL`),
    index('bans_community_user_idx').on(table.communityId, table.userId),
    index('bans_community_email_idx').on(table.communityId, table.emailHash),
    index('bans_user_idx')
      .on(table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    index('bans_member_idx')
      .on(table.memberId)
      .where(sql`${table.memberId} IS NOT NULL`),
    index('bans_actor_idx')
      .on(table.actorMemberId)
      .where(sql`${table.actorMemberId} IS NOT NULL`),
    index('bans_lifted_by_idx')
      .on(table.liftedByMemberId)
      .where(sql`${table.liftedByMemberId} IS NOT NULL`),
    foreignKey({
      name: 'bans_member_tenant_fk',
      columns: [table.communityId, table.memberId],
      foreignColumns: [members.communityId, members.id],
    }),
    foreignKey({
      name: 'bans_actor_tenant_fk',
      columns: [table.communityId, table.actorMemberId],
      foreignColumns: [members.communityId, members.id],
    }),
    foreignKey({
      name: 'bans_lifted_by_tenant_fk',
      columns: [table.communityId, table.liftedByMemberId],
      foreignColumns: [members.communityId, members.id],
    }),
  ]
);

/**
 * One host takedown: ids, reasons, and states only (0020). No foreign key to communities, so the
 * record outlives a deleted community.
 */
export const communityTakedowns = pgTable(
  'community_takedowns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    communityId: uuid('community_id').notNull(),
    targetKind: text('target_kind').notNull(),
    entryId: uuid('entry_id'),
    attachmentId: uuid('attachment_id'),
    channelId: uuid('channel_id'),
    /** The member the content counts as: its author, or its author agent's owner. */
    subjectMemberId: uuid('subject_member_id'),
    category: text('category').notNull(),
    reference: text('reference'),
    notify: boolean('notify').notNull(),
    actorKind: text('actor_kind').notNull(),
    actorUserId: text('actor_user_id').references(() => users.id),
    actorApiKeyId: uuid('actor_api_key_id').references(() => hostApiKeys.id),
    idempotencyKey: text('idempotency_key').notNull(),
    payloadHash: text('payload_hash').notNull(),
    state: text('state').notNull().default('active'),
    evidenceState: text('evidence_state').notNull(),
    evidenceLocation: text('evidence_location'),
    evidenceRecordSha256: text('evidence_record_sha256'),
    evidenceAttempts: integer('evidence_attempts').notNull().default(0),
    evidenceFailures: integer('evidence_failures').notNull().default(0),
    evidenceAlertedAt: timestamp('evidence_alerted_at', { withTimezone: true }),
    priorState: jsonb('prior_state'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    lastErrorClass: text('last_error_class'),
    createdAt: time('created_at'),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    releasedByKind: text('released_by_kind'),
    releasedByUserId: text('released_by_user_id').references(() => users.id),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    /** A community takedown's evidence export, while it has one (0025). */
    evidenceExportId: uuid('evidence_export_id'),
    /** A community takedown: when its reversal window ends and the deletion is due (0025). */
    deleteAfter: timestamp('delete_after', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('community_takedowns_idempotency').on(
      table.actorKind,
      sql`COALESCE(${table.actorUserId}, ${table.actorApiKeyId}::text)`,
      table.idempotencyKey
    ),
    index('community_takedowns_created_idx').on(table.createdAt.desc(), table.id.desc()),
    index('community_takedowns_community_idx').on(
      table.communityId,
      table.createdAt.desc(),
      table.id.desc()
    ),
    index('community_takedowns_due_idx')
      .on(table.nextAttemptAt)
      .where(sql`${table.evidenceState} IN ('pending','retrying')`),
    index('community_takedowns_unsettled_idx')
      .on(table.communityId)
      .where(sql`${table.evidenceState} IN ('pending','retrying','failed','held_on_primary')`),
    index('community_takedowns_actor_community_idx')
      .on(
        table.actorKind,
        sql`COALESCE(${table.actorUserId}, ${table.actorApiKeyId}::text)`,
        table.createdAt
      )
      .where(sql`${table.targetKind} = 'community'`),
    check(
      'community_takedowns_target_kind_check',
      sql`${table.targetKind} IN ('entry','attachment','icon','community')`
    ),
    check(
      'community_takedowns_category_check',
      sql`${table.category} IN ('child_safety','illegal_content','legal_order','terms_violation')`
    ),
    check(
      'community_takedowns_reference_check',
      sql`${table.reference} ~ '^[A-Za-z0-9._:-]{1,64}$'`
    ),
    check('community_takedowns_actor_kind_check', sql`${table.actorKind} IN ('person','api_key')`),
    check(
      'community_takedowns_idempotency_key_check',
      sql`char_length(${table.idempotencyKey}) BETWEEN 1 AND 200`
    ),
    check('community_takedowns_payload_hash_check', sql`${table.payloadHash} ~ '^[a-f0-9]{64}$'`),
    check('community_takedowns_state_check', sql`${table.state} IN ('active','reversed')`),
    check(
      'community_takedowns_evidence_state_check',
      sql`${table.evidenceState} IN ('pending','retrying','stored','failed','not_configured','nothing_to_preserve','held_on_primary')`
    ),
    check(
      'community_takedowns_evidence_record_sha256_check',
      sql`${table.evidenceRecordSha256} ~ '^[a-f0-9]{64}$'`
    ),
    check('community_takedowns_evidence_attempts_check', sql`${table.evidenceAttempts} >= 0`),
    check('community_takedowns_evidence_failures_check', sql`${table.evidenceFailures} >= 0`),
    check(
      'community_takedowns_last_error_class_check',
      sql`${table.lastErrorClass} ~ '^[A-Z][A-Z0-9_]{0,63}$'`
    ),
    check(
      'community_takedowns_target',
      sql`(${table.targetKind} = 'entry' AND ${table.entryId} IS NOT NULL AND ${table.attachmentId} IS NULL) OR (${table.targetKind} = 'attachment' AND ${table.attachmentId} IS NOT NULL) OR (${table.targetKind} IN ('icon','community') AND ${table.entryId} IS NULL AND ${table.attachmentId} IS NULL)`
    ),
    check(
      'community_takedowns_actor',
      sql`(${table.actorKind} = 'person') = (${table.actorUserId} IS NOT NULL) AND (${table.actorKind} = 'api_key') = (${table.actorApiKeyId} IS NOT NULL)`
    ),
    check(
      'community_takedowns_reversal',
      sql`(${table.state} = 'reversed') = (${table.reversedAt} IS NOT NULL)`
    ),
    check(
      'community_takedowns_evidence_stored',
      sql`(${table.evidenceState} = 'stored') = (${table.evidenceRecordSha256} IS NOT NULL) AND (${table.evidenceState} = 'stored') = (${table.evidenceLocation} IS NOT NULL)`
    ),
    check(
      'community_takedowns_released_by_kind_check',
      sql`${table.releasedByKind} IN ('person','offline')`
    ),
    check(
      'community_takedowns_release',
      sql`(${table.releasedAt} IS NULL) = (${table.releasedByKind} IS NULL) AND (${table.releasedByKind} = 'person') = (${table.releasedByUserId} IS NOT NULL)`
    ),
    check(
      'community_takedowns_evidence_due',
      sql`${table.evidenceState} NOT IN ('pending','retrying') OR ${table.nextAttemptAt} IS NOT NULL`
    ),
    check(
      'community_takedowns_evidence_export',
      sql`${table.evidenceExportId} IS NULL OR ${table.targetKind} = 'community'`
    ),
    check(
      'community_takedowns_delete_after',
      sql`(${table.targetKind} = 'community') = (${table.deleteAfter} IS NOT NULL)`
    ),
  ]
);

/**
 * A takedown's evidence record and held blobs, as they were at the takedown, until the copy
 * lands in the evidence store or a host operator releases them (0020).
 */
export const takedownEvidenceStaging = pgTable('takedown_evidence_staging', {
  takedownId: uuid('takedown_id')
    .primaryKey()
    .references(() => communityTakedowns.id, { onDelete: 'cascade' }),
  record: jsonb('record').notNull(),
  blobKeys: text('blob_keys').array().notNull(),
});

/** When each person last posted in a slow-mode channel (0034); rate state, never exported. */
export const channelPostClocks = pgTable(
  'channel_post_clocks',
  {
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
    channelId: uuid('channel_id').notNull(),
    memberId: uuid('member_id').notNull(),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.channelId, table.memberId] }),
    index('channel_post_clocks_community_idx').on(table.communityId),
    index('channel_post_clocks_member_idx').on(table.memberId),
    foreignKey({
      name: 'channel_post_clocks_channel_tenant_fk',
      columns: [table.communityId, table.channelId],
      foreignColumns: [channels.communityId, channels.id],
    }),
    foreignKey({
      name: 'channel_post_clocks_member_tenant_fk',
      columns: [table.communityId, table.memberId],
      foreignColumns: [members.communityId, members.id],
    }),
  ]
);

/**
 * Reports of messages (0034): from a member (`source='member'`, once per message) or from an
 * automated watch-only check (`source='check'`, named in `check_name`). One queue for both.
 */
export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
    entryId: uuid('entry_id').notNull(),
    source: text('source').notNull().default('member'),
    reporterMemberId: uuid('reporter_member_id'),
    checkName: text('check_name'),
    reason: text('reason').notNull(),
    note: text('note'),
    status: text('status').notNull().default('open'),
    action: text('action'),
    resolverMemberId: uuid('resolver_member_id'),
    /** `imported` for a report an import restored from an owner export. */
    origin: text('origin').notNull().default('native'),
    createdAt: time('created_at'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    check('reports_source_check', sql`${table.source} IN ('member','check')`),
    check(
      'reports_check_name_check',
      sql`${table.checkName} IS NULL OR ${table.checkName} ~ '^[a-z][a-z0-9_.-]{0,63}$'`
    ),
    check(
      'reports_reason_check',
      sql`${table.reason} IN ('spam','harassment','off_topic','illegal','other')`
    ),
    check(
      'reports_note_check',
      sql`${table.note} IS NULL OR char_length(${table.note}) BETWEEN 1 AND 1000`
    ),
    check('reports_status_check', sql`${table.status} IN ('open','actioned','dismissed')`),
    check(
      'reports_action_check',
      sql`${table.action} IS NULL OR ${table.action} IN ('remove','mute','ban')`
    ),
    check('reports_origin_check', sql`${table.origin} IN ('native','imported')`),
    check(
      'reports_source_shape',
      sql`(${table.source} = 'member' AND ${table.checkName} IS NULL) OR (${table.source} = 'check' AND ${table.reporterMemberId} IS NULL AND ${table.checkName} IS NOT NULL)`
    ),
    check(
      'reports_status_shape',
      sql`(${table.status} = 'open' AND ${table.resolvedAt} IS NULL AND ${table.action} IS NULL AND ${table.resolverMemberId} IS NULL) OR (${table.status} = 'actioned' AND ${table.resolvedAt} IS NOT NULL AND ${table.action} IS NOT NULL) OR (${table.status} = 'dismissed' AND ${table.resolvedAt} IS NOT NULL AND ${table.action} IS NULL)`
    ),
    uniqueIndex('reports_community_id_unique').on(table.communityId, table.id),
    uniqueIndex('reports_member_once')
      .on(table.entryId, table.reporterMemberId)
      .where(sql`${table.source} = 'member' AND ${table.reporterMemberId} IS NOT NULL`),
    uniqueIndex('reports_check_once')
      .on(table.entryId, table.checkName)
      .where(sql`${table.source} = 'check'`),
    index('reports_queue_idx').on(table.communityId, table.status, table.createdAt),
    index('reports_entry_idx').on(table.entryId),
    index('reports_reporter_idx')
      .on(table.reporterMemberId)
      .where(sql`${table.reporterMemberId} IS NOT NULL`),
    index('reports_resolver_idx')
      .on(table.resolverMemberId)
      .where(sql`${table.resolverMemberId} IS NOT NULL`),
    foreignKey({
      name: 'reports_entry_tenant_fk',
      columns: [table.communityId, table.entryId],
      foreignColumns: [entries.communityId, entries.id],
    }),
    foreignKey({
      name: 'reports_reporter_tenant_fk',
      columns: [table.communityId, table.reporterMemberId],
      foreignColumns: [members.communityId, members.id],
    }),
    foreignKey({
      name: 'reports_resolver_tenant_fk',
      columns: [table.communityId, table.resolverMemberId],
      foreignColumns: [members.communityId, members.id],
    }),
  ]
);
