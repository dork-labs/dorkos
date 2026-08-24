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
   * The path a file was SEEN at → the real path it resolved to.
   *
   * Kept because a deleted file cannot be resolved: `fs.realpath` on it throws
   * ENOENT. When a watcher reports an unlink it hands us the path it was
   * watching — for an installed plugin skill, the symlink — while the row is
   * keyed on the target. Without this mapping the pause looked up a path no row
   * held, and an uninstalled package's schedule went on firing (DOR-1485
   * review, I3).
   */
  private resolvedBySighting = new Map<string, string>();

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
   * @param sightedPath - The path it was seen at, when that differs. Remembered
   *   so a later deletion of that path can still name the row it belongs to.
   * @returns Whether this root owns the file and should sync it.
   */
  claim(resolvedPath: string, rootDir: string, sightedPath?: string): boolean {
    if (sightedPath !== undefined && sightedPath !== resolvedPath) {
      this.resolvedBySighting.set(sightedPath, resolvedPath);
    }
    const owner = this.owners.get(resolvedPath);
    if (owner === undefined) {
      this.owners.set(resolvedPath, rootDir);
      return true;
    }
    return owner === rootDir;
  }

  /**
   * The real path a file seen at this path resolved to, if it was ever claimed.
   *
   * `undefined` for a path never seen, and for one that resolved to itself —
   * both of which mean "the path you have is the identity", so a caller reads
   * this as `resolvedFor(p) ?? p`.
   *
   * @param sightedPath - The path a watcher reported.
   */
  resolvedFor(sightedPath: string): string | undefined {
    return this.resolvedBySighting.get(sightedPath);
  }

  /*
   * ONE CASE THIS DOES NOT COVER, stated so nobody assumes it does.
   *
   * The mapping lives in memory, so it is empty at boot. If a package is
   * uninstalled while DorkOS is NOT running, the watcher's first sight of that
   * path is an unlink for a link it never claimed, and it pauses by the raw link
   * path — which matches no row. The schedule is stranded: a live row whose file
   * is gone.
   *
   * The reconciler is the backstop and does close it, within five minutes:
   * `linkedSkillDirs` reads the dangling link with `readlink`, which still names
   * the target an uninstall removed, so the retirement pass may testify about
   * that directory and retires the row on the evidence of the file itself. A
   * dangling link that has ALSO been swept away leaves nothing to read, and that
   * row waits for a person — the safe direction, and the reason this is a note
   * rather than a guess written into the code.
   */

  /**
   * Drop the claim on one file, because it is gone.
   *
   * Called on a delete so that a file which comes back — or a second root that
   * can still see it — can claim it fresh rather than being locked out by a
   * claim nobody is using.
   *
   * Takes the SIGHTED path, which is what a watcher has in hand, and clears the
   * claim on whatever it resolved to. Passing an already-resolved path works
   * too: it maps to itself.
   *
   * @param sightedPath - The path the file was seen at.
   */
  releasePath(sightedPath: string): void {
    const resolved = this.resolvedBySighting.get(sightedPath) ?? sightedPath;
    this.resolvedBySighting.delete(sightedPath);
    this.owners.delete(resolved);
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
      if (owner !== rootDir) continue;
      this.owners.delete(resolvedPath);
      for (const [sighted, resolved] of this.resolvedBySighting) {
        if (resolved === resolvedPath) this.resolvedBySighting.delete(sighted);
      }
    }
  }

  /** How many files are currently claimed. Diagnostics and tests only. */
  get size(): number {
    return this.owners.size;
  }
}
