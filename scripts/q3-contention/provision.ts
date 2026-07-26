/**
 * Throwaway state for the Q3 contention harness (DOR-500), and the safety
 * assertions that make it impossible to aim the run at anything real.
 *
 * Everything the run mutates lives under one `runRoot` inside the OS temp
 * directory: the server's `DORK_HOME`, the throwaway git repository, its
 * worktrees, and the canary files. Nothing outside `runRoot` is created,
 * written, or deleted — in particular the harness never runs `git worktree add`
 * against a real checkout, because that would mutate its `.git`.
 *
 * {@link assertSafeRunRoot} runs BEFORE anything is created and again before
 * anything is deleted. It is deliberately loud and deliberately paranoid.
 *
 * @module scripts/q3-contention/provision
 */
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type { RunPlan, TreeId } from './plan.js';

const exec = promisify(execFile);

/** Absolute paths for one run's throwaway state. */
export interface RunPaths {
  /** Root of everything the run may touch. Always inside the OS temp dir. */
  readonly runRoot: string;
  /** The server's DORK_HOME for this run. */
  readonly dorkHome: string;
  /** The throwaway git repository the worktrees hang off. */
  readonly baseRepo: string;
  /** Worktree path by tree id. */
  readonly trees: Readonly<Record<TreeId, string>>;
  /** Canary file path by tree id (one shared canary per worktree). */
  readonly canaries: Readonly<Record<TreeId, string>>;
  /** Where CSVs, logs, and canary copies are written. NOT deleted on teardown. */
  readonly outDir: string;
  /** Identifier for this run, used in the output path. */
  readonly runId: string;
}

/** Canary filename inside each worktree. */
const CANARY_FILE = 'q3-canary.log';

/**
 * Resolve symlinks where possible so `/var` vs `/private/var` (macOS) cannot
 * defeat a prefix check. Falls back to a lexical resolve for paths that do not
 * exist yet.
 */
