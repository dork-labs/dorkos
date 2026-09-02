/**
 * On-demand Claude Code provisioning (ADR-0317, extended to claude-code).
 *
 * The Agent SDK ships Claude Code as a per-platform native binary in its
 * optional dependencies, so Claude is usually resolvable with no install at all.
 * When that bundled binary is absent — a `--no-optional` install, a blocked
 * download, a platform whose optional package never landed — the readiness
 * ladder projects Claude Code to Connect with an "Install Claude" action. That
 * button had no endpoint behind it and answered 404 (DOR-1334 / F4); this module
 * is the endpoint's other half.
 *
 * It installs the SAME per-platform package the SDK would have bundled, pinned
 * to the SDK version the server depends on, into a DorkOS-owned,
 * dork-home-scoped location — never a global `npm i -g`, never `os.homedir()`
 * (hard rule; resolved via `lib/dork-home.ts`). On success the provisioned
 * binary joins the shared resolution ladder and Claude Code flips to Ready; on
 * failure the partial tree is removed and the caller gets an honest message.
 *
 * This module also owns the NAMES of those per-platform packages, because the
 * name it installs and the name the SDK-bundled lookup resolves must be the same
 * list or the provisioned rung could never resolve what this installed.
 *
 * @module services/runtimes/claude-code/tooling/provision
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeProvisionProgress, RuntimeProvisionResult } from '@dorkos/shared/transport';
import { resolveDorkHome } from '../../../../lib/dork-home.js';
import { logger, logError } from '../../../../lib/logger.js';

/**
 * `@anthropic-ai/claude-agent-sdk` version whose per-platform binary package is
 * installed — pinned to the SDK the server already depends on
 * (`apps/server/package.json`), so the provisioned CLI and the SDK that drives
 * it can never drift. A future SDK bump updates this in lockstep (a test fails
 * red otherwise).
 *
 * That forced edit makes this the right place to say what else a re-pin has to
 * re-check, because nothing else reds on its own: `mapSdkModelToModelOption`
 * (`../messaging/runtime-cache.ts`) ASSERTS `supportsToolUse` / `supportsVision`
 * / `supportsImageOutput` for every Claude model rather than reading them,
 * because `ModelInfo` reports nothing capability-shaped. Re-read that TSDoc on
 * every bump: if the new SDK reports any of them, read it instead of claiming
 * it; if Anthropic ships a text-only model, the `supportsVision` claim is the
 * one that goes wrong first.
 */
export const CLAUDE_SDK_VERSION = '0.3.224';

/** npm name of the SDK whose per-platform binary packages this module installs. */
const SDK_PKG = '@anthropic-ai/claude-agent-sdk';

/** Executable name inside the per-platform package. */
const CLAUDE_BIN = process.platform === 'win32' ? 'claude.exe' : 'claude';

/**
 * Whether this Linux host uses musl libc (Alpine) rather than glibc.
 *
 * Node's diagnostic report names the glibc runtime version it linked against;
 * on a musl host the field is simply absent. Cheaper and more reliable than
 * shelling out to `ldd --version`, and it decides which of the two Linux binary
 * packages is worth installing — the wrong one installs fine and then refuses to
 * run, which is a failure mode nobody enjoys diagnosing.
 *
 * A host with NO diagnostic report at all cannot be told apart either way, so it
 * is treated as glibc: that is what the great majority of Linux hosts are, and
 * `resolveProvisionedClaudePath` still checks both package names afterwards, so
 * a wrong guess here costs an install, never a permanently unusable rung.
 */
function isMuslLinux(): boolean {
  const report = process.report?.getReport() as
    { header?: { glibcVersionRuntime?: string } } | undefined;
  if (!report) return false;
  return report.header?.glibcVersionRuntime === undefined;
}

/**
 * The per-platform binary packages that can hold a `claude` for THIS host, in
 * preference order.
 *
 * Since 0.2.113 the Agent SDK ships Claude Code as a native binary in optional
 * dependencies named `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` (with
 * `-musl` and `-android` variants), exposing `claude` (or `claude.exe`) at the
 * package root. Only one is ever installed on a given host, so resolution tries
 * each in turn and provisioning installs the first.
 *
 * @returns Ordered candidate package names (never empty).
 */
export function claudePlatformPackages(): string[] {
  const { platform, arch } = process;
  if (platform === 'android') return [`${SDK_PKG}-linux-${arch}-android`];
  if (platform === 'linux') {
    const glibc = `${SDK_PKG}-linux-${arch}`;
    const musl = `${SDK_PKG}-linux-${arch}-musl`;
    return isMuslLinux() ? [musl, glibc] : [glibc, musl];
  }
  return [`${SDK_PKG}-${platform}-${arch}`];
}

