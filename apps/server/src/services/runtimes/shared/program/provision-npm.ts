/**
 * On-demand install of a runtime's program from npm (ADR-0317), shared by every
 * runtime whose program is an npm package: Claude Code, Codex and OpenCode.
 *
 * Each runtime installs one pinned package into its own DorkOS-owned,
 * dork-home-scoped folder — never a global `npm i -g`, never `os.homedir()`
 * (hard rule; each caller resolves its folder via `lib/dork-home.ts`). What
 * differs per runtime is only the package, the folder and where the installed
 * binary lands; the install itself, its progress stream, its cleanup on
 * failure and its de-duplication of concurrent calls are this one module, so a
 * fix to any of them reaches every runtime at once.
 *
 * Imports no runtime SDK, so ESLint's per-adapter SDK confinement never applies.
 *
 * @module services/runtimes/shared/program/provision-npm
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import type { RuntimeProvisionProgress, RuntimeProvisionResult } from '@dorkos/shared/transport';
import { logger, logError } from '../../../../lib/logger.js';
import type { EnvironmentRuntime } from '../runtime-environment.js';
import { runtimeEnvironment } from '../runtime-environment-config.js';

/** One runtime's npm-installed program, as {@link createNpmProvisioner} installs it. */
export interface NpmProvisionTarget {
  /** Runtime whose `provision` environment the installer runs in. */
  runtime: EnvironmentRuntime;
  /** The program's name as a person reads it, e.g. `Codex`. */
  label: string;
  /** Prefix for this runtime's log lines, e.g. `[Codex]`. */
  logTag: string;
  /** The dork-home-scoped folder to install into, read at install time. */
  dir: () => string;
  /** The pinned `name@version` npm installs, read at install time. */
  spec: () => string;
  /** The installed binary, or `null` when the install left nothing runnable. */
  installedBinary: () => string | null;
}

/** Progress callback for one install. */
type OnProgress = (progress: RuntimeProvisionProgress) => void;

/**
 * Condense an installer failure into an honest, non-raw Connect message: the
 * first non-blank line of the detail, never a stack.
 *
 * @param label - The program's name as a person reads it, e.g. `OpenCode`.
 * @param detail - The installer's stderr or error message, if any.
 */
export function honestInstallError(label: string, detail: string | undefined): string {
  const firstLine = (detail ?? '')
    .split(/\r?\n/)
    .find((l) => l.trim())
    ?.trim();
  const suffix = firstLine ? ` (${firstLine})` : '';
  return `Could not install ${label}${suffix}. Check your network and try again.`;
}

/**
 * The `version` an installed package's own `package.json` reports.
 *
 * Returns `null` — never throws — when the file is missing, unreadable or
 * malformed. Callers treat that exactly like a version mismatch, the safe
 * default: an install whose version cannot be established cannot be trusted.
 *
 * @param manifestPath - Absolute path to the installed package's `package.json`.
 */
export function readInstalledPackageVersion(manifestPath: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'version' in parsed &&
      typeof parsed.version === 'string'
    ) {
      return parsed.version;
    }
    return null;
  } catch {
    return null;
  }
}

/** Best-effort removal of the (possibly partial) provisioning tree; never throws. */
async function cleanupProvisionDir(target: NpmProvisionTarget, dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    logger.warn(`${target.logTag} failed to clean up partial provisioning tree`, logError(err));
  }
}

/**
 * Build the install function for one runtime's program.
 *
 * The returned function de-dupes concurrent calls (double-click, two tabs, a
 * retry racing the original): a second call piggybacks on the in-flight
 * install instead of racing a second `npm install` (and its cleanup `rm -rf`)
 * into the same folder. It streams installer output to `onProgress` and
 * resolves to the terminal result. On a non-zero exit, a spawn error, or an
 * exit-0 that left no runnable binary, the partial tree is removed and the
 * result carries an honest error. It never rejects: failures are returned, not
 * thrown, so the endpoint always resolves to a Connect or error state.
 *
 * @param target - What to install and where.
 * @returns The install function, one in-flight install at a time.
 */
export function createNpmProvisioner(
  target: NpmProvisionTarget
): (onProgress?: OnProgress) => Promise<RuntimeProvisionResult> {
  let inFlight: Promise<RuntimeProvisionResult> | null = null;
  return async (onProgress) => {
    if (inFlight) {
      onProgress?.({ stage: 'starting', message: `${target.label} install already in progress…` });
      return inFlight;
    }
    const run = runNpmInstall(target, onProgress);
    inFlight = run;
    try {
      return await run;
    } finally {
      inFlight = null;
    }
  };
}

/**
 * Perform one scoped `npm install --prefix`. The concurrency guard lives in
 * {@link createNpmProvisioner}; this does the work.
 */
async function runNpmInstall(
  target: NpmProvisionTarget,
  onProgress?: OnProgress
): Promise<RuntimeProvisionResult> {
  const dir = target.dir();
  const spec = target.spec();
  onProgress?.({ stage: 'starting', message: `Installing ${spec}…` });

  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    await cleanupProvisionDir(target, dir);
    const message = err instanceof Error ? err.message : String(err);
    onProgress?.({ stage: 'error', message });
    return { ok: false, error: honestInstallError(target.label, message) };
  }

  const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = ['install', '--prefix', dir, '--no-audit', '--no-fund', '--loglevel=error', spec];

  return new Promise<RuntimeProvisionResult>((resolve) => {
    let stderr = '';
    let settled = false;
    const finish = (result: RuntimeProvisionResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = spawn(cmd, args, {
      env: runtimeEnvironment(target.runtime, 'provision'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      onProgress?.({ stage: 'installing', message: chunk.toString() });
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      onProgress?.({ stage: 'installing', message: text });
    });

    child.once('error', (err: Error) => {
      void cleanupProvisionDir(target, dir).then(() => {
        onProgress?.({ stage: 'error', message: err.message });
        finish({ ok: false, error: honestInstallError(target.label, err.message) });
      });
    });

    child.once('exit', (code: number | null) => {
      if (code === 0) {
        const binaryPath = target.installedBinary();
        if (binaryPath) {
          onProgress?.({ stage: 'done', message: `${target.label} installed.` });
          return finish({ ok: true, binaryPath });
        }
        // Installer succeeded but left no runnable binary — treat as failure.
      }
      void cleanupProvisionDir(target, dir).then(() => {
        const detail = stderr.trim() || `Installer exited with code ${code}`;
        onProgress?.({ stage: 'error', message: detail });
        finish({ ok: false, error: honestInstallError(target.label, detail) });
      });
    });
  });
}
