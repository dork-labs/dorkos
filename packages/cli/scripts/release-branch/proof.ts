/**
 * Reads the facts a release-branch publish rests on (local git, `gh api`, npm)
 * and runs the pure rules in `rules.ts` over them (DOR-4638). Node builtins
 * only, so the Release Publish workflow runs it with no install:
 *
 *   node proof.ts <root> <repo> <version> <head> <branch> <mode> <base> <expected-sha>
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * A commit's patch fingerprint, or undefined when it has no diff or cannot be read.
 *
 * Like `git patch-id --stable` it ignores line numbers and blob ids, so a clean
 * pick onto another base matches its source. Unlike it, it keeps whitespace
 * (patch-id drops it, so a pick could change a string or a YAML indent and still
 * match) and binary contents (patch-id sees only "Binary files differ").
 */
export function gitPatchId(cwd: string, sha: string): string | undefined {
  try {
    const diff = execFileSync(
      'git',
      [
        '-c',
        'diff.noprefix=false',
        '-c',
        'diff.mnemonicPrefix=false',
        'diff-tree',
        '-p',
        '--no-commit-id',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--full-index',
        '--binary',
        sha,
      ],
      // Raw bytes: decoding as UTF-8 would fold different invalid bytes into one
      // U+FFFD. The user's global git config is ignored, so every machine agrees.
      { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }
    );
    return patchFingerprint(diff);
  } catch {
    return undefined;
  }
}

/** Hash a unified diff with hunk line numbers and blob ids removed and every other byte kept. */
export function patchFingerprint(diff: Uint8Array | string): string | undefined {
  const bytes = typeof diff === 'string' ? Buffer.from(diff, 'utf8') : Buffer.from(diff);
  const hash = createHash('sha256');
  let sawFile = false;
  for (let start = 0; start <= bytes.length;) {
    let end = bytes.indexOf(0x0a, start);
    if (end < 0) end = bytes.length;
    const line = bytes.subarray(start, end);
    start = end + 1;
    if (startsWith(line, 'index ')) continue;
    if (startsWith(line, 'diff --git ')) sawFile = true;
    hash.update(startsWith(line, '@@ ') ? Buffer.from('@@') : line);
    hash.update(Buffer.from([0x0a]));
  }
  return sawFile ? hash.digest('hex') : undefined;
}

function startsWith(line: Uint8Array, prefix: string): boolean {
  return Buffer.from(line).subarray(0, prefix.length).equals(Buffer.from(prefix, 'utf8'));
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

/** The outside reads a proof makes; tests swap them for recorded `gh api` and npm answers. */
export interface ReleaseBranchReads {
  /** `gh api <path>`, parsed. */
  api: (path: string) => unknown;
  /** `npm view <spec> version --json`, raw. */
  npmView: (spec: string) => string;
  /** Fetch main from origin so the trusted main tip is in the checkout. */
  fetchMain: () => void;
}

/** The real reads, run from `cwd`. */
export function liveReads(cwd: string): ReleaseBranchReads {
  return {
    api: (path) => JSON.parse(run(cwd, 'gh', ['api', path])),
    // From a neutral folder against the public registry: the checkout is not
    // proven yet, and its own .npmrc could point npm somewhere else.
    npmView: (spec) =>
      run(tmpdir(), 'npm', [
        'view',
        spec,
        'version',
        '--json',
        '--registry=https://registry.npmjs.org/',
        '--userconfig=/dev/null',
      ]),
    fetchMain: () => void run(cwd, 'git', ['fetch', '--no-tags', '--quiet', 'origin', 'main']),
  };
}

/** The trusted repository's current main tip, after its default branch is confirmed as main. */
export function trustedMainTip(
  cwd: string,
  repository: string,
  api: ReleaseBranchReads['api'] = liveReads(cwd).api
): string {
  const repo = api(`repos/${repository}`) as { full_name?: unknown; default_branch?: unknown };
  const main = api(`repos/${repository}/branches/main`) as {
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
  reads?: ReleaseBranchReads;
}): string {
  const { root, repository, version, head, request } = input;
  const { api, npmView, fetchMain } = input.reads ?? liveReads(root);
  assertReleaseBranchName(request.branch, version);
  // The name is regex-checked above; GitHub takes the slash in the path as is.
  assertReleaseBranchTip(
    api(`repos/${repository}/branches/${request.branch}`),
    request.branch,
    head,
    request.expectedSha
  );
  const mainSha = trustedMainTip(root, repository, api);
  fetchMain();
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
    const ref = api(`repos/${repository}/git/ref/tags/${request.base}`) as {
      object?: { type?: unknown; sha?: unknown };
    };
    const annotated =
      ref?.object?.type === 'tag'
        ? api(`repos/${repository}/git/tags/${String(ref.object.sha)}`)
        : undefined;
    base = resolveTagCommit(request.base, ref, annotated);
    assertVersionOnNpm(npmView(`dorkos@${request.base.slice(1)}`), request.base.slice(1));
    assertBaseIsAncestor(base, head, api(`repos/${repository}/compare/${base}...${head}`));
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

function main(args: readonly string[]): void {
  const [root, repository, version, head, ...flags] = args;
  if (!root || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !head)
    throw Error(
      'Usage: proof.ts <root> <repo> <version> <head> <branch> <mode> <base> <expected-sha>'
    );
  const [branch, mode, base, expectedSha] = flags;
  const parsed = parseReleaseBranchArgs([
    '--release-branch',
    branch ?? '',
    '--mode',
    mode ?? '',
    '--base',
    base ?? '',
    '--expected-sha',
    expectedSha ?? '',
  ]);
  if (!parsed || flags.length !== 4) throw Error('The release-branch proof needs all four values.');
  if (head !== run(root, 'git', ['rev-parse', 'HEAD']))
    throw Error('The checkout is not at the release commit being proved.');
  printUnescaped(proveReleaseBranch({ root, repository, version, head, request: parsed.request }));
}

/**
 * Print text that quotes commit subjects. In GitHub Actions a subject could
 * otherwise be read as a workflow command (`::error::`, `::add-mask::`), so
 * command processing is paused around it with a one-time token.
 */
export function printUnescaped(text: string): void {
  if (process.env.GITHUB_ACTIONS !== 'true') return void console.log(text);
  const token = randomUUID();
  console.log(`::stop-commands::${token}`);
  console.log(text);
  console.log(`::${token}::`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
