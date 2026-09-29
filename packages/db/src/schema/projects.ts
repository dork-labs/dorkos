import { sql } from 'drizzle-orm';
import { sqliteTable, text, check } from 'drizzle-orm/sqlite-core';

/**
 * How the server came to know a project (spec `flow-multiproject` §6.1).
 *
 * `seen`: a session, agent, workspace or install folder was in it. `reported`:
 * only an extension said so, through `ctx.projects.report`. A reported root is
 * second-class: it never widens where core looks for extension code.
 */
export const KNOWN_PROJECT_SOURCES = ['seen', 'reported'] as const;

/** How the server came to know a project. See {@link KNOWN_PROJECT_SOURCES}. */
export type KnownProjectSource = (typeof KNOWN_PROJECT_SOURCES)[number];

/**
 * Every project (git main checkout) the server has seen, with the short name
 * it gave it (spec `flow-multiproject` §6.1, N4).
 *
 * Named `known_projects` because "project" already means several things here:
 * a mesh agent's `projectPath`, a workspace's `projectKey`, and project rooms.
 *
 * **`name` is stable.** It is assigned once, when the root is first recorded,
 * and never rewritten, so a bookmark such as `/x/flow/p/dorkos` keeps meaning
 * the same project. The `UNIQUE` constraint is what keeps two projects from
 * ever sharing one; the service picks `name~parent` for a newcomer on a clash.
 *
 * A root whose folder no longer exists is hidden from lists and kept, since a
 * drive may only be unplugged.
 */
export const knownProjects = sqliteTable(
  'known_projects',
  {
    /** Absolute, canonical path of the main checkout. */
    root: text('root').primaryKey(),
    /** URL-safe short name, unique, never changed once assigned. */
    name: text('name').notNull().unique(),
    /** `owner/name` from the `origin` remote, or null. */
    originRepo: text('origin_repo'),
    /** `seen` or `reported`; a reported root is upgraded to `seen` when seen. */
    source: text('source').$type<KnownProjectSource>().notNull(),
    /** The extension id that first reported the root, or null. */
    reportedBy: text('reported_by'),
    /** ISO-8601 time the root was first recorded. */
    firstSeenAt: text('first_seen_at').notNull(),
    /** ISO-8601 time the root was last seen or reported. */
    lastSeenAt: text('last_seen_at').notNull(),
  },
  (table) => [
    // `sql.raw` for the list: an interpolated value becomes a bind parameter,
    // and drizzle-kit writes the marker into the migration, where `IN (?, ?)`
    // is a syntax error (the same reason `read_cursors` gives).
    check(
      'known_projects_source',
      sql`${table.source} IN (${sql.raw(KNOWN_PROJECT_SOURCES.map((s) => `'${s}'`).join(', '))})`
    ),
  ]
);

/** A stored `known_projects` row. */
export type KnownProjectRow = typeof knownProjects.$inferSelect;
