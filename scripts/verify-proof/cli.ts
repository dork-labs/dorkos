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
// Types only: `check` must run from a lone copy of this file, which is how the arm
// script runs it (it copies main's cli.ts by itself), so the preopen planner is
// loaded only when a preopen run asks for it.
import type { PreopenStep } from './preopen.ts';

/**
 * How much a proof stands for. `full` is `pnpm verify`, every step, and is the only
 * level arming accepts. `preopen` is `pnpm verify:preopen`, the lighter checks before
 * a PR opens (DOR-4728); it lives in its own file and never satisfies a full check.
 */
export type ProofLevel = 'full' | 'preopen';

/** The proof file for a commit at a level; the two never share a path. */
const proofFile = (dir: string, sha: string, level: ProofLevel): string =>
  path.join(dir, level === 'full' ? sha : `${sha}.preopen`);

const gateName = (level: ProofLevel): string =>
  level === 'full' ? 'pnpm verify' : 'pnpm verify:preopen';

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
 * @param level - Which gate this is. Each level writes, and clears on a rerun, only its
 *   own file, so a preopen run can never remove or replace a full proof.
 * @returns The gates' exit code.
 */
export function runVerification(
  cwd: string,
  verify: (excluded: readonly string[]) => number,
  excluded: readonly string[] = [],
  level: ProofLevel = 'full'
): number {
  const before = commit(cwd, 'HEAD');
  const dir = proofDir(cwd);
  const destination = proofFile(dir, before.sha, level);
  const startedClean = clean(cwd);
  // A failed or interrupted rerun must not leave an earlier green behind.
  rmSync(destination, { force: true });
  const status = verify(excluded);
  if (status !== 0) return status;
  const after = commit(cwd, 'HEAD');
  if (!startedClean || !clean(cwd) || after.sha !== before.sha || after.tree !== before.tree) {
    console.warn(
      `${gateName(level)} passed; no proof recorded because HEAD or the working tree changed or was dirty`
    );
    return 0;
  }
  mkdirSync(dir, { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    writeFileSync(
      temporary,
      JSON.stringify({ ...before, level, excluded, passedAt: new Date().toISOString() }) + '\n'
    );
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
  return 0;
}

/**
 * Whether a parsed proof file is a pass for this commit at exactly this level.
 * A proof with no `level` predates DOR-4728, when every proof was a full one.
 */
function isPass(proof: unknown, sha: string, tree: string, level: ProofLevel): boolean {
  if (typeof proof !== 'object' || proof === null) return false;
  const record = proof as Record<string, unknown>;
  return (
    (level === 'full'
      ? record.level === undefined || record.level === 'full'
      : record.level === 'preopen') &&
    record.sha === sha &&
    record.tree === tree &&
    typeof record.passedAt === 'string' &&
    Number.isFinite(Date.parse(record.passedAt)) &&
    // Proofs recorded before DOR-4501 carry no list; they excluded nothing, so they
    // covered at least as much as a new one and stay valid.
    (record.excluded === undefined ||
      (Array.isArray(record.excluded) &&
        record.excluded.every((glob: unknown) => typeof glob === 'string')))
  );
}

/** Read one proof file; anything missing or unreadable reads as no proof. */
function readProof(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Check a local pass without running any verification commands. The default `full`
 * level, which arming uses, reads only the full proof. `preopen` also accepts the
 * commit's preopen proof, since a full pass covers everything a preopen one does.
 */
function check(cwd: string, ref: string, escape: boolean, level: ProofLevel): number {
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
          // An escape from the lighter check says so; a full escape keeps its old shape.
          ...(level === 'preopen' ? { level } : {}),
        }) + '\n'
      );
      return 0;
    }
    if (isPass(readProof(proofFile(dir, sha, 'full')), sha, tree, 'full')) return 0;
    if (
      level === 'preopen' &&
      isPass(readProof(proofFile(dir, sha, 'preopen')), sha, tree, 'preopen')
    )
      return 0;
  } catch {
    // Missing, unreadable, malformed, or mismatched proof is the same actionable refusal.
  }
  console.error(
    level === 'full'
      ? `no pnpm verify pass recorded for ${shortSha}; run pnpm verify, or pass --no-verify-proof`
      : `no pnpm verify:preopen or pnpm verify pass recorded for ${shortSha}; ` +
          'run pnpm verify:preopen, or pass --no-verify-proof'
  );
  return 1;
}

/** Parse `check`'s flags; `undefined` means they were not ones it takes. */
function checkFlags(flags: readonly string[]): { escape: boolean; level: ProofLevel } | undefined {
  let escape = false;
  let level: ProofLevel = 'full';
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === '--no-verify-proof') escape = true;
    else if (flag === '--level' && (flags[i + 1] === 'full' || flags[i + 1] === 'preopen')) {
      level = flags[++i] as ProofLevel;
    } else return undefined;
  }
  return { escape, level };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ref, ...flags] = process.argv.slice(2);
  // Read from this script's own repository, so the lists match the checks it ships with.
  const root = path.resolve(import.meta.dirname, '../..');
  const pnpm = (args: readonly string[]): number =>
    // pnpm's child inherits the current environment, just as the old shell did.
    spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, {
      cwd: process.cwd(),
      stdio: 'inherit',
    }).status ?? 1;
  const parsed = command === 'check' ? checkFlags(flags) : undefined;
  if (command === 'run' && ref === undefined) {
    const excluded = readBinaryTestGlobs(root);
    if (excluded.length > 0) {
      console.log(
        `pnpm verify leaves the host-binary tests to CI (scripts/ci/binary-test-glob.txt): ${excluded.join(', ')}`
      );
    }
    // pnpm appends these to the end of verify:checks, which is the turbo test step,
    // and quotes each one so the shell never expands the glob.
    process.exitCode = runVerification(
      process.cwd(),
      (globs) => pnpm(['run', 'verify:checks', ...globs.map((glob) => `--exclude=${glob}`)]),
      excluded
    );
  } else if (command === 'run' && ref === '--preopen' && flags.length === 0) {
    const { planPreopen, runPreopen } = await import('./preopen.ts');
    process.exitCode = runVerification(
      process.cwd(),
      () => {
        let steps: PreopenStep[];
        try {
          steps = planPreopen(process.cwd(), root);
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          return 2;
        }
        console.log(
          `pnpm verify:preopen runs ${steps.map((step) => step.name).join(', ')}; ` +
            'the package tests are left to CI, and this proof never arms a PR'
        );
        return runPreopen(steps, (step) => pnpm(step.args));
      },
      [],
      'preopen'
    );
  } else if (command === 'run') {
    // A forced or filtered run is not the gate a proof stands for, so it is refused outright.
    console.error(
      `pnpm verify takes no arguments (got: ${process.argv.slice(3).join(' ')}); ` +
        'for a forced run use turbo run typecheck lint --force, or turbo run test --force -- --run'
    );
    process.exitCode = 2;
  } else if (command === 'check' && ref && parsed) {
    process.exitCode = check(process.cwd(), ref, parsed.escape, parsed.level);
  } else {
    console.error(
      'usage: node scripts/verify-proof/cli.ts run [--preopen] | ' +
        'check <sha> [--level full|preopen] [--no-verify-proof]'
    );
    process.exitCode = 2;
  }
}
