/** Project-scoped auth blueprints, separate from tenant authority and credential storage. */
import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/** One non-replayable default-config attempt per exact project/toolkit/policy. */
export const managedConnectorAuthConfigResolution = pgTable(
  'managed_connector_auth_config_resolution',
  {
    projectDigest: text('project_digest').notNull(),
    toolkit: text('toolkit').notNull(),
    policyDigest: text('policy_digest').notNull(),
    name: text('name').notNull(),
    attemptId: text('attempt_id').notNull(),
    authConfigId: text('auth_config_id'),
    state: text('state').notNull().$type<'provisioning' | 'ready' | 'create_unknown'>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.projectDigest, table.toolkit, table.policyDigest] })]
);
