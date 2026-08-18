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
 * This module closes that gap. {@link readNpmDependencies} reads the declared
 * dependencies from the package root's `package.json` — the permission preview
 * uses it to disclose the libraries and their versions BEFORE the person
 * approves a network fetch — and {@link installStagedNpmDependencies} runs npm
 * inside the staging directory during the install transaction, so the libraries
 * land atomically with the rest of the package.
 *
 * ## Containment
 *
 * Running a package manager inside a directory a stranger authored is the
 * dangerous part, and the staged tree gets a vote on how npm behaves in three
 * ways that all had to be closed. The model is the one `lib/stage-package.ts`
 * already applies to symlinks: strip the capability unconditionally rather than
 * reason about whether this particular use of it is benign.
 *
 * - **Command-line flags, not trust.** Only flags passed on the command line
 *   outrank config files, so the guarantees live in argv:
 *   `--ignore-scripts` (no lifecycle code from the package or any dependency of
 *   it), `--global=false` (npm may only write inside the staging directory) and
 *   `--no-workspaces` (only the package root is installed, matching what the
 *   preview disclosed).
 * - **The package's own `.npmrc` is deleted, never honoured.** A project
 *   `.npmrc` sits in npm's cwd — which here is a directory whose contents the
 *   package author chose. `global=true` in it turns a plain `npm install` into
 *   a global install OF THE PACKAGE ITSELF, planting bin shims (a shim named
 *   `git`, `claude` or `dorkos` runs attacker code the next time anyone types
 *   that command) with npm exiting 0 and nothing written inside the staging
 *   tree for a rollback to undo. `cache=` and `registry=` are equally
 *   available. `--global=false` alone would close the worst of it, but the file
 *   would still be sitting at the install root afterwards — where the remedy
 *   this module prints ("run `npm install` in <path>") would walk the person
 *   straight into it. So the file is removed from the staged root. The USER's
 *   own `~/.npmrc` is untouched: that is where private-registry auth lives.
 * - **npm re-introduces symlinks the staging copy stripped.** `stage-package.ts`
 *   strips every symlink out of the package (DOR-279), but a `file:` dependency
 *   makes npm create a fresh one — `node_modules/peek -> ../../../secretdir` —
 *   which is readable for as long as the staged tree lives. So after npm
 *   returns, every link under the staged `node_modules` whose real path leaves
 *   the staging directory is removed. npm's own `.bin` shims resolve inside the
 *   tree and survive.
 *
 * ## Failure policy
 *
 * A dependency problem warns, it does not fail the install. The package's own
 * files are useful without its libraries (commands, skills and docs all work),
 * and a rollback would take those away over a missing `npm` binary or an
 * offline registry. The failure comes back as a warning naming the exact
 * command to run by hand — and the half-written `node_modules` is removed
 * first, because a clean "not installed" is easier to reason about, and to
 * repair, than a partial tree that looks installed.
 *
 * @module services/marketplace/lib/npm-dependencies
 */
import { spawn } from 'node:child_process';
import { lstat, readdir, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '@dorkos/shared/logger';

/** How long one dependency install may run before it is killed. */
export const NPM_INSTALL_TIMEOUT_MS = 120_000;

/**
 * npm's project-level config file. Deleted from every staged package root — see
 * the module's containment notes for why a stranger's copy of this file is a
 * code-execution primitive rather than a preference.
 */
export const PACKAGE_NPMRC = '.npmrc';

/** A single npm dependency a package declares, as written in its package.json. */
export interface NpmDependency {
  /** Package name on the npm registry (e.g. `zod`). */
  name: string;
  /** Version range exactly as declared (e.g. `^4.3.6`). */
  range: string;
  /**
   * True for an `optionalDependencies` entry. npm installs these by default, so
   * they are disclosed like any other — flagged only so the preview can say
   * that this one is allowed to fail without failing the install.
   */
  optional?: boolean;
}

/** A fully-resolved npm invocation: what to run, with which arguments, where. */
export interface NpmInstallCommand {
  /** Executable name — `npm.cmd` on Windows, `npm` everywhere else. */
  command: string;
  /** Arguments. Every containment guarantee this module makes lives here. */
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
 * Three of these flags are security boundaries, not preferences, and a
 * command-line flag is the only kind of npm setting a package's own `.npmrc`
 * cannot override:
 *
 * - `--ignore-scripts` — no lifecycle code runs, from the package or any
 *   dependency of it.
 * - `--global=false` — npm may only write inside the staging directory. Without
 *   it, `global=true` in a package-shipped `.npmrc` installs the package itself
 *   into the machine's global prefix, bin shims and all.
 * - `--no-workspaces` — only the package root is installed, which is what the
 *   permission preview disclosed.
 *
 * The rest are hygiene: `--omit=dev` keeps build-time tooling out of an
 * installed package, and `--no-audit --no-fund --loglevel=error` cut the output
 * down to what actually went wrong.
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
      '--global=false',
      '--no-workspaces',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
    ],
    cwd: dir,
  };
}

