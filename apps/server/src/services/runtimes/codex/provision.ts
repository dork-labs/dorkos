/**
 * On-demand Codex provisioning (ADR-0317).
 *
 * `@openai/codex-sdk` vendors the Codex CLI out of the box, so Codex is usually
 * resolvable without any install. When that vendored binary is absent — a
 * `--no-optional` install, a platform whose vendor package never landed, or a
 * stripped image — the one-click Connect action installs the `@openai/codex` CLI
 * on demand into a DorkOS-owned, dork-home-scoped location, never a global
 * `npm i -g` and never `os.homedir()` (hard rule; resolved via `lib/dork-home.ts`).
 * Because `@openai/codex` declares per-platform, `os`/`cpu`-gated
 * `optionalDependencies`, installing it pulls only the current platform's binary.
 * On success the provisioned binary is resolvable (the check-dependencies resolver
 * adds it as a candidate) and Codex flips to Ready; on failure the partial tree is
 * removed and the caller resolves back to a single Connect action with an honest
 * message.
 *
 * @module services/runtimes/codex/provision
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeProvisionProgress, RuntimeProvisionResult } from '@dorkos/shared/transport';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { logger, logError } from '../../../lib/logger.js';

/**
 * `@openai/codex` version to install — pinned to match the `@openai/codex` CLI
 * and `@openai/codex-sdk` the server already depends on (`apps/server/package.json`),
 * so the provisioned CLI and the SDK never drift. Reversible: a future SDK bump
 * updates this in lockstep.
 */
export const CODEX_PACKAGE_VERSION = '0.144.1';

/** Dork-home-scoped directory the provisioned `@openai/codex` package is installed into. */
export function resolveCodexProvisionDir(): string {
  return path.join(resolveDorkHome(), 'runtimes', 'codex');
}

/**
 * Absolute path to the provisioned `codex` binary (the npm-created bin shim under
 * the scoped install), existence-agnostic — the shared resolver verifies it exists.
 */
export function resolveProvisionedCodexPath(): string {
  const bin = process.platform === 'win32' ? 'codex.cmd' : 'codex';
  return path.join(resolveCodexProvisionDir(), 'node_modules', '.bin', bin);
}

/** Package-manager-agnostic installer invocation: a scoped `npm install --prefix`. */
function npmInstallArgs(dir: string): { cmd: string; args: string[] } {
  return {
    cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: [
      'install',
      '--prefix',
      dir,
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      `@openai/codex@${CODEX_PACKAGE_VERSION}`,
    ],
  };
}

/** Condense installer failure into an honest, non-raw Connect message. */
function honestInstallError(detail: string): string {
  const firstLine = detail
    .split(/\r?\n/)
    .find((l) => l.trim())
    ?.trim();
  const suffix = firstLine ? ` (${firstLine})` : '';
  return `Could not install Codex${suffix}. Check your connection and try again.`;
}

/** Best-effort removal of the (possibly partial) provisioning tree; never throws. */
async function cleanupProvisionDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    logger.warn('[Codex] failed to clean up partial provisioning tree', logError(err));
  }
}

/**
 * Shared in-flight provisioning promise. Concurrent callers piggyback on one
 * install rather than racing a second `npm install` (and its cleanup `rm -rf`)
 * into the same scoped dir. Cleared once the install settles.
 */
let inFlightProvision: Promise<RuntimeProvisionResult> | null = null;

/**
 * Install `@openai/codex` on demand into the dork-home-scoped location.
 *
 * De-dupes concurrent calls (double-click, two tabs, a retry racing the
 * original): a second call piggybacks on the in-flight install instead of
 * spawning a second `npm install` that would race the first's cleanup. Streams
 * installer progress to `onProgress` (if supplied) and resolves to the terminal
 * result. On a non-zero exit, a spawn error, or an exit-0 that left no resolvable
 * binary, the partial tree is removed and the result carries an honest error.
 * Never rejects: failures are returned, not thrown, so the endpoint always
 * resolves to a Connect/error state.
 *
 * @param onProgress - Optional callback for streamed install progress frames.
 * @returns The terminal provisioning result.
 */
export async function provisionCodex(
  onProgress?: (progress: RuntimeProvisionProgress) => void
): Promise<RuntimeProvisionResult> {
  if (inFlightProvision) {
    onProgress?.({ stage: 'starting', message: 'Codex install already in progress…' });
    return inFlightProvision;
  }
  const run = runProvisionCodex(onProgress);
  inFlightProvision = run;
  try {
    return await run;
  } finally {
    inFlightProvision = null;
  }
}

/**
 * Perform one on-demand `@openai/codex` install into the dork-home-scoped location.
 * The concurrency guard lives in {@link provisionCodex}; this does the work.
 *
 * @param onProgress - Optional callback for streamed install progress frames.
 * @returns The terminal provisioning result.
 */
async function runProvisionCodex(
  onProgress?: (progress: RuntimeProvisionProgress) => void
): Promise<RuntimeProvisionResult> {
  const dir = resolveCodexProvisionDir();
  const spec = `@openai/codex@${CODEX_PACKAGE_VERSION}`;
  onProgress?.({ stage: 'starting', message: `Installing ${spec}…` });

  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    await cleanupProvisionDir(dir);
    const message = err instanceof Error ? err.message : String(err);
    onProgress?.({ stage: 'error', message });
    return { ok: false, error: honestInstallError(message) };
  }

  const { cmd, args } = npmInstallArgs(dir);

  return new Promise<RuntimeProvisionResult>((resolve) => {
    let stderr = '';
    let settled = false;
    const finish = (result: RuntimeProvisionResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    child.stdout?.on('data', (chunk: Buffer) => {
      onProgress?.({ stage: 'installing', message: chunk.toString() });
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      onProgress?.({ stage: 'installing', message: text });
    });

    child.once('error', (err: Error) => {
      void cleanupProvisionDir(dir).then(() => {
        onProgress?.({ stage: 'error', message: err.message });
        finish({ ok: false, error: honestInstallError(err.message) });
      });
    });

    child.once('exit', (code: number | null) => {
      if (code === 0) {
        const binaryPath = resolveProvisionedCodexPath();
        if (existsSync(binaryPath)) {
          onProgress?.({ stage: 'done', message: 'Codex installed.' });
          return finish({ ok: true, binaryPath });
        }
        // Installer succeeded but left no runnable binary — treat as failure.
      }
      void cleanupProvisionDir(dir).then(() => {
        const detail = stderr.trim() || `Installer exited with code ${code}`;
        onProgress?.({ stage: 'error', message: detail });
        finish({ ok: false, error: honestInstallError(detail) });
      });
    });
  });
}
