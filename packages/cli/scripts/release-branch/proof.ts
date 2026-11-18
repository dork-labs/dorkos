import { execFileSync } from 'node:child_process';
import {
  assertBaseIsAncestor,
  assertHotfixBaseTag,
  assertReleaseBranchName,
  assertReleaseBranchTip,
  assertReleaseCherryPicks,
  assertRoutineBase,
  assertVersionOnNpm,
  formatReleaseBranchLog,
  resolveTagCommit,
  type ReleaseBranchCommit,
  type ReleaseBranchFile,
  type ReleaseBranchMode,
} from './rules.ts';

/** What a release-branch publish was asked to prove. */
export interface ReleaseBranchRequest {
  /** Exactly `release/v<version>`. */
  branch: string;
  /** Routine (cut from QA's pin on main) or hotfix (cut from a published tag). */
  mode: ReleaseBranchMode;
  /** Routine: QA's pin SHA. Hotfix: the published `vX.Y.Z` tag the branch starts from. */
  base: string;
  /** The SHA QA's release check and the PM's OK named; the tip must equal it. */
  expectedSha: string;
}

const SNAPSHOT_FILES = /^(VERSION|(?:[^/]+\/)*package\.json)$/;

function run(cwd: string, command: string, args: string[], input?: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    input,
  }).trim();
}

