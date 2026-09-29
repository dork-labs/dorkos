/**
 * The durable half of the project registry: one `known_projects` row per
 * project, and one `known_project_reporters` row per extension that named one
 * (spec `flow-multiproject` §6.1).
 *
 * Every method is synchronous (better-sqlite3). The registry holds the rows in
 * memory and writes through here, so a registry with no store (a unit test)
 * still works, it just forgets on restart. A write that throws is the
 * registry's to handle: it never keeps in memory what storage refused.
 *
 * @module services/projects/known-projects-store
 */
import {
  eq,
  knownProjectReporters,
  knownProjects,
  sql,
  type Db,
  type KnownProjectReporterRow,
  type KnownProjectRow,
} from '@dorkos/db';

/** A known project as the registry stores it. */
export type KnownProject = KnownProjectRow;

/** One extension that named a known project. */
export type KnownProjectReporter = KnownProjectReporterRow;

/** The reads and writes the registry makes. */
export interface KnownProjectsPort {
  /** Every stored project. */
  all(): KnownProject[];
  /** Every stored (project, extension) pair. */
  reporters(): KnownProjectReporter[];
  /**
   * Record a new project.
   *
   * @throws When the root or the name is already stored.
   */
  insert(project: KnownProject): void;
  /**
   * Change a stored project's mutable columns. `name` and `firstSeenAt` are
   * never changed after insert.
   */
  update(
    root: string,
    patch: Partial<Pick<KnownProject, 'originRepo' | 'source' | 'lastSeenAt'>>
  ): void;
  /**
   * Record that an extension named a project. A `report` upgrades an earlier
   * `resolve`; nothing downgrades.
   */
  addReporter(reporter: KnownProjectReporter): void;
}

/** {@link KnownProjectsPort} over the server's SQLite database. */
export class KnownProjectsStore implements KnownProjectsPort {
  /**
   * Build the store.
   *
   * @param db - The server's database handle.
   */
  constructor(private readonly db: Db) {}

  /** Every stored project. */
  all(): KnownProject[] {
    return this.db.select().from(knownProjects).all();
  }

  /** Every stored (project, extension) pair. */
  reporters(): KnownProjectReporter[] {
    return this.db.select().from(knownProjectReporters).all();
  }

  /**
   * Record a new project.
   *
   * @param project - The row to insert.
   */
  insert(project: KnownProject): void {
    this.db.insert(knownProjects).values(project).run();
  }

  /**
   * Change a stored project's mutable columns.
   *
   * @param root - The project's root.
   * @param patch - The columns to set.
   */
  update(
    root: string,
    patch: Partial<Pick<KnownProject, 'originRepo' | 'source' | 'lastSeenAt'>>
  ): void {
    if (Object.keys(patch).length === 0) return;
    this.db.update(knownProjects).set(patch).where(eq(knownProjects.root, root)).run();
  }

  /**
   * Record that an extension named a project.
   *
   * @param reporter - The pair, how it was named, and when.
   */
  addReporter(reporter: KnownProjectReporter): void {
    this.db
      .insert(knownProjectReporters)
      .values(reporter)
      .onConflictDoUpdate({
        target: [knownProjectReporters.root, knownProjectReporters.extensionId],
        // Only ever towards `report`: a later `resolve` leaves a report alone.
        set: {
          kind: sql`CASE WHEN ${knownProjectReporters.kind} = 'report' THEN 'report' ELSE excluded.kind END`,
        },
      })
      .run();
  }
}
