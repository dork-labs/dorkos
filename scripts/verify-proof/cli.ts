import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Types only: `check` must run from a lone copy of this file, which is how the arm
// script runs it (it copies main's cli.ts by itself), so the preopen planner and the
// turbo summary check are loaded only when a run asks for them.
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

/** How {@link runVerification} judges a run beyond its exit code. */
export interface VerificationOptions {
  /**
   * Which gate this is (default `full`). Each level writes, and clears on a rerun, only
   * its own file, so a preopen run can never remove or replace a full proof.
   */
  level?: ProofLevel;
  /**
   * Asked only once the gates exit 0: why the run still did not finish (a signal
   * stopped it, or a turbo step left tasks unfinished), or `undefined` when it did.
   * An exit code of 0 alone is not proof (DOR-4616).
   */
  unfinished?: () => string | undefined;
}

/**
 * Run the existing gates once; only the unchanged, clean commit earns a proof.
 *
 * @param cwd - The checkout to verify.
 * @param verify - Runs the gates with the given test-file excludes and returns their exit code.
 * @param excluded - Test-file globs the gates skip; recorded in the proof so it states its coverage.
 * @param options - Which gate this is, and how to tell that it finished.
 * @returns The gates' exit code, or 1 when they exited 0 without finishing.
 */
export async function runVerification(
  cwd: string,
  verify: (excluded: readonly string[]) => number | Promise<number>,
  excluded: readonly string[] = [],
  { level = 'full', unfinished = () => undefined }: VerificationOptions = {}
): Promise<number> {
  const before = commit(cwd, 'HEAD');
  const dir = proofDir(cwd);
  const destination = proofFile(dir, before.sha, level);
  const startedClean = clean(cwd);
  // A failed or interrupted rerun must not leave an earlier green behind.
  rmSync(destination, { force: true });
  const status = await verify(excluded);
  if (status !== 0) return status;
  const why = unfinished();
  if (why !== undefined) {
    console.error(`${gateName(level)} exited 0 but did not finish (${why}); no proof recorded`);
    return 1;
  }
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
 * The escape exists at the full level only (checkFlags refuses it with `preopen`), so
 * every line in escapes.jsonl is an escape from the full-level check, whether it was
 * made at PR open or at arming.
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

/** What `check`'s flags asked for, or the line that explains why they were refused. */
type CheckFlags = { escape: boolean; level: ProofLevel } | { refusal: string };

/** Parse `check`'s flags; `undefined` means they were not ones it takes. */
function checkFlags(flags: readonly string[]): CheckFlags | undefined {
  let escape = false;
  let level: ProofLevel = 'full';
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === '--no-verify-proof') escape = true;
    else if (flag === '--level' && (flags[i + 1] === 'full' || flags[i + 1] === 'preopen')) {
      level = flags[++i] as ProofLevel;
    } else return undefined;
  }
  if (escape && level === 'preopen') {
    return {
      refusal: '--no-verify-proof escapes the full check only; drop --level preopen to use it',
    };
  }
  return { escape, level };
}

/**
 * Whether this module is the program node was asked to run. Both sides are real paths:
 * node resolves the main module's symlinks for `import.meta.url` but leaves argv as
 * typed, so a copy reached through a symlink (macOS's tmpdir is one) would otherwise
 * never run at all and exit 0, which reads as a pass.
 */
function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/** What {@link stoppableRunner} returns: how to run pnpm, and what stopped the run. */
interface StoppableRunner {
  /** Run pnpm with these arguments; resolves to its exit code, or 128+n once a signal arrived. */
  pnpm(pnpmArgs: readonly string[]): Promise<number>;
  /** The first stopping signal that reached this process, if one did. */
  stoppedBy(): NodeJS.Signals | undefined;
}

/** The exit code a shell reports for a process a signal ended: 128 plus its number. */
const signalStatus = (signal: NodeJS.Signals): number => 128 + osConstants.signals[signal];

/**
 * Run the gate's commands so a signal can never end in a proof (DOR-4616). TERM, HUP
 * and INT are caught for the whole run, the first one is remembered, and the running
 * command then reports 128+n whatever it exits with (turbo answers a signal by
 * shutting down and exiting 0), and no other starts. TERM and HUP are passed on to it;
 * INT is not, because a terminal sends it to the whole process group, so the command
 * already has it, and a second one turns turbo's graceful stop into a forced kill.
 */
