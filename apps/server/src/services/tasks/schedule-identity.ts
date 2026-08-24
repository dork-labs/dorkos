/**
 * One real SKILL.md is one schedule, however many roots can see it.
 *
 * ## The problem this exists for
 *
 * Installed marketplace plugins appear in an agent's `.agents/skills/` as
 * `pkg__name` symlinks that resolve into `.dork/plugins/<pkg>/skills/<name>/`.
 * Two agents in two projects can have the same plugin installed, so the same
 * real file is reachable through two watched roots — and a schedule that fires
 * twice because it was found twice is a real, silent, duplicated-work bug.
 *
 * Identity is therefore the RESOLVED real path, never the path a scanner
 * happened to walk in on. That alone collapses the row: `upsertFromFile` is
 * keyed by `filePath`, so two roots reaching one real file write one row.
 *
 * ## What the registry adds on top
 *
 * The row is already single. What is not single is its ATTRIBUTION — scope,
 * project, agent — which differs per root. Without a memory of who got there
 * first, every reconcile pass would rewrite the row to whichever root the loop
 * happened to reach last, and a schedule would drift between agents on a
 * five-minute cycle. So the first root to see a real file claims it, and later
 * roots are told to leave it alone (spec §2: "first root wins; identity is the
 * resolved real path").
 *
 * Claims are released when a root stops being watched — an unregistered agent
 * must not keep owning a file another agent can still see — and when a file
 * goes away.
 *
 * @module services/tasks/schedule-identity
 */

/**
 * Remembers which watched root owns each real SKILL.md.
 *
 * One instance is shared by the watcher and the reconciler, because they are
 * two halves of one discovery pass and a claim only means anything if both
 * respect it.
 */
export class ScheduleIdentityRegistry {
  /** Resolved real path → the root directory that claimed it. */
  private owners = new Map<string, string>();

  /**
   * Ask whether this root may sync this file.
   *
   * The first root to ask about a given real path claims it and is told yes;
   * every other root is told no until the claim is released. A root asking
   * again about a file it already owns is always told yes, which is what makes
   * this safe to call on every watcher event and every reconcile pass.
   *
   * @param resolvedPath - The file's real path, symlinks resolved.
   * @param rootDir - The watched root this sighting came through.
   * @returns Whether this root owns the file and should sync it.
   */
  claim(resolvedPath: string, rootDir: string): boolean {
    const owner = this.owners.get(resolvedPath);
    if (owner === undefined) {
      this.owners.set(resolvedPath, rootDir);
      return true;
    }
    return owner === rootDir;
  }

  /**
   * Drop the claim on one file, because it is gone.
   *
   * Called on a delete so that a file which comes back — or a second root that
   * can still see it — can claim it fresh rather than being locked out by a
   * claim nobody is using.
   *
   * @param resolvedPath - The file's real path.
   */
  releasePath(resolvedPath: string): void {
    this.owners.delete(resolvedPath);
  }

  /**
   * Drop every claim held by one root, because it is no longer watched.
   *
   * Without this, unregistering an agent would leave its roots owning files
   * that another agent's root can still see, and those schedules would stop
   * being synced by anyone.
   *
   * @param rootDir - The root that stopped being watched.
   */
  releaseRoot(rootDir: string): void {
    for (const [resolvedPath, owner] of this.owners) {
      if (owner === rootDir) this.owners.delete(resolvedPath);
    }
  }

  /** How many files are currently claimed. Diagnostics and tests only. */
  get size(): number {
    return this.owners.size;
  }
}
