import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { communities, members, time } from '../schema.js';

/**
 * Security-relevant membership and channel actions, and the `decision.*` rows of the watch-only
 * spam and rule checks (0036), whose record lives in `decision`.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
    actorMemberId: uuid('actor_member_id'),
    action: text('action').notNull(),
    subjectId: text('subject_id'),
    actorKind: text('actor_kind').notNull().default('member'),
    priorState: text('prior_state'),
    nextState: text('next_state'),
    changedFields: text('changed_fields').array().notNull().default([]),
    /** A host takedown the host chose not to tell the owner about; owner exports leave it out. */
    withheld: boolean('withheld').notNull().default(false),
    createdAt: time('created_at'),
    /** `imported` for an event an import restored from an owner export. */
    origin: text('origin').notNull().default('native'),
    /** One rung of a watch-only check (`CommunityDecisionRecordSchema`); `decision.*` rows only. */
    decision: jsonb('decision'),
    /** `administer` when the person's paired app wrote it (0047); NULL for their browser. */
    via: text('via').default(sql`nullif(current_setting('dorkos.audit_via', true), '')`),
  },
  (table) => [
    check('audit_events_origin', sql`${table.origin} IN ('native','imported')`),
    index('audit_events_community_created_idx').on(table.communityId, table.createdAt),
    index('audit_events_actor_idx')
      .on(table.actorMemberId)
      .where(sql`${table.actorMemberId} IS NOT NULL`),
    foreignKey({
      name: 'audit_events_actor_tenant_fk',
      columns: [table.communityId, table.actorMemberId],
      foreignColumns: [members.communityId, members.id],
    }),
    check('audit_events_actor_kind', sql`${table.actorKind} IN ('member','system','host')`),
    check('audit_events_changed_fields', sql`cardinality(${table.changedFields}) <= 16`),
    check('audit_events_via', sql`${table.via} IS NULL OR ${table.via} = 'administer'`),
    check(
      'audit_events_decision_shape',
      sql`${table.decision} IS NULL OR (${table.action} LIKE 'decision.%' AND jsonb_typeof(${table.decision}) = 'object' AND octet_length(${table.decision}::text) <= 4096)`
    ),
    // The rung-0 row is the claim: one check per message on this host.
    uniqueIndex('audit_events_decision_claim')
      .on(table.communityId, table.subjectId)
      .where(sql`${table.action} = 'decision.rung0' AND ${table.origin} = 'native'`),
    index('audit_events_decision_subject_idx')
      .on(table.communityId, table.subjectId)
      .where(sql`${table.action} LIKE 'decision.%'`),
    index('audit_events_decision_created_idx')
      .on(table.createdAt)
      .where(sql`${table.action} LIKE 'decision.%'`),
  ]
);
