import { sql } from 'drizzle-orm';
import { sqliteTable, text, check, primaryKey, index } from 'drizzle-orm/sqlite-core';

/**
 * How the server came to know a project (spec `flow-multiproject` §6.1).
 *
 * `seen`: a session, agent, workspace or install folder was in it. `reported`:
 * only an extension (or a person's one-off lookup) named it. A reported root is
 * second-class: it never widens where core looks for extension code, and it is
 * not in the person's project list until it is seen.
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

/**
 * How an extension named a project: `report` (`ctx.projects.report`, which puts
 * it in the extension's own list) or `resolve` (`ctx.projects.resolve`, which
 * does not). A later `report` upgrades a `resolve` row.
 */
export const KNOWN_PROJECT_REPORT_KINDS = ['report', 'resolve'] as const;

/** How an extension named a project. See {@link KNOWN_PROJECT_REPORT_KINDS}. */
export type KnownProjectReportKind = (typeof KNOWN_PROJECT_REPORT_KINDS)[number];

/**
 * Every extension that named a known project (spec `flow-multiproject` §6.1).
 *
 * One row per (project, extension), so a restart keeps each extension's scoped
 * list, and the per-extension cap on named roots is a count here. Rows go with
 * their project.
 */
export const knownProjectReporters = sqliteTable(
  'known_project_reporters',
  {
    /** The project's root (`known_projects.root`). */
    root: text('root')
      .notNull()
      .references(() => knownProjects.root, { onDelete: 'cascade' }),
    /** The extension that named it. */
    extensionId: text('extension_id').notNull(),
    /** `report` or `resolve`. */
    kind: text('kind').$type<KnownProjectReportKind>().notNull(),
    /** ISO-8601 time it first named it. */
    reportedAt: text('reported_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.root, table.extensionId] }),
    index('known_project_reporters_extension_idx').on(table.extensionId),
    check(
      'known_project_reporters_kind',
      sql`${table.kind} IN (${sql.raw(KNOWN_PROJECT_REPORT_KINDS.map((k) => `'${k}'`).join(', '))})`
    ),
  ]
);

/** A stored `known_project_reporters` row. */
export type KnownProjectReporterRow = typeof knownProjectReporters.$inferSelect;
