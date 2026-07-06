/**
 * Delegated vendor login — spawns a runtime's own CLI login flow terminal-free
 * and detects completion, so a user connects Claude or Codex without opening a
 * terminal (ADR-0318, effortless-runtime-switching T1, task 2.3b).
 *
 * DorkOS never reimplements a vendor's OAuth (Non-Goal; ToS-unverified). It
 * delegates to the vendor CLI's blessed login: `claude auth login` (Anthropic
 * browser sign-in) / `codex login` (ChatGPT sign-in). The child is spawned
 * without a controlling terminal; completion is detected from its exit code
 * (0 = signed in) and bounded by a hard timeout so a login the user never
 * finishes resolves to an honest `{ ok: false }` rather than blocking forever.
 *
 * This module also hosts {@link pipeSecretToChild}: the shared "write a secret to
 * a child's stdin, never its argv" primitive used by the Codex native-key path
 * (`codex login --with-api-key`, task 2.3a). Passing a secret on argv would leak
 * it into process listings and logs; stdin never does.
 *
 * Binary resolution reuses each adapter's own resolver (plain functions, not SDK
 * imports), so SDK confinement (Hard Rule #2) is unaffected.
 *
 * @module services/runtimes/connect/delegated-login
 */
import { spawn as nodeSpawn } from 'node:child_process';
import type { DelegatedLoginResult } from '@dorkos/shared/runtime-connect';
import { logger } from '../../../lib/logger.js';
import { resolveCodexBinaryPath } from '../codex/check-dependencies.js';
import { resolveClaudeCliPath } from '../claude-code/sdk/sdk-utils.js';

/** Injectable spawn seam (defaults to `node:child_process` spawn); tests pass a fake. */
export type SpawnFn = typeof nodeSpawn;

/** Runtime types that support a delegated CLI login. */
export const LOGIN_RUNTIME_TYPES = ['claude-code', 'codex'] as const;

/** Upper bound on an interactive login — long enough for a browser sign-in, short enough to never hang. */
export const LOGIN_TIMEOUT_MS = 180_000;

/** Upper bound on the non-interactive `codex login --with-api-key` write. */
export const APIKEY_APPLY_TIMEOUT_MS = 15_000;

/** A resolved vendor login invocation: an existing binary and its login argv. */
export interface LoginCommand {
  /** Absolute path to the vendor CLI binary. */
  binary: string;
  /** Argument vector that starts the vendor's login (no secret ever on argv). */
  args: string[];
}

/**
 * Resolve the login invocation for a runtime type, or `null` when its binary
 * cannot be found (the caller surfaces an honest "install first" state).
 *
 * @param type - Runtime type (`'claude-code'` | `'codex'`).
 */
export async function resolveLoginCommand(type: string): Promise<LoginCommand | null> {
  switch (type) {
    case 'codex': {
      const binary = await resolveCodexBinaryPath();
      return binary ? { binary, args: ['login'] } : null;
    }
    case 'claude-code': {
      const binary = resolveClaudeCliPath();
      return binary ? { binary, args: ['auth', 'login'] } : null;
    }
    default:
      return null;
  }
}

/**
 * Spawn a vendor login and resolve once it settles. Success is a clean exit 0;
 * a non-zero exit, a spawn error, or the {@link LOGIN_TIMEOUT_MS} bound all
 * resolve to an honest `{ ok: false }` (the timeout also kills the child, so no
 * orphaned login lingers). Never rejects — the endpoint always gets a result.
 *
 * @param cmd - Resolved login invocation.
 * @param deps - Injectable timeout + spawn seam (defaults for production).
 */