/** Dork-home-scoped directory the provisioned binary package is installed into. */
export function resolveClaudeProvisionDir(): string {
  return path.join(resolveDorkHome(), 'runtimes', 'claude-code');
}

/**
 * Absolute path to the provisioned `claude` binary, or `null` when nothing was
 * provisioned for this host.
 *
 * Unlike the codex twin this checks existence itself, because a host can have
 * two plausible package names (glibc/musl) and only the installed one is the
 * answer. The shared ladder existence-checks the result again, harmlessly.
 */
export function resolveProvisionedClaudePath(): string | null {
  const dir = resolveClaudeProvisionDir();
  for (const pkg of claudePlatformPackages()) {
    const binary = path.join(dir, 'node_modules', ...pkg.split('/'), CLAUDE_BIN);
    if (existsSync(binary)) return binary;
  }
  return null;
}

/** Package-manager-agnostic installer invocation: a scoped `npm install --prefix`. */
function npmInstallArgs(dir: string, spec: string): { cmd: string; args: string[] } {
  return {
    cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['install', '--prefix', dir, '--no-audit', '--no-fund', '--loglevel=error', spec],
  };
}

/** Condense installer failure into an honest, non-raw Connect message. */
function honestInstallError(detail: string): string {
  const firstLine = detail
    .split(/\r?\n/)
    .find((l) => l.trim())
    ?.trim();
  const suffix = firstLine ? ` (${firstLine})` : '';
  return `Could not install Claude Code${suffix}. Check your network and try again.`;
}

/** Best-effort removal of the (possibly partial) provisioning tree; never throws. */
async function cleanupProvisionDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    logger.warn('[ClaudeCode] failed to clean up partial provisioning tree', logError(err));
  }
}

/**
 * Shared in-flight provisioning promise. Concurrent callers piggyback on one
 * install rather than racing a second `npm install` (and its cleanup `rm -rf`)
 * into the same scoped dir. Cleared once the install settles.
 */
let inFlightProvision: Promise<RuntimeProvisionResult> | null = null;

/**
 * Install this platform's Claude Code binary package on demand into the
 * dork-home-scoped location.
 *
 * De-dupes concurrent calls (double-click, two tabs, a retry racing the
 * original). Streams installer progress to `onProgress` (if supplied) and
 * resolves to the terminal result. On a non-zero exit, a spawn error, or an
 * exit-0 that left no resolvable binary, the partial tree is removed and the
 * result carries an honest error. Never rejects: failures are returned, not
 * thrown, so the endpoint always resolves to a Connect/error state.
 *
 * @param onProgress - Optional callback for streamed install progress frames.
 * @returns The terminal provisioning result.
 */
export async function provisionClaudeCode(
  onProgress?: (progress: RuntimeProvisionProgress) => void
): Promise<RuntimeProvisionResult> {
  if (inFlightProvision) {
    onProgress?.({ stage: 'starting', message: 'Claude Code install already in progress…' });
    return inFlightProvision;
  }
  const run = runProvisionClaudeCode(onProgress);
  inFlightProvision = run;
  try {
    return await run;
  } finally {
    inFlightProvision = null;
  }
}

/**
 * Perform one on-demand install into the dork-home-scoped location. The
 * concurrency guard lives in {@link provisionClaudeCode}; this does the work.
 *
 * @param onProgress - Optional callback for streamed install progress frames.
 * @returns The terminal provisioning result.
 */
async function runProvisionClaudeCode(
  onProgress?: (progress: RuntimeProvisionProgress) => void
): Promise<RuntimeProvisionResult> {
  const dir = resolveClaudeProvisionDir();
  const spec = `${claudePlatformPackages()[0]}@${CLAUDE_SDK_VERSION}`;
  onProgress?.({ stage: 'starting', message: `Installing ${spec}…` });

  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    await cleanupProvisionDir(dir);
    const message = err instanceof Error ? err.message : String(err);
    onProgress?.({ stage: 'error', message });
    return { ok: false, error: honestInstallError(message) };
  }

  const { cmd, args } = npmInstallArgs(dir, spec);

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
        const binaryPath = resolveProvisionedClaudePath();
        if (binaryPath) {
          onProgress?.({ stage: 'done', message: 'Claude Code installed.' });
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
