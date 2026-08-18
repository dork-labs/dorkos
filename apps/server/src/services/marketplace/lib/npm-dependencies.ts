/**
 * npm dependency installation for marketplace packages.
 *
 * Some marketplace packages ship runtime code that imports from npm — the
 * `/flow` plugin's scripts import `zod`, for example. Copying those files onto
 * disk is not enough: without a `node_modules` beside them, the very first
 * `node --experimental-strip-types <plugin>/scripts/dispatch.ts` dies with
 * `ERR_MODULE_NOT_FOUND` and the person has to discover `npm install` on their
 * own (DOR-1341).
 *
 * This module closes that gap. {@link readNpmDependencies} reads the
 * `dependencies` map from the package root's `package.json` — the permission
 * preview uses it to disclose the libraries and their versions BEFORE the
 * person approves a network fetch — and {@link installStagedNpmDependencies}
 * runs npm inside the staging directory during the install transaction, so the
 * libraries land atomically with the rest of the package.
 *
 * Two rules govern how npm is run:
 *
 * - **`--ignore-scripts` is not optional.** Installing a package must never
 *   execute a dependency's lifecycle code. The person approved a file copy and
 *   a library download, not arbitrary code from a transitive dependency. npm
 *   reads a project `.npmrc` from its cwd, and here that directory's contents
 *   were authored by a stranger — so the fact that a command-line flag outranks
 *   every config file is what makes this hold, and it is pinned by a test that
 *   ships a hostile `.npmrc` and a postinstall against the real npm rather than
 *   a stub.
 * - **A dependency problem warns, it does not fail the install.** The package's
 *   own files are useful without its libraries (commands, skills and docs all
 *   work), and a rollback would take those away over a missing `npm` binary or
 *   an offline registry. The failure comes back as a warning on the install
 *   result instead, naming the exact command to run by hand.
 *
 * @module services/marketplace/lib/npm-dependencies
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '@dorkos/shared/logger';

/** How long one dependency install may run before it is killed. */
export const NPM_INSTALL_TIMEOUT_MS = 120_000;

/** A single npm dependency a package declares, as written in its package.json. */
export interface NpmDependency {
  /** Package name on the npm registry (e.g. `zod`). */
  name: string;
  /** Version range exactly as declared (e.g. `^4.3.6`). */
  range: string;
}

/** A fully-resolved npm invocation: what to run, with which arguments, where. */
export interface NpmInstallCommand {
  /** Executable name — `npm.cmd` on Windows, `npm` everywhere else. */
  command: string;
  /** Arguments, including the non-negotiable `--ignore-scripts`. */
  args: string[];
  /** Directory npm runs in — the staged package root. */
  cwd: string;
}

/** The outcome of one npm invocation. */
export type NpmInstallOutcome =
  | { ok: true }
  /**
   * `npm-not-found` means the machine has no npm at all, which deserves
   * different wording than an install that ran and failed.
   */
  | { ok: false; reason: 'npm-not-found' | 'failed'; detail: string };

/**
 * Runs one {@link NpmInstallCommand}. Injected so tests can assert the exact
 * invocation without a registry round-trip; {@link installStagedNpmDependencies}
 * defaults to the real `spawn`-backed runner.
 */
export type NpmInstallRunner = (command: NpmInstallCommand) => Promise<NpmInstallOutcome>;

/**
 * Build the npm invocation for a staged package directory.
 *
 * `--omit=dev` keeps build-time tooling out of an installed package;
 * `--ignore-scripts` blocks lifecycle code execution; `--no-audit --no-fund
 * --loglevel=error` keep the output down to what actually went wrong.
 *
 * @param dir - Absolute path to the staged package root (npm's cwd).
 * @returns The command, arguments, and working directory to run.
 */
export function npmInstallCommand(dir: string): NpmInstallCommand {
  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: [
      'install',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
    ],
    cwd: dir,
  };
}

/**
 * Read the `dependencies` map from a package root's `package.json`.
 *
 * Only the package root is consulted — nested workspaces are deliberately not
 * chased, because a marketplace package is a single portable content tree and
 * a nested `package.json` is far more likely to be sample content than a second
 * thing to install.
 *
 * A missing, unreadable, or malformed `package.json` reads as "no
 * dependencies". This never throws: a package without npm dependencies is the
 * common case, and turning a bad file into an install failure would block a
 * package whose actual contents are fine.
 *
 * @param packageRoot - Absolute path to the package root directory.
 * @returns Every declared runtime dependency, in declaration order.
 */