export function runDelegatedLogin(
  cmd: LoginCommand,
  deps: { timeoutMs?: number; spawn?: SpawnFn } = {}
): Promise<DelegatedLoginResult> {
  const timeoutMs = deps.timeoutMs ?? LOGIN_TIMEOUT_MS;
  const spawn = deps.spawn ?? nodeSpawn;

  return new Promise<DelegatedLoginResult>((resolve) => {
    let settled = false;
    let stderr = '';
    const child = spawn(cmd.binary, cmd.args, { stdio: ['ignore', 'ignore', 'pipe'] });

    const finish = (result: DelegatedLoginResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      // Never completed — kill the lingering login and degrade honestly.
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish({ ok: false, error: 'Sign-in timed out. Please try again.' });
    }, timeoutMs);
    timer.unref?.();

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', (err: Error) => {
      finish({ ok: false, error: honestLoginError(err.message) });
    });
    child.once('exit', (code: number | null) => {
      if (code === 0) return finish({ ok: true });
      finish({ ok: false, error: honestLoginError(stderr.trim() || `exited with code ${code}`) });
    });
  });
}

/**
 * Write a secret to a child's stdin (never its argv) and resolve on a clean
 * exit — the mechanism behind `codex login --with-api-key`. Bounded and
 * throw-free; the secret is never logged and never appears on the command line.
 *
 * @param cmd - The invocation whose stdin receives the secret.
 * @param secret - The plaintext secret to pipe (stdin only).
 * @param deps - Injectable timeout + spawn seam.
 */
export function pipeSecretToChild(
  cmd: LoginCommand,
  secret: string,
  deps: { timeoutMs?: number; spawn?: SpawnFn } = {}
): Promise<DelegatedLoginResult> {
  const timeoutMs = deps.timeoutMs ?? APIKEY_APPLY_TIMEOUT_MS;
  const spawn = deps.spawn ?? nodeSpawn;

  return new Promise<DelegatedLoginResult>((resolve) => {
    let settled = false;
    let stderr = '';
    const child = spawn(cmd.binary, cmd.args, { stdio: ['pipe', 'ignore', 'pipe'] });

    const finish = (result: DelegatedLoginResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish({ ok: false, error: 'Saving the API key timed out. Please try again.' });
    }, timeoutMs);
    timer.unref?.();

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', (err: Error) => {
      finish({ ok: false, error: honestLoginError(err.message) });
    });
    child.once('exit', (code: number | null) => {
      if (code === 0) return finish({ ok: true });
      finish({ ok: false, error: honestLoginError(stderr.trim() || `exited with code ${code}`) });
    });

    // Secret transits stdin ONLY — never argv, never a log line.
    try {
      child.stdin?.end(secret);
    } catch {
      finish({ ok: false, error: 'Could not save the API key. Please try again.' });
    }
  });
}

/**
 * Delegate a runtime's CLI login end to end: resolve the command, spawn it, and
 * detect completion. Returns an honest, binary-not-found state when the vendor
 * CLI is unresolvable (Codex install is handled in T0; Claude ships bundled).
 *
 * @param type - Runtime type (`'claude-code'` | `'codex'`).
 * @param deps - Injectable timeout + spawn seam + command resolver (for tests).
 */
export async function delegateRuntimeLogin(
  type: string,
  deps: {
    timeoutMs?: number;
    spawn?: SpawnFn;
    resolveCommand?: (type: string) => Promise<LoginCommand | null>;
  } = {}
): Promise<DelegatedLoginResult> {
  const resolveCommand = deps.resolveCommand ?? resolveLoginCommand;
  const cmd = await resolveCommand(type);
  if (!cmd) {
    return { ok: false, error: `The ${type} CLI is not available to sign in.` };
  }
  return runDelegatedLogin(cmd, deps);
}

/**
 * Condense a login/apply failure into an honest, single-line message. Vendor
 * login output carries no secret, but we still normalize to one short line and
 * never surface a raw multi-line stack to the Connect UI.
 */
function honestLoginError(detail: string): string {
  const firstLine = detail
    .split(/\r?\n/)
    .find((l) => l.trim())
    ?.trim();
  logger.warn('[Connect] delegated login did not complete', { detail: firstLine });
  return firstLine ? `Sign-in failed: ${firstLine}` : 'Sign-in failed. Please try again.';
}
