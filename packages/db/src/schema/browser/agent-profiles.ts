import { index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** A named Agent browser profile. Its cookies live on disk, never here. */
export const agentBrowserProfiles = sqliteTable('agent_browser_profiles', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  createdAt: text('created_at').notNull(),
});

/**
 * Which agents a person let use a profile. A row alone proves nothing: agents
 * run as the same OS user as this database, so access needs a valid `signature`,
 * written by the server only after "Confirm it's you" passed.
 */
export const agentBrowserProfileAgents = sqliteTable(
  'agent_browser_profile_agents',
  {
    profileId: text('profile_id')
      .notNull()
      .references(() => agentBrowserProfiles.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    createdAt: text('created_at').notNull(),
    signature: text('signature').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.profileId, t.agentId] }),
    index('agent_browser_profile_agents_agent').on(t.agentId),
  ]
);
