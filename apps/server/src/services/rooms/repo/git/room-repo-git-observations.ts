/** Original finite Room Git observations operations; the real launcher key stays private. */
import path from 'node:path';
import { type InstallationRoomMutationContext } from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import { readOriginalRoomGitCommandPorts, type RunGitOptions } from '../room-repo-git.js';

/** Build finite operations for an opaque key; unrelated keys fail the original private lookup. */
export function createOriginalRoomGitObservationsFamily(owner: object) {
  /** Observe the effective foreground maintenance settings through the same hardened read launcher. */
  async function readRoomForegroundMaintenance(
    checkoutDir: string,
    ceilingDir: string
  ): Promise<Readonly<{ maintenanceAutoDetach: string; gcAutoDetach: string }>> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    const maintenanceAutoDetach = await ports.runReadGit(
      ['config', '--get', 'maintenance.autoDetach'],
      checkoutDir,
      ceilingDir
    );
    const gcAutoDetach = await ports.runReadGit(
      ['config', '--get', 'gc.autoDetach'],
      checkoutDir,
      ceilingDir
    );
    return Object.freeze({ maintenanceAutoDetach, gcAutoDetach });
  }

  /** Fixed working-tree observation; no caller-selected command, extension, textconv or output budget. */
  function readRoomWorkingDiff(checkoutDir: string, ceilingDir: string): Promise<string> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    return ports.runReadGit(['diff', '--no-ext-diff', '--no-textconv'], checkoutDir, ceilingDir);
  }

  /** Actual own-repository registration DATA only; this never grants removal permission. */
  async function readRoomWorktreeRegistration(
    repoDir: string,
    ceilingDir: string,
    worktreeDir: string,
    expectedBranch: string
  ): Promise<Readonly<{ directory: string; branch: string; head: string }> | null> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    ports.requireRevisionOperand(expectedBranch);
    const bytes = await ports.runReadGitRaw(
      ['worktree', 'list', '--porcelain', '-z'],
      repoDir,
      ceilingDir
    );
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes) || !text.endsWith('\0\0'))
      throw new Error('Invalid native worktree registration encoding/framing.');
    const records = text.slice(0, -2).split('\0\0');
    const directories = new Set<string>();
    let match: Readonly<{ directory: string; branch: string; head: string }> | null = null;
    for (const record of records) {
      const fields = record.split('\0');
      const first = fields.shift();
      if (!first?.startsWith('worktree ') || first.length === 9)
        throw new Error('Invalid native worktree registration path.');
      const directory = first.slice(9);
      if (!path.isAbsolute(directory))
        throw new Error('Native worktree registration is not absolute.');
      const normalized = path.resolve(directory);
      if (directories.has(normalized)) throw new Error('Duplicate native worktree registration.');
      directories.add(normalized);
      const seen = new Set<string>();
      let head: string | undefined, branch: string | undefined;
      let bare = false,
        detached = false,
        locked = false,
        prunable = false;
      for (const field of fields) {
        const space = field.indexOf(' '),
          key = space < 0 ? field : field.slice(0, space);
        const value = space < 0 ? undefined : field.slice(space + 1);
        if (seen.has(key)) throw new Error('Duplicate native worktree registration field.');
        seen.add(key);
        if (key === 'HEAD' && value !== undefined && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value))
          head = value;
        else if (key === 'branch' && value?.startsWith('refs/heads/') && value.length > 11)
          branch = value;
        else if (key === 'bare' && value === undefined) bare = true;
        else if (key === 'detached' && value === undefined) detached = true;
        else if (key === 'locked') locked = true;
        else if (key === 'prunable') prunable = true;
        else throw new Error('Unknown or malformed native worktree registration field.');
      }
      if (
        (bare && (head !== undefined || branch !== undefined || detached)) ||
        (!bare && (head === undefined || (detached ? branch !== undefined : branch === undefined)))
      )
        throw new Error('Conflicting native worktree registration.');
      if (
        normalized === path.resolve(worktreeDir) &&
        !bare &&
        !detached &&
        !locked &&
        !prunable &&
        branch === `refs/heads/${expectedBranch}` &&
        head !== undefined
      )
        match = Object.freeze({ directory, branch, head });
    }
    return match;
  }

  /** Fixed owned refresh write; no caller may supply Git flags or another repository. */
  async function fastForwardRoomWorktree(
    worktree: string,
    tip: string,
    ceilingDir: string,
    context: InstallationRoomMutationContext,
    options: RunGitOptions = {}
  ): Promise<void> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    ports.requireRevisionOperand(tip);
    await ports.runOwnedGit(
      ['-c', 'merge.autoStash=false', 'merge', '--ff-only', '--quiet', '--no-stat', tip],
      worktree,
      ceilingDir,
      context,
      options
    );
  }

  /** Closed status modes used by existing room readers; never a command classifier. */
  function roomStatusRaw(
    checkout: string,
    ceiling: string,
    mode: 'plain' | 'all' | 'all-submodules' | 'ignored' = 'plain',
    nul = false
  ): Promise<Buffer> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    if (typeof nul !== 'boolean') throw new Error('Invalid status separator.');
    const args = ['status', '--porcelain=v1'];
    switch (mode) {
      case 'plain':
        break;
      case 'all':
        args.push('--untracked-files=all');
        break;
      case 'all-submodules':
        args.push('--untracked-files=all', '--ignore-submodules=none');
        break;
      case 'ignored':
        args.push('--ignored', '--untracked-files=all');
        break;
      default:
        throw new Error('Invalid room status mode.');
    }
    if (nul) args.push('-z');
    return ports.runReadGitRaw(args, checkout, ceiling);
  }

  /** Fixed tracked/untracked listings; a literal path cannot become an option. */
  function roomTrackedPathsRaw(
    checkout: string,
    ceiling: string,
    mode: 'plain' | 'staged' | 'tagged' | 'nul' | 'others' = 'plain',
    relative?: string
  ): Promise<Buffer> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    const args = ['ls-files'];
    switch (mode) {
      case 'plain':
        break;
      case 'staged':
        args.push('-s');
        break;
      case 'tagged':
        args.push('-v', '-z');
        break;
      case 'nul':
        args.push('-z');
        break;
      case 'others':
        args.push('--others', '-z');
        break;
      default:
        throw new Error('Invalid tracked-path mode.');
    }
    if (relative !== undefined) {
      ports.requireRepoRelativeMutationPath(checkout, relative);
      args.push('--', `:(literal)${relative}`);
    }
    return ports.runReadGitRaw(args, checkout, ceiling);
  }

  /** Existing worktree ignored-file query with each pattern occupying one fixed -x value slot. */
  function roomHiddenUntrackedRaw(
    checkout: string,
    ceiling: string,
    patterns: readonly string[]
  ): Promise<Buffer> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    const args = ['ls-files', '-z', '--others', '--ignored'];
    for (const pattern of patterns) {
      if (typeof pattern !== 'string' || pattern.includes('\0'))
        throw new Error('Invalid exclusion pattern.');
      args.push('-x', pattern);
    }
    return ports.runReadGitRaw(args, checkout, ceiling);
  }

  /** Read a verified Room repository revision using bounded Git operands. */
  function roomVerifiedTip(
    checkout: string,
    ceiling: string,
    ref: string,
    quiet = false
  ): Promise<string> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    ports.requireRevisionOperand(ref);
    if (typeof quiet !== 'boolean') throw new Error('Invalid tip query.');
    return ports.runReadGit(
      ['rev-parse', '--verify', ...(quiet ? ['--quiet'] : []), ref],
      checkout,
      ceiling
    );
  }

  /** Read the Room repository's symbolic HEAD. */
  function roomSymbolicHead(checkout: string, ceiling: string): Promise<string> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    return ports.runReadGit(['symbolic-ref', '--quiet', 'HEAD'], checkout, ceiling);
  }

  /** Count commits between validated Room repository revisions. */
  function roomCommitCount(
    checkout: string,
    ceiling: string,
    from: string,
    to: string,
    firstParent = false
  ): Promise<string> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    ports.requireRevisionOperand(from);
    ports.requireRevisionOperand(to);
    if (typeof firstParent !== 'boolean') throw new Error('Invalid commit count mode.');
    return ports.runReadGit(
      ['rev-list', ...(firstParent ? ['--first-parent'] : []), '--count', `${from}..${to}`],
      checkout,
      ceiling
    );
  }

  /** Read raw changed paths between validated Room repository revisions. */
  function roomChangedPathsRaw(
    checkout: string,
    ceiling: string,
    from: string,
    to: string
  ): Promise<Buffer> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    ports.requireRevisionOperand(from);
    ports.requireRevisionOperand(to);
    return ports.runReadGitRaw(
      ['diff', '--name-only', '--no-renames', '-z', from, to],
      checkout,
      ceiling
    );
  }

  /** Read the merge base of HEAD and a validated Room revision. */
  function roomMergeBase(checkout: string, ceiling: string, tip: string): Promise<string> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    ports.requireRevisionOperand(tip);
    return ports.runReadGit(['merge-base', 'HEAD', tip], checkout, ceiling);
  }

  /** Closed formats, positive finite counts and validated revision operands; no caller-selected --output. */
  function roomLogRaw(
    checkout: string,
    ceiling: string,
    format: 'subject' | 'authors' | 'author-subject' | 'hashes' | 'first-parent-subjects',
    count: 1 | 2 | 6 | 8,
    from?: string,
    to?: string
  ): Promise<Buffer> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    if (![1, 2, 6, 8].includes(count)) throw new Error('Invalid room log count.');
    let args: string[];
    switch (format) {
      case 'subject':
        args = ['log', '--format=%s', '-n', String(count)];
        break;
      case 'authors':
        args = ['log', '--format=%an <%ae>', '-n', String(count)];
        break;
      case 'author-subject':
        args = ['log', '--format=%an <%ae>%n%s', '-n', String(count)];
        break;
      case 'hashes':
        args = ['log', '--format=%H', '-n', String(count)];
        break;
      case 'first-parent-subjects':
        args = ['log', '--first-parent', `--max-count=${count}`, '-z', '--format=%H%x1f%s'];
        break;
      default:
        throw new Error('Invalid room log format.');
    }
    if (from !== undefined || to !== undefined) {
      if (from === undefined || to === undefined) throw new Error('Both range endpoints required.');
      ports.requireRevisionOperand(from);
      ports.requireRevisionOperand(to);
      args.push(`${from}..${to}`);
    }
    return ports.runReadGitRaw(args, checkout, ceiling);
  }

  /** Read the size of a validated Room Git object. */
  function roomBlobSize(checkout: string, ceiling: string, object: string): Promise<string> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    ports.requireRevisionOperand(object);
    return ports.runReadGit(['cat-file', '-s', object], checkout, ceiling);
  }

  /** Read a validated Room Git object. */
  function roomShowObject(checkout: string, ceiling: string, object: string): Promise<string> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    ports.requireRevisionOperand(object);
    return ports.runReadGit(['show', object], checkout, ceiling);
  }

  /** Actual RoomFilesService tree shape: pinned object, NUL names, optional literal relative path. */
  function readRoomFileTreeRaw(
    repoDir: string,
    object: string,
    ceilingDir: string,
    relative?: string
  ): Promise<Buffer> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    ports.requireRevisionOperand(object);
    const args = ['ls-tree', '-z', '--long', object];
    if (relative !== undefined) {
      ports.requireRoomFileLiteralPath(repoDir, relative);
      args.push('--', `:(literal)${relative}`);
    }
    return ports.runReadGitRaw(args, repoDir, ceilingDir);
  }

  /** Actual live maxFileBytes+1024 backstop, not the separate FileOps blob fallback. */
  function readRoomFileContentRaw(
    repoDir: string,
    object: string,
    ceilingDir: string,
    maxBuffer: number
  ): Promise<Buffer> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    ports.requireRevisionOperand(object);
    if (!Number.isSafeInteger(maxBuffer) || maxBuffer <= 0)
      throw new Error('Expected the positive safe integer live file-content backstop.');
    return ports.runReadGitRaw(['cat-file', 'blob', object], repoDir, ceilingDir, { maxBuffer });
  }

  /** Actual1000-commit provenance shape with original unpredictable24-hex header marker. */
  function readRoomFileProvenanceRaw(
    repoDir: string,
    commit: string,
    ceilingDir: string,
    dir: string,
    nonce: string
  ): Promise<Buffer> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    ports.requireRevisionOperand(commit);
    if (typeof nonce !== 'string' || !/^[0-9a-f]{24}$/.test(nonce))
      throw new Error('Expected the original24-lowercase-hex provenance nonce.');
    if (dir !== '') ports.requireRoomFileLiteralPath(repoDir, dir);
    const fields = `${nonce}%H\u001f%aI\u001f%an\u001f%s`;
    return ports.runReadGitRaw(
      [
        'log',
        '-z',
        '--name-only',
        '--no-renames',
        `--format=${fields}`,
        '-n',
        '1000',
        commit,
        ...(dir === '' ? [] : ['--', `:(literal)${dir}/`]),
      ],
      repoDir,
      ceilingDir
    );
  }

  /** Fixed blob command for the room file reader; no caller-selected command or tuning. */
  function readRoomFileBlobRaw(repoDir: string, sha: string, ceilingDir: string): Promise<Buffer> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    ports.requireRevisionOperand(sha);
    return ports.runReadGitRaw(['cat-file', 'blob', sha], repoDir, ceilingDir, {
      maxBuffer: 256 * 1024 * 1024,
    });
  }

  /** Fixed provenance read used by room-file-ops. */
  function readRoomFileCommitRaw(
    repoDir: string,
    sha: string,
    ceilingDir: string
  ): Promise<Buffer> {
    const ports = readOriginalRoomGitCommandPorts(owner);
    ports.requireRevisionOperand(sha);
    return ports.runReadGitRaw(
      ['log', '-1', '--format=%H%x00%an%x00%aI%x00%s', sha],
      repoDir,
      ceilingDir
    );
  }

  return Object.freeze({
    readRoomForegroundMaintenance,
    readRoomWorkingDiff,
    readRoomWorktreeRegistration,
    fastForwardRoomWorktree,
    roomStatusRaw,
    roomTrackedPathsRaw,
    roomHiddenUntrackedRaw,
    roomVerifiedTip,
    roomSymbolicHead,
    roomCommitCount,
    roomChangedPathsRaw,
    roomMergeBase,
    roomLogRaw,
    roomBlobSize,
    roomShowObject,
    readRoomFileTreeRaw,
    readRoomFileContentRaw,
    readRoomFileProvenanceRaw,
    readRoomFileBlobRaw,
    readRoomFileCommitRaw,
  });
}