export async function readNpmDependencies(packageRoot: string): Promise<NpmDependency[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf-8'));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const declared = (parsed as { dependencies?: unknown }).dependencies;
  if (!declared || typeof declared !== 'object') return [];

  const dependencies: NpmDependency[] = [];
  for (const [name, range] of Object.entries(declared as Record<string, unknown>)) {
    if (typeof range !== 'string') continue;
    dependencies.push({ name, range });
  }
  return dependencies;
}

/**
 * Install a staged package's npm dependencies, if it declares any.
 *
 * Called from the install transaction after staging and before the staged tree
 * is moved onto its target, so the `node_modules` it creates is activated by
 * the same atomic move as the rest of the package — and a package whose install
 * is rolled back never leaves one behind.
 *
 * Never throws. Every failure mode — no npm on the machine, a non-zero exit, a
 * timeout, even a bug in the runner — comes back as a single human-readable
 * warning naming the command to run by hand, which the install result carries
 * to the UI.
 *
 * @param opts - Staging directory, the path the package will end up at (named
 *   in the warning), a logger, and an optional runner override for tests.
 * @returns Zero warnings on success or when nothing needed installing; exactly
 *   one warning describing what went wrong otherwise.
 */
export async function installStagedNpmDependencies(opts: {
  /** Absolute path to the staged package root npm runs in. */
  stagingDir: string;
  /** Absolute path the package will be activated onto — quoted in the warning. */
  installPath: string;
  /** Logger for diagnostic output. */
  logger: Logger;
  /** Runner override. Defaults to the real `spawn`-backed runner. */
  run?: NpmInstallRunner;
}): Promise<string[]> {
  const dependencies = await readNpmDependencies(opts.stagingDir);
  if (dependencies.length === 0) return [];

  const command = npmInstallCommand(opts.stagingDir);
  opts.logger.info(
    `[marketplace/npm] Installing ${dependencies.length} npm dependenc${
      dependencies.length === 1 ? 'y' : 'ies'
    } for ${opts.installPath}`
  );

  let outcome: NpmInstallOutcome;
  try {
    outcome = await (opts.run ?? spawnNpmInstall)(command);
  } catch (err) {
    outcome = {
      ok: false,
      reason: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (outcome.ok) return [];

  const warning = formatDependencyWarning(outcome, opts.installPath);
  opts.logger.warn(`[marketplace/npm] ${warning} (${outcome.detail})`);
  return [warning];
}

/**
 * Turn a failed npm run into one sentence a non-developer can act on: what did
 * not happen, and the exact command that finishes the job.
 *
 * Only the first non-empty line of npm's output is quoted — npm's failures run
 * to dozens of lines of registry noise, and the first line is the one that says
 * what went wrong.
 */
function formatDependencyWarning(
  outcome: Extract<NpmInstallOutcome, { ok: false }>,
  installPath: string
): string {
  const remedy = `Run \`npm install --omit=dev\` in ${installPath} to finish setting it up.`;
  if (outcome.reason === 'npm-not-found') {
    return `DorkOS could not install this package's npm libraries because npm is not installed. ${remedy}`;
  }
  const firstLine = outcome.detail
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim();
  const because = firstLine ? ` (${firstLine})` : '';
  return `DorkOS could not install this package's npm libraries${because}. ${remedy}`;
}

/**
 * The real runner: spawn npm, capture its output, and bound how long it may
 * run. A `timeout` with `killSignal: 'SIGKILL'` guarantees a wedged install
 * cannot hang the transaction indefinitely — SIGTERM is not enough, because a
 * package manager mid-extraction can ignore it.
 *
 * `ENOENT` on spawn is reported as `npm-not-found` rather than as a generic
 * failure, because "you have no npm" and "npm tried and failed" need different
 * things said to the person reading the warning.
 */
async function spawnNpmInstall(command: NpmInstallCommand): Promise<NpmInstallOutcome> {
  return new Promise<NpmInstallOutcome>((resolve) => {
    let stderr = '';
    let stdout = '';
    let settled = false;
    const finish = (outcome: NpmInstallOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NPM_INSTALL_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.once('error', (err: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        reason: err.code === 'ENOENT' ? 'npm-not-found' : 'failed',
        detail: err.message,
      });
    });

    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) return finish({ ok: true });
      if (signal === 'SIGKILL') {
        return finish({
          ok: false,
          reason: 'failed',
          detail: `npm install took longer than ${Math.round(NPM_INSTALL_TIMEOUT_MS / 1000)} seconds and was stopped`,
        });
      }
      finish({
        ok: false,
        reason: 'failed',
        detail: stderr.trim() || stdout.trim() || `npm exited with code ${code}`,
      });
    });
  });
}
