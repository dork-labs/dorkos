import { sql } from 'drizzle-orm';
import { check, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sessionMetadata } from '../sessions.js';

/** Private association to the person source verified when an unbound draft was inserted. */
export const sessionDraftSources = sqliteTable(
  'session_draft_sources',
  {
    sessionId: text('session_id')
      .primaryKey()
      .notNull()
      .references(() => sessionMetadata.sessionId, { onDelete: 'cascade' }),
    ownerId: text('owner_id').notNull(),
    sourceKind: text('source_kind', { enum: ['person-location', 'person-agent'] }).notNull(),
    locationId: text('location_id'),
    registeredAgentId: text('registered_agent_id'),
    sourcePath: text('source_path').notNull(),
    sourceCreatedAt: text('source_created_at').notNull(),
  },
  (t) => [
    check(
      'session_draft_sources_shape',
      sql`length(${t.ownerId}) > 0 AND length(${t.sourcePath}) > 0 AND
        length(${t.sourceCreatedAt}) > 0 AND
        ((${t.sourceKind} = 'person-location' AND ${t.locationId} IS NOT NULL AND
          length(${t.locationId}) > 0 AND ${t.registeredAgentId} IS NULL) OR
         (${t.sourceKind} = 'person-agent' AND ${t.registeredAgentId} IS NOT NULL AND
          length(${t.registeredAgentId}) > 0 AND ${t.locationId} IS NULL))`
    ),
  ]
);