function stoppableRunner(): StoppableRunner {
  let stopped: NodeJS.Signals | undefined;
  let running: ChildProcess | undefined;
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
    process.on(signal, () => {
      stopped ??= signal;
      if (signal !== 'SIGINT') running?.kill(signal);
    });
  }
  return {
    pnpm: (pnpmArgs) =>
      new Promise((resolve) => {
        // A preopen run stopped between two steps starts no more of them.
        if (stopped) {
          resolve(signalStatus(stopped));
          return;
        }
        // pnpm's child inherits the current environment, just as the old shell did.
        const child = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', pnpmArgs, {
          cwd: process.cwd(),
          stdio: 'inherit',
        });
        running = child;
        const settle = (status: number) => {
          running = undefined;
          resolve(stopped ? signalStatus(stopped) : status);
        };
        child.on('error', () => settle(1));
        child.on('close', (code, signal) => settle(code ?? (signal ? signalStatus(signal) : 1)));
      }),
    stoppedBy: () => stopped,
  };
}

/**
 * How many turbo runs each gate makes, every one with `--summarize`: `verify:checks`
 * has the typecheck-and-lint step and the test step, and preopen has only the first
 * (`verify:preopen:turbo`). scripts/__tests__/verify-proof.test.ts holds these to
 * package.json.
 */
const TURBO_RUNS: Record<ProofLevel, number> = { full: 2, preopen: 1 };

/**
 * Run one gate to its proof, refusing a run that a signal stopped or whose turbo steps
 * did not finish every task.
 */
async function runGate(
  level: ProofLevel,
  verify: (runner: StoppableRunner, excluded: readonly string[]) => Promise<number>,
  excluded: readonly string[] = []
): Promise<number> {
  const cwd = process.cwd();
  const { watchTurboRuns } = await import('./turbo-runs.ts');
  const turbo = watchTurboRuns(git(cwd, 'rev-parse', '--show-toplevel'), TURBO_RUNS[level]);
  const runner = stoppableRunner();
  const status = await runVerification(cwd, (globs) => verify(runner, globs), excluded, {
    level,
    unfinished: () => {
      const signal = runner.stoppedBy();
      return signal ? `stopped by ${signal}` : turbo.unfinished();
    },
  });
  const signal = runner.stoppedBy();
  if (!signal) return status;
  console.error(`${gateName(level)} was stopped by ${signal}; no proof recorded`);
  return signalStatus(signal);
}

if (isMain()) {
  const [command, ...args] = process.argv.slice(2);
  // Read from this script's own repository, so the lists match the checks it ships with.
  const root = path.resolve(import.meta.dirname, '../..');
  // A forced or filtered run is not the gate a proof stands for, so it is refused
  // outright. Each gate has its own command, so `pnpm verify --preopen` is refused too,
  // and the message shows only what the person typed after the script name.
  const refuseArguments = (gate: string) => {
    console.error(
      `${gate} takes no arguments (got: ${args.join(' ')}); ` +
        'for a forced run use turbo run typecheck lint --force, or turbo run test --force -- --run'
    );
    process.exitCode = 2;
  };
  if (command === 'run' && args.length > 0) refuseArguments('pnpm verify');
  else if (command === 'run-preopen' && args.length > 0) refuseArguments('pnpm verify:preopen');
  else if (command === 'run') {
    const excluded = readBinaryTestGlobs(root);
    if (excluded.length > 0) {
      console.log(
        `pnpm verify leaves the host-binary tests to CI (scripts/ci/binary-test-glob.txt): ${excluded.join(', ')}`
      );
    }
    // pnpm appends these to the end of verify:checks, which is the turbo test step,
    // and quotes each one so the shell never expands the glob.
    process.exitCode = await runGate(
      'full',
      (runner, globs) =>
        runner.pnpm(['run', 'verify:checks', ...globs.map((glob) => `--exclude=${glob}`)]),
      excluded
    );
  } else if (command === 'run-preopen') {
    const { planPreopen, runPreopen } = await import('./preopen.ts');
    process.exitCode = await runGate('preopen', async (runner) => {
      let steps: PreopenStep[];
      try {
        steps = planPreopen(process.cwd(), root);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 2;
      }
      console.log(
        `pnpm verify:preopen runs ${steps.map((step) => step.name).join(', ')}; ` +
          'the package tests are left to CI, and arming never reads this proof'
      );
      return runPreopen(steps, (step) => runner.pnpm(step.args));
    });
  } else {
    const [ref, ...flags] = args;
    const parsed = command === 'check' && ref ? checkFlags(flags) : undefined;
    if (parsed && 'refusal' in parsed) {
      console.error(parsed.refusal);
      process.exitCode = 2;
    } else if (parsed && ref) {
      process.exitCode = check(process.cwd(), ref, parsed.escape, parsed.level);
    } else {
      console.error(
        'usage: node scripts/verify-proof/cli.ts run | run-preopen | ' +
          'check <sha> [--level full|preopen] [--no-verify-proof]'
      );
      process.exitCode = 2;
    }
  }
}