/**
 * Read the dependencies a package declares from its root `package.json`.
 *
 * Both `dependencies` and `optionalDependencies` are returned, because npm
 * installs both by default and the preview would under-report the fetch by
 * naming only the first. Optional entries carry `optional: true`. `devDependencies`
 * are excluded, matching the `--omit=dev` the installer runs with.
 *
 * Only the package root is consulted — nested workspaces are deliberately not
 * chased, which is also what `--no-workspaces` enforces at install time, so the
 * preview and the install agree on what "this package's dependencies" means.
 *
 * A missing, unreadable, or malformed `package.json` reads as "no
 * dependencies". This never throws: a package without npm dependencies is the
 * common case, and turning a bad file into an install failure would block a
 * package whose actual contents are fine.
 *
 * @param packageRoot - Absolute path to the package root directory.
 * @returns Every declared runtime dependency, `dependencies` first, in
 *   declaration order. A name in both maps is reported once, as required.
 */
export async function readNpmDependencies(packageRoot: string): Promise<NpmDependency[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf-8'));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const manifest = parsed as { dependencies?: unknown; optionalDependencies?: unknown };

  const dependencies: NpmDependency[] = [];
  const seen = new Set<string>();
  const collect = (declared: unknown, optional: boolean): void => {
    if (!declared || typeof declared !== 'object') return;
    for (const [name, range] of Object.entries(declared as Record<string, unknown>)) {
      if (typeof range !== 'string' || seen.has(name)) continue;
      seen.add(name);
      dependencies.push(optional ? { name, range, optional: true } : { name, range });
    }
  };
  collect(manifest.dependencies, false);
  collect(manifest.optionalDependencies, true);
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
 * The package's `.npmrc` is deleted first, whether or not there is anything to
 * install, because that file is dangerous at the install root even when npm
 * never runs (see the module notes). On failure the partial `node_modules` is
 * removed; on success every symlink under it that escapes the staging directory
 * is removed.
 *
 * Never throws. Every failure mode — no npm on the machine, a non-zero exit, a
 * timeout, even a bug in the runner — comes back as a human-readable warning
 * naming the command to run by hand, which the install result carries to the UI
 * and the installed-package sidecar keeps afterwards.
 *
 * @param opts - Staging directory, the path the package will end up at (named
 *   in the warning), a logger, and an optional runner override for tests.
 * @returns Zero warnings on a clean install or when nothing needed installing;
 *   one warning per problem otherwise.
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
  // Unconditional, and before the "are there dependencies?" check: a package
  // that declares none can still ship a hostile `.npmrc`, and it would sit at
  // the install root waiting for the next person to run npm there by hand.
  await removePackageNpmrc(opts.stagingDir, opts.logger);

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

  if (!outcome.ok) {
    // A half-written tree that looks installed is worse than none: remove it so
    // the warning's "run npm install here" starts from a clean state.
    await removeStagedNodeModules(opts.stagingDir, opts.logger);
    const warning = formatDependencyWarning(outcome, opts.installPath);
    opts.logger.warn(`[marketplace/npm] ${warning} (${outcome.detail})`);
    return [warning];
  }

  const escaped = await stripEscapingSymlinks(opts.stagingDir, opts.logger);
  if (escaped.length === 0) return [];

  const warning = formatEscapedLinkWarning(escaped);
  opts.logger.warn(`[marketplace/npm] ${warning}`);
  return [warning];
}

