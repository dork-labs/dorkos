import { bigint, check, foreignKey, integer, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { communities, members, time } from '../schema.js';

// The host's limits on a space and on one member of it (0012), beside `../schema.ts`.

/** Host-set caps for one community. A community without a row has no limit. */
export const communityLimits = pgTable(
  'community_limits',
  {
    communityId: uuid('community_id')
      .primaryKey()
      .references(() => communities.id),
    maxActiveMembers: integer('max_active_members'),
    maxStorageBytes: bigint('max_storage_bytes', { mode: 'number' }),
    limitsVersion: integer('limits_version').notNull().default(1),
    updatedAt: time('updated_at'),
  },
  (table) => [
    check(
      'community_limits_max_active_members_check',
      sql`${table.maxActiveMembers} BETWEEN 1 AND 1000000`
    ),
    check('community_limits_max_storage_bytes_check', sql`${table.maxStorageBytes} >= 0`),
    check('community_limits_limits_version_check', sql`${table.limitsVersion} > 0`),
  ]
);

/** Host-set agents-per-person override for one member of one community. */
export const memberLimitOverrides = pgTable(
  'member_limit_overrides',
  {
    communityId: uuid('community_id').notNull(),
    memberId: uuid('member_id').notNull(),
    agentsPerMember: integer('agents_per_member').notNull(),
    updatedAt: time('updated_at'),
  },
  (table) => [
    primaryKey({ columns: [table.communityId, table.memberId] }),
    foreignKey({
      name: 'member_limit_overrides_member_tenant_fk',
      columns: [table.communityId, table.memberId],
      foreignColumns: [members.communityId, members.id],
    }),
    check(
      'member_limit_overrides_agents_per_member_check',
      sql`${table.agentsPerMember} BETWEEN 1 AND 1000`
    ),
  ]
);