function gitOk(cwd: string, args: string[]): boolean {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** `git patch-id --stable` of one commit, or undefined when it has no diff or cannot be read. */
export function gitPatchId(cwd: string, sha: string): string | undefined {
  try {
    const diff = execFileSync('git', ['diff-tree', '-p', '--no-color', '--full-index', sha], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const id = run(cwd, 'git', ['patch-id', '--stable'], diff).split(' ')[0];
    return /^[a-f0-9]{40}$/.test(id ?? '') ? id : undefined;
  } catch {
    return undefined;
  }
}

/** True only when `sha` is a commit that is an ancestor of (or equal to) `mainSha`; false on any error. */
export function gitIsAncestor(cwd: string, sha: string, mainSha: string): boolean {
  return (
    /^[a-f0-9]{40}$/.test(sha) &&
    gitOk(cwd, ['cat-file', '-e', `${sha}^{commit}`]) &&
    gitOk(cwd, ['merge-base', '--is-ancestor', sha, mainSha])
  );
}

/** Read every commit in `<base>..<head>`, oldest first, from a full local checkout. */
export function readReleaseBranchCommits(
  cwd: string,
  base: string,
  head: string
): ReleaseBranchCommit[] {
  const listed = run(cwd, 'git', ['rev-list', '--reverse', '--parents', `${base}..${head}`]);
  if (!listed) return [];
  return listed.split('\n').map((line) => {
    const [sha, ...parents] = line.split(' ');
    const names = run(cwd, 'git', [
      'diff-tree',
      '--no-commit-id',
      '--no-renames',
      '-r',
      '--name-status',
      sha,
    ]);
    const files = (names ? names.split('\n') : []).map((row): ReleaseBranchFile => {
      const [status, path] = row.split('\t');
      const file: ReleaseBranchFile = { path, status: status[0] as ReleaseBranchFile['status'] };
      if (SNAPSHOT_FILES.test(path) && parents.length === 1) {
        if (status !== 'A') file.before = run(cwd, 'git', ['show', `${parents[0]}:${path}`]);
        if (status !== 'D') file.after = run(cwd, 'git', ['show', `${sha}:${path}`]);
      }
      return file;
    });
    return {
      sha,
      parents,
      message: run(cwd, 'git', ['log', '-1', '--format=%B', sha]),
      patchId: gitPatchId(cwd, sha),
      files,
    };
  });
}

function api(cwd: string, path: string): unknown {
  return JSON.parse(run(cwd, 'gh', ['api', path]));
}

/** The trusted repository's current main tip, after its default branch is confirmed as main. */
export function trustedMainTip(cwd: string, repository: string): string {
  const repo = api(cwd, `repos/${repository}`) as { full_name?: unknown; default_branch?: unknown };
  const main = api(cwd, `repos/${repository}/branches/main`) as {
    name?: unknown;
    commit?: { sha?: unknown };
  };
  const sha = main?.commit?.sha;
  if (
    repo?.full_name !== repository ||
    repo?.default_branch !== 'main' ||
    main?.name !== 'main' ||
    typeof sha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(sha)
  )
    throw Error('The trusted release repository main branch is unavailable.');
  return sha;
}

/**
 * Prove a release-branch publish in place of the main-ancestor proof, and
 * return the publish-log block. Every read failure throws (fails closed).
 */
export function proveReleaseBranch(input: {
  root: string;
  repository: string;
  version: string;
  head: string;
  request: ReleaseBranchRequest;
}): string {
  const { root, repository, version, head, request } = input;
  assertReleaseBranchName(request.branch, version);
  assertReleaseBranchTip(
    api(root, `repos/${repository}/branches/${encodeURIComponent(request.branch)}`),
    request.branch,
    head,
    request.expectedSha
  );
  const mainSha = trustedMainTip(root, repository);
  run(root, 'git', ['fetch', '--no-tags', '--quiet', 'origin', 'main']);
  if (!gitOk(root, ['cat-file', '-e', `${mainSha}^{commit}`]))
    throw Error('The trusted main tip is not in this checkout yet; fetch main and retry.');
  let base: string;
  let baseLabel: string;
  if (request.mode === 'routine') {
    base = run(root, 'git', ['merge-base', head, mainSha]);
    assertRoutineBase(base, request.base);
    baseLabel = "QA's pin on main";
  } else {
    assertHotfixBaseTag(request.base, version);
    const ref = api(root, `repos/${repository}/git/ref/tags/${request.base}`) as {
      object?: { type?: unknown; sha?: unknown };
    };
    const annotated =
      ref?.object?.type === 'tag'
        ? api(root, `repos/${repository}/git/tags/${String(ref.object.sha)}`)
        : undefined;
    base = resolveTagCommit(request.base, ref, annotated);
    assertVersionOnNpm(
      run(root, 'npm', ['view', `dorkos@${request.base.slice(1)}`, 'version', '--json']),
      request.base.slice(1)
    );
    assertBaseIsAncestor(base, head, api(root, `repos/${repository}/compare/${base}...${head}`));
    baseLabel = `published tag ${request.base}`;
  }
  assertReleaseCherryPicks({
    version,
    commits: readReleaseBranchCommits(root, base, head),
    isMainAncestor: (sha) => gitIsAncestor(root, sha, mainSha),
    patchIdOf: (sha) => gitPatchId(root, sha),
  });
  return formatReleaseBranchLog({
    mode: request.mode,
    base,
    baseLabel,
    branch: request.branch,
    head,
    diffStat: run(root, 'git', ['diff', '--stat', `${base}..${head}`]),
    log: run(root, 'git', ['log', '--oneline', `${base}..${head}`]),
  });
}

/**
 * Parse the release-branch flags. Returns undefined when none are given, so
 * the main-ancestor path stays exactly as it was. Any partial set throws.
 */
export function parseReleaseBranchArgs(
  args: readonly string[]
): { request: ReleaseBranchRequest; root: string | undefined; rest: string[] } | undefined {
  const flags = new Map<string, string>();
  const rest: string[] = [];
  const names = ['--release-branch', '--mode', '--base', '--expected-sha', '--root'];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!names.includes(arg)) {
      rest.push(arg);
      continue;
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--') || flags.has(arg))
      throw Error(`${arg} needs exactly one value.`);
    flags.set(arg, value);
    i++;
  }
  if (!flags.size) return undefined;
  const branch = flags.get('--release-branch');
  const mode = flags.get('--mode');
  const base = flags.get('--base');
  const expectedSha = flags.get('--expected-sha');
  if (!branch || !base || !expectedSha || (mode !== 'routine' && mode !== 'hotfix'))
    throw Error(
      'A release-branch build needs --release-branch, --mode routine|hotfix, --base and --expected-sha.'
    );
  if (!/^[a-f0-9]{40}$/.test(expectedSha)) throw Error('--expected-sha must be a full SHA.');
  if (mode === 'routine' && !/^[a-f0-9]{40}$/.test(base))
    throw Error("--base must be QA's full pin SHA in routine mode.");
  if (mode === 'hotfix' && !/^v\d+\.\d+\.\d+$/.test(base))
    throw Error('--base must be a vX.Y.Z tag in hotfix mode.');
  return { request: { branch, mode, base, expectedSha }, root: flags.get('--root'), rest };
}
