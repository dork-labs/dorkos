/** Original finite Room Git checkout operations; the real launcher key stays private. */
import path from 'node:path';
import {
  readInstallationRoomMutationRoots,
  checkInstallationRoomMutationTarget,
  type InstallationRoomMutationContext,
} from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import {
  readOriginalRoomGitCommandPorts,
  GitUnavailableError,
  UnreadablePathError,
  type GitIdentity,
  type StrayChange,
} from '../room-repo-git.js';

/** Build finite operations for an opaque key; unrelated keys fail the original private lookup. */
export function createOriginalRoomGitCheckoutFamily(owner: object) {
  /**
   * Create an empty repo whose default branch is `main`, with no hooks in it.
   *
   * `-b main` rather than a rename afterwards, so the branch is right before the
   * first commit exists and the sidecar's `defaultBranch: 'main'` is a statement
   * of fact rather than a hope.
   *
   * @param repoDir - The directory to initialise. Created by the caller.
   * @param ceilingDir - The room home directory the search may not climb past.
   */
  async function initRepo(
    repoDir: string,
    ceilingDir: string,
    context: InstallationRoomMutationContext
  ): Promise<void> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    const roots = readInstallationRoomMutationRoots(context);
    if (
      typeof repoDir !== 'string' ||
      !path.isAbsolute(repoDir) ||
      path.resolve(repoDir) !== roots.repoPath
    )
      throw new Error('Initialization target must be the captured main repository.');
    await ports.runOwnedGit(
      ['-c', 'init.templateDir=', 'init', '-b', 'main', '--quiet', '.'],
      repoDir,
      ceilingDir,
      context
    );
  }

  /**
   * Whether a checkout has a `main` branch at all.
   *
   * Its own probe rather than an inference from a failure, so that "this repo has
   * no main yet" and "this command failed" stop being the same answer (they were,
   * and the second one silently read as zero unmerged commits).
   *
   * @param checkoutDir - The checkout to ask.
   * @param ceilingDir - The room home directory the search may not climb past.
   */
  async function hasMainBranch(checkoutDir: string, ceilingDir: string): Promise<boolean> {
    readOriginalRoomGitCommandPorts(owner);
    return hasLocalBranch(checkoutDir, 'main', ceilingDir);
  }

  /**
   * Whether a checkout has a local branch by this name.
   *
   * The general form of {@link hasMainBranch}, and the reason the worktree
   * manager can tell "this agent has never had a worktree here" from "the reap
   * removed the worktree and left the branch behind": those need opposite
   * `git worktree add` invocations, and picking by catching a failure would make
   * every OTHER failure look like the same case.
   *
   * @param checkoutDir - The checkout to ask.
   * @param branch - The branch name, without `refs/heads/`.
   * @param ceilingDir - The room home directory the search may not climb past.
   */
  async function hasLocalBranch(
    checkoutDir: string,
    branch: string,
    ceilingDir: string
  ): Promise<boolean> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    try {
      await ports.runReadGit(
        ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
        checkoutDir,
        ceilingDir
      );
      return true;
    } catch (err) {
      if (err instanceof GitUnavailableError) throw err;
      // `--verify --quiet` exits 1 with no output for a ref that is not there.
      // Anything else — an unreadable directory, a corrupt repo — is not this
      // question's to swallow, so it goes back to the caller.
      if ((err as { code?: unknown })?.code === 1) return false;
      throw err;
    }
  }

  /**
   * Stage everything in the tree and commit it under `identity`.
   *
   * The identity is passed per command rather than written into the repo's
   * config, because who commits changes with who is asking — a merge is committed
   * as the agent that asked for it, a `ROOM.md` save as the person who typed it —
   * and a config value would make the LAST writer's name the default for the
   * next one.
   *
   * The identity's control characters are stripped on the way in
   * ({@link stripControlCharacters}) — a commit header DorkOS writes is parsed
   * again later, and a name carrying a field separator is a name that rewrites
   * somebody else's row.
   *
   * @param repoDir - The checkout to commit in.
   * @param message - The commit subject.
   * @param identity - Who the commit is attributed to.
   * @param ceilingDir - The room home directory the search may not climb past.
   * @returns The new commit's full sha.
   */
  async function commitAll(
    repoDir: string,
    message: string,
    identity: GitIdentity,
    ceilingDir: string,
    context: InstallationRoomMutationContext
  ): Promise<string> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    await ports.runOwnedGit(['add', '--all'], repoDir, ceilingDir, context);
    return commitStaged(repoDir, message, identity, ceilingDir, context);
  }

  /**
   * Stage exactly these paths, and nothing else.
   *
   * `:(literal)` on every pathspec, so a member's filename means itself: without
   * it a file called `*` stages its whole directory and one called `!x` means
   * "not x". That is the same magic {@link listTree}'s callers guard against when
   * they READ a path, applied where it can actually change what gets committed.
   *
   * Its own step rather than part of a commit, because a caller that stages a
   * single path needs to know whether anything was staged at all
   * ({@link hasStagedChanges}) before it decides to commit — a person saving a
   * file they did not change is not an error, and it is not history either.
   *
   * @param repoDir - The checkout to stage in.
   * @param paths - Repo-relative paths. Already normalised by the caller.
   * @param ceilingDir - The room home directory the search may not climb past.
   */
  async function stagePaths(
    repoDir: string,
    paths: readonly string[],
    ceilingDir: string,
    context: InstallationRoomMutationContext
  ): Promise<void> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    readInstallationRoomMutationRoots(context);
    const pathTargets = paths.map((value) => ports.requireRepoRelativeMutationPath(repoDir, value));
    await checkInstallationRoomMutationTarget(context, repoDir);
    if (paths.length === 0) return;
    await ports.runOwnedGit(
      ['add', '--', ...paths.map((filePath) => `:(literal)${filePath}`)],
      repoDir,
      ceilingDir,
      context,
      {},
      pathTargets
    );
  }

  /**
   * Whether the index holds anything the current commit does not.
   *
   * `--quiet` makes git answer in its exit status — `1` for "there is a
   * difference" — which is why the failure is READ rather than propagated. Any
   * other exit is a real failure and goes back to the caller.
   *
   * `--cached` compares the index against `HEAD`, and on a repo whose first
   * commit has not happened git compares against the empty tree instead, so a
   * first file answers `true` rather than failing.
   *
   * @param repoDir - The checkout to ask.
   * @param ceilingDir - The room home directory the search may not climb past.
   */
  async function hasStagedChanges(repoDir: string, ceilingDir: string): Promise<boolean> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    try {
      await ports.runReadGit(['diff', '--cached', '--quiet'], repoDir, ceilingDir);
      return false;
    } catch (err) {
      if (err instanceof GitUnavailableError) throw err;
      if ((err as { code?: unknown })?.code === 1) return true;
      throw err;
    }
  }

  /**
   * Commit whatever is staged, under `identity`.
   *
   * The half of {@link commitAll} that is about authorship rather than about
   * staging, split out so a caller that staged one path can reuse it without
   * `--all` sweeping in whatever else happens to be in the tree.
   *
   * The identity's control characters are stripped on the way in
   * ({@link stripControlCharacters}) — a commit header DorkOS writes is parsed
   * again later, and a name carrying a field separator is a name that rewrites
   * somebody else's row.
   *
   * @param repoDir - The checkout to commit in.
   * @param message - The commit subject.
   * @param identity - Who the commit is attributed to.
   * @param ceilingDir - The room home directory the search may not climb past.
   * @returns The new commit's full sha.
   */
  async function commitStaged(
    repoDir: string,
    message: string,
    identity: GitIdentity,
    ceilingDir: string,
    context: InstallationRoomMutationContext
  ): Promise<string> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    await ports.runOwnedGit(
      [
        '-c',
        // Stripped, not trusted: see {@link ports.stripControlCharacters} for the
        // parser this protects and the measurement behind it.
        `user.name=${ports.stripControlCharacters(identity.name)}`,
        '-c',
        `user.email=${ports.stripControlCharacters(identity.email)}`,
        'commit',
        // The second line, not the first: `core.hooksPath` above is what actually
        // stops a hook. See the module doc — this skips `pre-commit` and
        // `commit-msg` only, measured.
        '--no-verify',
        '--quiet',
        '-m',
        message,
      ],
      repoDir,
      ceilingDir,
      context
    );
    return ports.runOwnedGit(['rev-parse', 'HEAD'], repoDir, ceilingDir, context);
  }

  /**
   * Everything in a checkout that is not committed — staged, unstaged and
   * untracked alike, one record each.
   *
   * The richer twin of {@link hasUncommittedChanges}, and it exists because the
   * integration tree needs a different answer from a worktree. For a worktree the
   * question is yes/no: may this be thrown away. For `repo/` the answer has to be
   * SHOWN to a person and then acted on file by file — the spec's dirty-main
   * degradation offers "commit these" or "discard exactly these", and neither is
   * expressible without the list.
   *
   * `--porcelain=v1 -z` because it is the only stable format that can carry a
   * filename holding a newline or a quote, which a room's members can commit.
   * `--untracked-files=all` lists files inside a new directory individually
   * rather than naming the directory, so every entry is something the discard
   * path can name literally.
   *
   * **A rename is TWO records in `-z` output** (`R  <new>NUL<old>NUL`), and the
   * old path is consumed rather than reported: reporting it would offer the
   * person a path that is not there to discard.
   *
   * @param checkoutDir - The checkout to inspect.
   * @param ceilingDir - The room home directory the search may not climb past.
   * @returns One record per path, in git's own order.
   */
  async function listStrayChanges(checkoutDir: string, ceilingDir: string): Promise<StrayChange[]> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    // **Raw, because the private text launcher trims and a status record can BEGIN with a
    // space.** ` M notes.md` — unmodified in the index, modified in the tree — is
    // the ordinary shape of an edit somebody made in a terminal, and trimming it
    // shifts every field of the record it starts. Filenames may legitimately
    // begin with whitespace too. Nothing here rewrites git's bytes.
    const out = (
      await ports.runReadGitRaw(
        ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
        checkoutDir,
        ceilingDir,
        // A tree somebody dropped a build directory into can list a very large
        // number of untracked files, and this is the one status read that has to
        // survive it rather than fail the whole room's degradation report.
        { maxBuffer: ports.LARGE_OUTPUT_MAX_BUFFER }
      )
    ).toString('utf-8');
    const records = out.split('\0');
    const strays: StrayChange[] = [];
    for (let at = 0; at < records.length; at += 1) {
      const record = records[at];
      // `XY <path>`: two status letters, a space, then the path — so anything
      // shorter than four characters is not a record.
      if (!record || record.length < 4) continue;
      const index = record[0] ?? ' ';
      const worktree = record[1] ?? ' ';
      const filePath = record.slice(3);
      // The old name of a rename or a copy follows in its own record. It is
      // consumed rather than listed — offering it would offer a path that is not
      // there — and kept on the record it belongs to, because undoing the rename
      // means restoring it. See {@link StrayChange.renamedFrom}.
      const renamedFrom = index === 'R' || index === 'C' ? records[++at] : undefined;
      strays.push({
        path: filePath,
        kind: ports.strayKind(index, worktree),
        ...(renamedFrom ? { renamedFrom } : {}),
      });
    }
    return strays;
  }

  /**
   * Whether this repo's own ignore rules exclude a path.
   *
   * `check-ignore -q` answers in its exit status — `0` ignored, `1` not, anything
   * else a real failure — which is why the `1` is read rather than propagated.
   * `--no-index` asks about the RULES rather than about what is already tracked,
   * so a file that is both tracked and matched by a rule answers honestly instead
   * of being excused by its own history.
   *
   * **The one command here that cannot take `:(literal)`** — `check-ignore`
   * refuses pathspec magic outright ("pathspec magic not supported by this
   * command"), so the path goes in bare, after `--` so a name beginning with a
   * dash is still a path rather than an option. The cost is that a filename
   * containing glob characters is tested as the pattern it looks like, which can
   * answer "ignored" for a file that is not. That direction is the safe one: it
   * refuses a save that would have worked, with a sentence saying why, rather
   * than committing something the room excludes.
   *
   * @param repoDir - The checkout whose rules to ask.
   * @param filePath - A normalised repo-relative path.
   * @param ceilingDir - The room home directory the search may not climb past.
   */
  async function isIgnored(
    repoDir: string,
    filePath: string,
    ceilingDir: string
  ): Promise<boolean> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    try {
      await ports.runReadGit(
        ['check-ignore', '-q', '--no-index', '--', filePath],
        repoDir,
        ceilingDir
      );
      return true;
    } catch (err) {
      if (err instanceof GitUnavailableError) throw err;
      if ((err as { code?: unknown })?.code === 1) return false;
      // **Anything else is this command failing on the PATH, and it is named as
      // that rather than propagated raw.** `check-ignore` exits 128 on a pathspec
      // it cannot parse — the magic it does not support — and letting that out
      // reached the global handler as a 500 with no code, which is both a lie
      // about whose fault it was and unactionable (`:!x.md`, found in review).
      // Its own type, like the two failures above it, so the caller translates it
      // into the room's own refusal instead of guessing from a message.
      throw new UnreadablePathError(filePath, err);
    }
  }

  /**
   * Which of these paths the commit `HEAD` names actually holds.
   *
   * The question a discard has to answer before it picks HOW to undo a change: a
   * path that is in `HEAD` is restored from it, and a path that is not can only
   * be removed. Asked in ONE command for every path, and asked of git rather than
   * of the index, because the index is one of the things a stray change may have
   * touched.
   *
   * @param repoDir - The checkout to ask.
   * @param paths - Repo-relative paths.
   * @param ceilingDir - The room home directory the search may not climb past.
   * @returns The subset of `paths` that `HEAD` holds.
   */
  async function pathsInHead(
    repoDir: string,
    paths: readonly string[],
    ceilingDir: string
  ): Promise<Set<string>> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    if (paths.length === 0) return new Set();
    // Raw for the reason {@link listStrayChanges} gives: a filename may begin or
    // end with whitespace, and a trimmed answer would fail to match the path the
    // caller asked about — which here would mean choosing the wrong way to undo
    // it.
    const out = (
      await ports.runReadGitRaw(
        [
          'ls-tree',
          '-z',
          '--name-only',
          'HEAD',
          '--',
          ...paths.map((filePath) => `:(literal)${filePath}`),
        ],
        repoDir,
        ceilingDir
      )
    ).toString('utf-8');
    return new Set(out.split('\0').filter((name) => name !== ''));
  }

  /**
   * Put these paths back the way `HEAD` has them, in the index and in the tree.
   *
   * `git checkout HEAD --` rather than `git restore`, because it is one command
   * for both halves and it has meant the same thing in every git a person might
   * have. Every path is a `:(literal)` pathspec, so a filename never behaves as a
   * glob.
   *
   * **Destructive, and deliberately narrow**: it undoes exactly the paths it is
   * given and never a directory, so the caller has to have named each file.
   *
   * @param repoDir - The checkout to restore in.
   * @param paths - Repo-relative paths, all of which `HEAD` holds.
   * @param ceilingDir - The room home directory the search may not climb past.
   */
  async function restoreFromHead(
    repoDir: string,
    paths: readonly string[],
    ceilingDir: string,
    context: InstallationRoomMutationContext
  ): Promise<void> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    readInstallationRoomMutationRoots(context);
    const pathTargets = paths.map((value) => ports.requireRepoRelativeMutationPath(repoDir, value));
    await checkInstallationRoomMutationTarget(context, repoDir);
    if (paths.length === 0) return;
    await ports.runOwnedGit(
      ['checkout', 'HEAD', '--', ...paths.map((filePath) => `:(literal)${filePath}`)],
      repoDir,
      ceilingDir,
      context,
      {},
      pathTargets
    );
  }

  /**
   * Take these paths out of the index.
   *
   * The other half of a discard: a path that `HEAD` does not hold cannot be
   * restored from it, so what "undo" means for one is that its file goes away and
   * it stops being staged. The caller deletes the file itself — no subprocess, and
   * no `git clean`, a command whose whole reputation is for removing more than it
   * was asked to.
   *
   * **Call this AFTER deleting the file, not before**, and the order is a fix
   * rather than a preference. `git rm --cached` refuses a path whose staged
   * content differs from both `HEAD` and the file on disk — the state a person
   * leaves behind by staging something and then editing it again — and the
   * documented way past that refusal is `-f`, a flag this domain does not use and
   * a test forbids by name. With the file already gone there is nothing to
   * disagree with, and the same call succeeds. Measured both ways.
   *
   * `--ignore-unmatch` so a path that was never staged at all — an ordinary
   * untracked file — is a no-op rather than a failure.
   *
   * @param repoDir - The checkout to unstage in.
   * @param paths - Repo-relative paths, whose files are already deleted.
   * @param ceilingDir - The room home directory the search may not climb past.
   */
  async function unstagePaths(
    repoDir: string,
    paths: readonly string[],
    ceilingDir: string,
    context: InstallationRoomMutationContext
  ): Promise<void> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    readInstallationRoomMutationRoots(context);
    const pathTargets = paths.map((value) => ports.requireRepoRelativeMutationPath(repoDir, value));
    await checkInstallationRoomMutationTarget(context, repoDir);
    if (paths.length === 0) return;
    await ports.runOwnedGit(
      [
        'rm',
        '--cached',
        '--quiet',
        '--ignore-unmatch',
        '--',
        ...paths.map((filePath) => `:(literal)${filePath}`),
      ],
      repoDir,
      ceilingDir,
      context,
      {},
      pathTargets
    );
  }

  /**
   * Whether a checkout holds changes that are not committed — staged, unstaged or
   * untracked alike.
   *
   * One `status --porcelain` rather than the workspace domain's richer dirty
   * state, because the question a room asks of a worktree is a yes/no: may this
   * be thrown away. What is dirty about it is the explorer's job to show, not the
   * delete guard's.
   *
   * @param checkoutDir - The checkout to inspect.
   * @param ceilingDir - The room home directory the search may not climb past.
   */
  async function hasUncommittedChanges(checkoutDir: string, ceilingDir: string): Promise<boolean> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    return (
      (await ports.runReadGit(['status', '--porcelain=v1'], checkoutDir, ceilingDir)).length > 0
    );
  }

  /**
   * How many commits `checkoutDir`'s HEAD holds that `main` does not.
   *
   * `0` means merged, and it means ONLY that: a repo with no `main` yet answers
   * `0` because a tree that cannot be compared against an integration branch that
   * does not exist has nothing stranded in it by definition, and that one case is
   * established by {@link hasMainBranch} rather than inferred from a failure.
   * Every other failure propagates, so the delete guard's conservative handler
   * sees it and calls the worktree unfinished.
   *
   * @param checkoutDir - The worktree to measure.
   * @param ceilingDir - The room home directory the search may not climb past.
   * @returns The count of unmerged commits.
   * @throws When the checkout cannot be read.
   */
  async function commitsAheadOfMain(checkoutDir: string, ceilingDir: string): Promise<number> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    if (!(await hasMainBranch(checkoutDir, ceilingDir))) return 0;
    const out = await ports.runReadGit(
      ['rev-list', '--count', 'main..HEAD'],
      checkoutDir,
      ceilingDir
    );
    return Number.parseInt(out, 10) || 0;
  }

  return Object.freeze({
    initRepo,
    hasMainBranch,
    hasLocalBranch,
    commitAll,
    stagePaths,
    hasStagedChanges,
    commitStaged,
    listStrayChanges,
    isIgnored,
    pathsInHead,
    restoreFromHead,
    unstagePaths,
    hasUncommittedChanges,
    commitsAheadOfMain,
  });
}