/**
 * Delete the package's own `.npmrc` from the staged root. Best-effort and
 * silent when there is nothing to delete, which is the overwhelmingly common
 * case. A package that did ship one is logged, because it is worth knowing.
 */
async function removePackageNpmrc(stagingDir: string, logger: Logger): Promise<void> {
  const npmrcPath = path.join(stagingDir, PACKAGE_NPMRC);
  try {
    if (!(await pathExists(npmrcPath))) return;
    await rm(npmrcPath, { force: true });
    logger.warn(
      `[marketplace/npm] Removed the package's own ${PACKAGE_NPMRC}: it can redirect or escape the install, and nothing a package needs at runtime lives in it.`
    );
  } catch (err) {
    logger.warn(
      `[marketplace/npm] Could not remove the package's ${PACKAGE_NPMRC}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/** Returns true when `target` exists, without following a link at the leaf. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the staged `node_modules` after a failed npm run. Best-effort: the
 * install itself still succeeds, so a leftover directory is a janitorial
 * concern rather than a correctness one.
 */
async function removeStagedNodeModules(stagingDir: string, logger: Logger): Promise<void> {
  try {
    await rm(path.join(stagingDir, 'node_modules'), { recursive: true, force: true });
  } catch (err) {
    logger.warn(
      `[marketplace/npm] Could not remove the partial node_modules: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/**
 * Remove every symlink under the staged `node_modules` whose real path lies
 * outside the staging directory, returning the package-relative paths removed.
 *
 * `stage-package.ts` strips symlinks as it copies (DOR-279), but that runs
 * before npm does; a `file:` dependency makes npm mint a brand-new link to
 * anywhere on the machine, and it is readable for as long as the staged tree
 * exists. npm's own `node_modules/.bin` shims point at files inside the tree
 * and resolve fine, so they survive untouched.
 *
 * A link whose target cannot be resolved at all is removed too. It reads as
 * dangling today, but "dangling right now" is a property of the machine rather
 * than of the package, and DOR-279 already declined that kind of reasoning.
 *
 * Never throws: a walk failure is logged and treated as nothing to strip.
 */
async function stripEscapingSymlinks(stagingDir: string, logger: Logger): Promise<string[]> {
  const nodeModules = path.join(stagingDir, 'node_modules');
  const stagingReal = await realpath(stagingDir).catch(() => stagingDir);
  const removed: string[] = [];

  const visit = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable corner of the tree — nothing to strip here.
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const resolved = await realpath(entryPath).catch(() => null);
        if (resolved !== null && isInside(stagingReal, resolved)) continue;
        try {
          await rm(entryPath, { recursive: true, force: true });
          removed.push(path.relative(stagingDir, entryPath));
        } catch (err) {
          logger.warn(
            `[marketplace/npm] Could not remove escaping link ${entryPath}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
        continue;
      }
      if (entry.isDirectory()) await visit(entryPath);
    }
  };

  try {
    await visit(nodeModules);
  } catch (err) {
    logger.warn(
      `[marketplace/npm] Could not scan node_modules for escaping links: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  return removed;
}

/**
 * True when `candidate` is `root` itself or sits beneath it. Compares resolved
 * paths segment-wise via `path.relative`, so a sibling directory whose name
 * merely starts with the root's (`/tmp/stage-evil` against `/tmp/stage`) is
 * correctly reported as outside.
 */
function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Say plainly that the package pointed at something outside itself and that
 * DorkOS did not follow it. Names at most three paths — the point is that it
 * happened, and a package doing this at scale would bury the message.
 */
function formatEscapedLinkWarning(removed: string[]): string {
  const shown = removed.slice(0, 3).join(', ');
  const more = removed.length > 3 ? `, and ${removed.length - 3} more` : '';
  return `This package's libraries included ${removed.length} link${
    removed.length === 1 ? '' : 's'
  } to files outside the package (${shown}${more}). DorkOS removed ${
    removed.length === 1 ? 'it' : 'them'
  }; the package may not work as its author intended.`;
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
