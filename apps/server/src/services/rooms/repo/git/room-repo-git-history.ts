/** Original finite Room Git history operations; the real launcher key stays private. */
import path from 'node:path';
import { RoomError } from '../../data/room-errors.js';
import { type InstallationRoomMutationContext } from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import {
  readOriginalRoomGitCommandPorts,
  GitUnavailableError,
  MergeConflictError,
  type GitIdentity,
  type NativeLaunch,
  type TreeEntry,
  type DiffStat,
} from '../room-repo-git.js';

/** Build finite operations for an opaque key; unrelated keys fail the original private lookup. */
export function createOriginalRoomGitHistoryFamily(owner: object) {
  /**
   * When the commit at `HEAD` was committed.
   *
   * Committer date rather than author date: it moves when a commit is rebased or
   * amended in this tree, which is the question "when was this worktree last
   * worked in" actually asks.
   *
   * A checkout with no commits yet answers `null` rather than throwing, which the
   * caller reads as "this tree has no commit date" and moves on to its other
   * sources. That case is `git log` exiting 128 with "does not have any commits
   * yet" — caught here, because the alternative was a contract that said `null`
   * and a function that threw. Every OTHER failure still propagates: an
   * unreadable tree must not be spelled the same way as an empty one, which is
   * the mistake {@link commitsAheadOfMain} was fixed for.
   *
   * @param checkoutDir - The checkout to ask.
   * @param ceilingDir - The room home directory the search may not climb past.
   * @returns The commit time, or `null` when there are no commits yet.
   * @throws When the checkout cannot be read at all.
   */
  async function headCommittedAt(checkoutDir: string, ceilingDir: string): Promise<Date | null> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    let iso: string;
    try {
      iso = await ports.runReadGit(['log', '-1', '--format=%cI'], checkoutDir, ceilingDir);
    } catch (err) {
      if (err instanceof GitUnavailableError) throw err;
      const stderr = String((err as { stderr?: unknown })?.stderr ?? '');
      if (/does not have any commits yet|unknown revision or path/i.test(stderr)) return null;
      throw err;
    }
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? null : at;
  }

  /**
   * How far one branch has run ahead of another, and how far behind.
   *
   * `rev-list --left-right --count a...b` counts the commits reachable from
   * exactly one side of the symmetric difference: the left number is what `a` has
   * and `b` has not (`behind`, from `b`'s point of view), the right is what `b`
   * has and `a` has not (`ahead`). Asked in the MAIN checkout so a status sweep
   * never has to enter somebody else's working copy.
   *
   * @param repoDir - The room's main checkout.
   * @param base - The integration branch, normally `main`.
   * @param branch - The branch being measured against it.
   * @param ceilingDir - The room home directory the search may not climb past.
   * @returns How many commits `branch` holds that `base` does not, and vice versa.
   */
  async function aheadBehind(
    repoDir: string,
    base: string,
    branch: string,
    ceilingDir: string
  ): Promise<{ ahead: number; behind: number }> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    ports.requireRevisionOperand(base);
    ports.requireRevisionOperand(branch);
    const out = await ports.runReadGit(
      ['rev-list', '--left-right', '--count', `${base}...${branch}`],
      repoDir,
      ceilingDir
    );
    const [behind, ahead] = out.split(/\s+/).map((part) => Number.parseInt(part, 10) || 0);
    return { ahead: ahead ?? 0, behind: behind ?? 0 };
  }

  /**
   * Every blob in a commit's tree, with its mode, object id and size.
   *
   * `-r` recurses (so no sub-tree entries come back), `-l` adds the size, and
   * `-z` makes the record separator a NUL — which is the only way to read a path
   * that contains a newline, and paths in a repo members write to are not this
   * module's to trust.
   *
   * One command for the whole tree rather than one per changed file: the merge
   * validation needs both the delta (what changed) and the total (what the repo
   * would weigh), and comparing two of these answers both without a second pass.
   *
   * @param repoDir - The room's main checkout.
   * @param commitish - The commit or branch whose tree to list.
   * @param ceilingDir - The room home directory the search may not climb past.
   * @returns Every blob, keyed by path.
   */
  async function listTree(
    repoDir: string,
    commitish: string,
    ceilingDir: string
  ): Promise<Map<string, TreeEntry>> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    ports.requireRevisionOperand(commitish);
    const out = await ports.runReadGit(
      ['ls-tree', '-r', '-l', '-z', commitish],
      repoDir,
      ceilingDir,
      // A tree listing is one line per file, so a large repo outruns the shared
      // default — measured to break around 15-20k files against `execFile`'s own
      // 1 MB, and it surfaces as an unmapped 500 rather than as anything a caller
      // could act on. Asked for explicitly rather than left to
      // {@link GIT_MAX_OUTPUT_BYTES}, because this command's output is the one
      // that scales with the whole repository.
      { maxBuffer: ports.LARGE_OUTPUT_MAX_BUFFER }
    );
    const entries = new Map<string, TreeEntry>();
    for (const record of out.split('\0')) {
      if (record.length === 0) continue;
      // `<mode> SP <type> SP <sha> SP <size> TAB <path>`, with the size
      // right-aligned in a padded column and `-` for anything that is not a blob.
      const match = /^(\d{6}) (\w+) ([0-9a-f]+) +(\d+|-)\t(.*)$/s.exec(record);
      if (!match) continue;
      const [, mode, type, sha, size, entryPath] = match;
      // **`commit` is kept, and dropping it was a hole.** A gitlink is type
      // `commit`, so a filter of `type !== 'blob'` removed submodules from the
      // listing entirely — which meant they appeared in neither the before tree
      // nor the after tree, were therefore never in the delta, and reached `main`
      // without meeting a single check. They are listed here so the caller can
      // refuse them by name.
      if ((type !== 'blob' && type !== 'commit') || !mode || !sha || !entryPath) continue;
      entries.set(entryPath, {
        path: entryPath,
        mode,
        sha,
        size: size === '-' ? 0 : Number.parseInt(size, 10) || 0,
      });
    }
    return entries;
  }

  /**
   * The content of one blob, as text.
   *
   * Used for exactly one thing: reading where a symlink points, which is a short
   * path and never a file the caller has not already size-checked. It trims,
   * which a general blob reader must not — a symlink target with trailing
   * whitespace is not a target anybody meant, and trimming can only make the
   * escape check stricter.
   *
   * @param repoDir - The room's main checkout.
   * @param sha - The blob to read.
   * @param ceilingDir - The room home directory the search may not climb past.
   * @returns The blob's content, trimmed.
   */
  async function readBlob(repoDir: string, sha: string, ceilingDir: string): Promise<string> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    ports.requireRevisionOperand(sha);
    return ports.runReadGit(['cat-file', 'blob', sha], repoDir, ceilingDir);
  }

  /**
   * How large the delta between two commits is, in files and lines.
   *
   * `--shortstat` rather than counting `--numstat` rows, because the numbers are
   * for a sentence a person reads in the room ("4 files, +120/−8") and git
   * already writes that sentence. A delta of nothing answers all zeros, which is
   * what an empty `--shortstat` line means.
   *
   * @param repoDir - The room's main checkout.
   * @param from - The commit the delta starts at.
   * @param to - The commit it ends at.
   * @param ceilingDir - The room home directory the search may not climb past.
   * @returns The counts.
   */
  async function shortstat(
    repoDir: string,
    from: string,
    to: string,
    ceilingDir: string
  ): Promise<DiffStat> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    ports.requireRevisionOperand(from);
    ports.requireRevisionOperand(to);
    const out = await ports.runReadGit(['diff', '--shortstat', from, to], repoDir, ceilingDir);
    const read = (pattern: RegExp): number =>
      Number.parseInt(pattern.exec(out)?.[1] ?? '0', 10) || 0;
    return {
      files: read(/(\d+) files? changed/),
      insertions: read(/(\d+) insertions?\(\+\)/),
      deletions: read(/(\d+) deletions?\(-\)/),
    };
  }

  /**
   * The commit a ref points at right now.
   *
   * @param checkoutDir - The checkout to ask.
   * @param ref - The ref to resolve.
   * @param ceilingDir - The room home directory the search may not climb past.
   * @returns The full sha.
   */
  async function revParse(checkoutDir: string, ref: string, ceilingDir: string): Promise<string> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    ports.requireRevisionOperand(ref);
    return ports.runReadGit(['rev-parse', ref], checkoutDir, ceilingDir);
  }

  /**
   * The branch a checkout has checked out, or `null` when its HEAD is detached.
   *
   * The main checkout of a room repo is only ever on `main` — the server is its
   * only writer and never leaves it — so anything else is an out-of-band change,
   * which the merge refuses rather than merging into whatever it finds.
   *
   * @param checkoutDir - The checkout to ask.
   * @param ceilingDir - The room home directory the search may not climb past.
   */
  async function currentBranch(checkoutDir: string, ceilingDir: string): Promise<string | null> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    const name = await ports.runReadGit(
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      checkoutDir,
      ceilingDir
    );
    return name === 'HEAD' ? null : name;
  }

  /**
   * Merge `branch` into whatever `repoDir` has checked out, always as a real
   * merge commit — and leave nothing behind if it fails.
   *
   * **`--no-ff` is the point, not a preference.** The caller has already refused
   * anything that is behind `main`, so every merge that gets here COULD fast
   * forward; letting it would erase the fact that the work happened on a branch,
   * and a room's log says "Ana merged …" about a commit that would then not
   * exist. One merge, one commit, one entry.
   *
   * **The abort is this function's own job**, and that is why the merge is here
   * rather than assembled by the caller. A conflicted `git merge` leaves the
   * checkout mid-merge — an index full of conflict stages, `MERGE_HEAD` written
   * — and the next merge into that tree would be refused, or worse, would commit
   * somebody's conflict markers. `git merge --abort` puts the tree back exactly
   * where it was, and it runs in a `finally`-shaped path so no error route can
   * skip it. The abort's own failure is recorded as cleanupCause on the original
   * merge failure; it cannot replace the original cause, even when that cause
   * is undefined. Pre-launch ownership/configuration refusals do not launch an abort.
   *
   * `--no-verify` is deliberately absent, unlike {@link commitAll}. It is a newer
   * option on `merge` than on `commit`, and `core.hooksPath` — applied to every
   * command in this module — is what actually stops a hook running (see the
   * module doc, where that was measured).
   *
   * @param repoDir - The checkout to merge INTO. Must be clean.
   * @param branch - The branch to merge in.
   * @param message - The merge commit's message. Sanitized by the caller.
   * @param identity - Who the merge commit is attributed to.
   * @param ceilingDir - The room home directory the search may not climb past.
   * @returns The new merge commit's full sha.
   * @throws {MergeConflictError} When the merge did not complete. The checkout is
   *   back at its previous commit, unmodified.
   */
  async function mergeNoFf(
    repoDir: string,
    branch: string,
    message: string,
    identity: GitIdentity,
    ceilingDir: string,
    context: InstallationRoomMutationContext
  ): Promise<string> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    ports.requireRevisionOperand(branch);
    const launch: NativeLaunch = { started: false };
    try {
      await ports.runOwnedGit(
        [
          '-c',
          `user.name=${identity.name}`,
          '-c',
          `user.email=${identity.email}`,
          'merge',
          '--no-ff',
          '--quiet',
          '-m',
          message,
          branch,
        ],
        repoDir,
        ceilingDir,
        context,
        {},
        [],
        launch
      );
    } catch (err) {
      if (!launch.started || err instanceof GitUnavailableError || err instanceof RoomError)
        throw err;
      const failure = new MergeConflictError(branch, err);
      try {
        await ports.runOwnedGit(['merge', '--abort'], repoDir, ceilingDir, context);
      } catch (cleanupCause) {
        Object.defineProperty(failure, 'cleanupCause', { value: cleanupCause });
      }
      throw failure;
    }
    return ports.runOwnedGit(['rev-parse', 'HEAD'], repoDir, ceilingDir, context);
  }

  /**
   * The absolute git directory backing a checkout.
   *
   * For a linked worktree this is `<repo>/.git/worktrees/<name>`, which is where
   * that worktree's own `index` lives — the file whose mtime says when anything
   * was last staged, committed or refreshed in it.
   *
   * @param checkoutDir - The checkout to ask.
   * @param ceilingDir - The room home directory the search may not climb past.
   */
  async function absoluteGitDir(checkoutDir: string, ceilingDir: string): Promise<string> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    return ports.runReadGit(['rev-parse', '--absolute-git-dir'], checkoutDir, ceilingDir);
  }

  /**
   * The git directory shared by a repo and every worktree of it.
   *
   * `info/exclude` lives here (git's `common_list` maps `info` to the common
   * directory), so one write covers the main checkout and every standing
   * worktree at once.
   *
   * @param checkoutDir - Any checkout of the repo.
   * @param ceilingDir - The room home directory the search may not climb past.
   */
  async function commonGitDir(checkoutDir: string, ceilingDir: string): Promise<string> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    const dir = await ports.runReadGit(['rev-parse', '--git-common-dir'], checkoutDir, ceilingDir);
    return path.resolve(checkoutDir, dir);
  }

  return Object.freeze({
    headCommittedAt,
    aheadBehind,
    listTree,
    readBlob,
    shortstat,
    revParse,
    currentBranch,
    mergeNoFf,
    absoluteGitDir,
    commonGitDir,
  });
}