async function realpathOrResolve(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

/** True when `child` is `parent` or sits underneath it. */
function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

/**
 * Refuse to proceed unless the run root is unmistakably throwaway.
 *
 * Called before provisioning AND before deletion, so neither path can be aimed
 * at the operator's real state by a bad flag, a stale variable, or a symlink.
 *
 * @param runRoot - Candidate root for the run's throwaway state.
 * @param repoRoot - The checkout the harness is running from, which must stay untouched.
 * @returns The realpath-resolved run root, safe to create and later delete.
 * @throws With a loud explanation if the root is not inside the OS temp dir, or
 *   sits inside the home directory, the real `~/.dork`, or the repo checkout.
 */
export async function assertSafeRunRoot(runRoot: string, repoRoot: string): Promise<string> {
  const resolved = path.resolve(runRoot);
  const tmpRoot = await realpathOrResolve(os.tmpdir());
  const home = await realpathOrResolve(os.homedir());
  const repo = await realpathOrResolve(repoRoot);
  // The run root usually does not exist yet; resolve its nearest existing
  // ancestor instead so a symlinked temp dir still compares correctly.
  const anchor = await realpathOrResolve(path.dirname(resolved));
  const candidate = path.join(anchor, path.basename(resolved));

  const failures: string[] = [];
  if (!isInside(candidate, tmpRoot)) {
    failures.push(`not inside the OS temp directory (${tmpRoot})`);
  }
  if (isInside(candidate, path.join(home, '.dork'))) {
    failures.push(`inside the real DorkOS home (${path.join(home, '.dork')})`);
  }
  if (isInside(candidate, repo)) {
    failures.push(`inside the repo checkout (${repo})`);
  }
  if (candidate === home || candidate === tmpRoot || candidate === path.parse(candidate).root) {
    failures.push('is the home directory, the temp root itself, or the filesystem root');
  }

  if (failures.length > 0) {
    throw new Error(
      `[q3] REFUSING TO RUN — the run root "${candidate}" is ${failures.join('; ')}. ` +
        `This harness only ever creates and deletes state inside the OS temp directory.`
    );
  }
  return candidate;
}

/** Run a git command inside `cwd`, with identity and hooks pinned off. */
async function git(cwd: string, args: readonly string[]): Promise<void> {
  await exec(
    'git',
    [
      '-c',
      'user.name=q3-harness',
      '-c',
      'user.email=q3@localhost',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd }
  );
}

/**
 * Create the run's throwaway state: temp root, DORK_HOME, a fresh git
 * repository, and one worktree per tree the plan needs, each seeded with an
 * empty tracked canary file.
 *
 * The repository is created with `git init` inside the run root — the harness
 * never attaches a worktree to a real checkout, so a crashed run can leave no
 * worktree metadata behind in anyone's `.git`.
 *
 * @param plan - The resolved run plan.
 * @param repoRoot - The checkout the harness runs from (asserted untouched).
 * @returns Every path the run may use.
 */
export async function provision(plan: RunPlan, repoRoot: string): Promise<RunPaths> {
  const runId = `arm${plan.arm}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const runRoot = await assertSafeRunRoot(path.join(os.tmpdir(), `dorkos-q3-${runId}`), repoRoot);

  const dorkHome = path.join(runRoot, 'dork-home');
  const baseRepo = path.join(runRoot, 'trees', 'base');
  const trees = {} as Record<TreeId, string>;
  const canaries = {} as Record<TreeId, string>;

  await fs.mkdir(dorkHome, { recursive: true });
  await fs.mkdir(baseRepo, { recursive: true });

  await git(baseRepo, ['init', '-q', '-b', 'base', '.']);
  await fs.writeFile(path.join(baseRepo, CANARY_FILE), '', 'utf8');
  await fs.writeFile(path.join(baseRepo, 'README'), 'Throwaway tree for the Q3 harness.\n', 'utf8');
  await git(baseRepo, ['add', '-A']);
  await git(baseRepo, ['commit', '-q', '-m', 'seed']);

  for (const tree of plan.trees) {
    const treePath = path.join(runRoot, 'trees', tree);
    await git(baseRepo, ['worktree', 'add', '-q', '-b', `q3-${tree}`, treePath]);
    trees[tree] = treePath;
    canaries[tree] = path.join(treePath, CANARY_FILE);
  }

  const outDir = plan.outDir ?? path.join(repoRoot, '.temp', 'q3-contention', runId);
  await fs.mkdir(outDir, { recursive: true });

  return { runRoot, dorkHome, baseRepo, trees, canaries, outDir, runId };
}

/**
 * Delete the run's throwaway state, re-asserting the safety guard first.
 *
 * Never touches `outDir` — the CSVs and canary copies are the run's product and
 * outlive it.
 *
 * @param paths - Paths from {@link provision}.
 * @param repoRoot - The checkout the harness runs from.
 * @param keep - When true, log the location and leave everything on disk.
 */
export async function teardownRunRoot(
  paths: RunPaths,
  repoRoot: string,
  keep: boolean
): Promise<void> {
  if (keep) {
    console.log(`[q3] --keep: leaving throwaway state at ${paths.runRoot}`);
    return;
  }
  // Re-assert immediately before the destructive call: the guard is cheap and
  // the alternative is an rm -rf aimed by a variable nobody re-checked.
  await assertSafeRunRoot(paths.runRoot, repoRoot);
  await fs.rm(paths.runRoot, { recursive: true, force: true });
}

/**
 * Build the `DORKOS_Q3_CANARY_MAP` value: every agent's vocabulary pointed at
 * the canary of the worktree it runs in. One canary per tree is what makes arm
 * 2 a control — agents in different trees cannot lose each other's lines.
 *
 * @param plan - The resolved run plan.
 * @param paths - Paths from {@link provision}.
 * @returns JSON string for the server's `DORKOS_Q3_CANARY_MAP`.
 */
export function buildCanaryMap(plan: RunPlan, paths: RunPaths): string {
  const map: Record<string, string> = {};
  for (const agent of plan.agents) map[agent.vocab] = paths.canaries[agent.tree];
  return JSON.stringify(map);
}
