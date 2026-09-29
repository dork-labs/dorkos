/**
 * The durable half of the project registry: one `known_projects` row per
 * project (spec `flow-multiproject` §6.1).
 *
 * Every method is synchronous (better-sqlite3). The registry holds the rows in
 * memory and writes through here, so a registry with no store (a unit test,
 * or a boot that has not wired one yet) still works, it just forgets on
 * restart.
 *
 * @module services/projects/known-projects-store
 */
import { eq, knownProjects, type Db, type KnownProjectRow } from '@dorkos/db';

/** A known project as the registry stores it. */
export type KnownProject = KnownProjectRow;

/** The writes the registry makes. */
export interface KnownProjectsPort {
  /** Every stored project. */
  all(): KnownProject[];
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
    patch: Partial<Pick<KnownProject, 'originRepo' | 'source' | 'reportedBy' | 'lastSeenAt'>>
  ): void;
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
    patch: Partial<Pick<KnownProject, 'originRepo' | 'source' | 'reportedBy' | 'lastSeenAt'>>
  ): void {
    if (Object.keys(patch).length === 0) return;
    this.db.update(knownProjects).set(patch).where(eq(knownProjects.root, root)).run();
  }
}
