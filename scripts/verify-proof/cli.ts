import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function commit(cwd: string, ref: string): { sha: string; tree: string } {
  const sha = git(cwd, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`);
  return { sha, tree: git(cwd, 'rev-parse', `${sha}^{tree}`) };
}

function proofDir(cwd: string): string {
  return path.join(
    git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
    'dorkos-verify-proof'
  );
}

const clean = (cwd: string): boolean =>
  git(cwd, 'status', '--porcelain', '--untracked-files=normal') === '';

/**
 * The real-CLI suite globs `pnpm verify` leaves to CI, one per line in
 * `scripts/ci/binary-test-glob.txt` (DOR-4501). Those suites spawn whichever Codex,
 * Claude or OpenCode binary the host has installed, so a local result says nothing
 * about the branch. `scripts/__tests__/binary-test-glob.test.ts` holds the file to
 * the excludes CI's shards use.
 *
 * @param root - The repository root holding `scripts/ci/binary-test-glob.txt`.
 * @returns The globs in file order, without blank lines or `#` comments.
 */
export function readBinaryTestGlobs(root: string): string[] {
  return readFileSync(path.join(root, 'scripts/ci/binary-test-glob.txt'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/**
 * Run the existing gates once; only the unchanged, clean commit earns a proof.
 *
 * @param cwd - The checkout to verify.
 * @param verify - Runs the gates with the given test-file excludes and returns their exit code.
 * @param excluded - Test-file globs the gates skip; recorded in the proof so it states its coverage.
 * @returns The gates' exit code.
 */
export function runVerification(
  cwd: string,
  verify: (excluded: readonly string[]) => number,
  excluded: readonly string[] = []
): number {
  const before = commit(cwd, 'HEAD');
  const dir = proofDir(cwd);
  const destination = path.join(dir, before.sha);
  const startedClean = clean(cwd);
  // A failed or interrupted rerun must not leave an earlier green behind.
  rmSync(destination, { force: true });
  const status = verify(excluded);
  if (status !== 0) return status;
  const after = commit(cwd, 'HEAD');
  if (!startedClean || !clean(cwd) || after.sha !== before.sha || after.tree !== before.tree) {
    console.warn(
      'pnpm verify passed; no proof recorded because HEAD or the working tree changed or was dirty'
    );
    return 0;
  }
  mkdirSync(dir, { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    writeFileSync(
      temporary,
      JSON.stringify({ ...before, excluded, passedAt: new Date().toISOString() }) + '\n'
    );
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
  return 0;
}

/** Check a local pass without running any verification commands. */
function check(cwd: string, ref: string, escape: boolean): number {
  let shortSha = ref.slice(0, 12);
  try {
    const { sha, tree } = commit(cwd, ref);
    shortSha = sha.slice(0, 12);
    const dir = proofDir(cwd);
    // The clean-tree rule lives at record time (runVerification). Checking judges only the
    // recorded proof against the commit's own tree, so it works from a checkout with
    // unrelated edits, such as the main checkout the arm script runs from.
    if (escape) {
      mkdirSync(dir, { recursive: true });
      appendFileSync(
        path.join(dir, 'escapes.jsonl'),
        JSON.stringify({
          sha,
          tree,
          // Unknown identity is refused (git config exits non-zero), never logged as blank.
          who: git(cwd, 'config', 'user.name'),
          // eslint-disable-next-line no-restricted-syntax -- scripts/ has no env.ts; the OS login is the audit fact itself
          user: process.env.USER || process.env.USERNAME || null,
          when: new Date().toISOString(),
        }) + '\n'
      );
      return 0;
    }
    const proof = JSON.parse(readFileSync(path.join(dir, sha), 'utf8'));
    if (
      proof.sha === sha &&
      proof.tree === tree &&
      typeof proof.passedAt === 'string' &&
      Number.isFinite(Date.parse(proof.passedAt)) &&
      // Proofs recorded before DOR-4501 carry no list; they excluded nothing, so they
      // covered at least as much as a new one and stay valid.
      (proof.excluded === undefined ||
        (Array.isArray(proof.excluded) &&
          proof.excluded.every((glob: unknown) => typeof glob === 'string')))
    )
      return 0;
  } catch {
    // Missing, unreadable, malformed, or mismatched proof is the same actionable refusal.
  }
  console.error(
    `no pnpm verify pass recorded for ${shortSha}; run pnpm verify, or pass --no-verify-proof`
  );
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ref, ...flags] = process.argv.slice(2);
  if (command === 'run' && ref === undefined) {
    // Read from this script's own repository, so the list matches the checks it ships with.
    const excluded = readBinaryTestGlobs(path.resolve(import.meta.dirname, '../..'));
    if (excluded.length > 0) {
      console.log(
        `pnpm verify leaves the host-binary tests to CI (scripts/ci/binary-test-glob.txt): ${excluded.join(', ')}`
      );
    }
    process.exitCode = runVerification(
      process.cwd(),
      (globs) => {
        // pnpm appends these to the end of verify:checks, which is the turbo test step,
        // and quotes each one so the shell never expands the glob.
        const result = spawnSync(
          process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
          ['run', 'verify:checks', ...globs.map((glob) => `--exclude=${glob}`)],
          {
            cwd: process.cwd(),
            stdio: 'inherit',
            // pnpm's child inherits the current environment, just as the old shell did.
          }
        );
        return result.status ?? 1;
      },
      excluded
    );
  } else if (command === 'run') {
    // A forced or filtered run is not the gate a proof stands for, so it is refused outright.
    console.error(
      `pnpm verify takes no arguments (got: ${process.argv.slice(3).join(' ')}); ` +
        'for a forced run use turbo run typecheck lint --force, or turbo run test --force -- --run'
    );
    process.exitCode = 2;
  } else if (command === 'check' && ref && flags.every((flag) => flag === '--no-verify-proof')) {
    process.exitCode = check(process.cwd(), ref, flags.includes('--no-verify-proof'));
  } else {
    console.error('usage: node scripts/verify-proof/cli.ts run | check <sha> [--no-verify-proof]');
    process.exitCode = 2;
  }
}
