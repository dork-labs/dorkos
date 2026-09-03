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
 * ## Account pinning (DOR-1652)
 *
 * A `claude-code` login is spawned with `CLAUDE_CONFIG_DIR` explicitly pinned
 * ({@link claudeConfigDirEnv}) to the account DorkOS runs a NEW session on by
 * default — `runtimes.claudeCode.defaultAccount`, or the inherited
 * `$CLAUDE_CONFIG_DIR`/`~/.claude` chain when nothing is configured (rungs 3-4
 * of the account ladder in `claude-config-dir.ts`; see {@link
 * resolveActiveClaudeRoot}). Without this the spawned `claude auth login`
 * instead inherits whatever `CLAUDE_CONFIG_DIR` the SERVER PROCESS happens to
 * have, which on a multi-account machine can silently re-authenticate the
 * wrong account. Today's only caller (Settings → "Fix sign-in") carries no
 * session identity, so this default is what it gets.
 *
 * An explicit {@link ResolveLoginCommandOptions.accountRoot} pins to a
 * DIFFERENT, specific account instead — validated against {@link
 * resolveClaudeRootSet} before anything spawns, so an unrecognized path is
 * rejected rather than handed to a child process, and rejected outright for
 * any runtime type other than `claude-code`. DOR-1651 (inline sign-in from a
 * session's error card) is the intended consumer: it knows that session's
 * actual bound account (rungs 1-2 of the ladder — a launch hint, an agent
 * manifest, or the session's own persisted `accountRoot`) and will pass it
 * through here so re-login targets THAT account rather than just the default.
 * `codex` has no config-dir concept here and is unaffected: its `LoginCommand`
 * carries no `env`, so it spawns exactly as it did before this seam existed.
 *
 * @module services/runtimes/connect/delegated-login
 */
import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import type { DelegatedLoginResult } from '@dorkos/shared/runtime-connect';
import { runtimeDisplayName } from '@dorkos/shared/agent-runtime';
import { logger } from '../../../lib/logger.js';
import { resolveCodexBinaryPath } from '../codex/check-dependencies.js';
import { resolveClaudeCliPath } from '../claude-code/sdk/sdk-utils.js';
import {
  claudeConfigDirEnv,
  resolveActiveClaudeRoot,
  resolveClaudeRootSet,
} from '../claude-code/claude-config-dir.js';

/** Injectable spawn seam (defaults to `node:child_process` spawn); tests pass a fake. */
export type SpawnFn = typeof nodeSpawn;

/**
 * Runtime types that support a delegated CLI login.
 *
 * Re-exported from `@dorkos/shared` rather than declared here: the client gates
 * its inline sign-in button on the same list (DOR-1651), and two copies would
 * drift into a surface that offers a sign-in this route then refuses.
 */
export { LOGIN_RUNTIME_TYPES } from '@dorkos/shared/agent-runtime';

/** Upper bound on an interactive login — long enough for a browser sign-in, short enough to never hang. */
export const LOGIN_TIMEOUT_MS = 180_000;

/**
 * Delegated logins currently in flight, keyed by runtime type, with the account
 * each is signing in (`''` meaning "whichever account DorkOS runs new sessions
 * on").
 *
 * There is one vendor CLI and one browser flow per runtime, so two concurrent
 * `claude auth login` spawns fight over the same terminal-free sign-in and the
 * loser's window is orphaned. Nothing prevented that before: the sign-in used
 * to have a single entry point (Settings), but the inline error card (DOR-1651)
 * puts one on every hydrated auth-error row, times every open tab.
 *
 * Keyed by type rather than by type+account deliberately — the constraint is
 * the CLI, not the account. A second request for the SAME account joins the
 * attempt already running; one for a DIFFERENT account is refused honestly,
 * because handing it the in-flight promise would report a completed sign-in
 * for an account nobody signed into (the very bug DOR-1652 fixed, one rung up).
 */
const inFlightLogins = new Map<
  string,
  { target: string; promise: Promise<DelegatedLoginResult> }
>();

/** Upper bound on the non-interactive `codex login --with-api-key` write. */
export const APIKEY_APPLY_TIMEOUT_MS = 15_000;

/** A resolved vendor login invocation: an existing binary and its login argv. */
export interface LoginCommand {
  /** Absolute path to the vendor CLI binary. */
  binary: string;
  /** Argument vector that starts the vendor's login (no secret ever on argv). */
  args: string[];
  /**
   * Full environment for the spawned login, already merged over `process.env`
   * — currently just the `claude-code` account pin ({@link claudeConfigDirEnv}).
   * `undefined` when the runtime has no env override to apply (`codex`), in
   * which case the child inherits `process.env` unmodified, exactly as before
   * this seam existed.
   */
  env?: NodeJS.ProcessEnv;
}

/** Resolution options for {@link resolveLoginCommand}. */
export interface ResolveLoginCommandOptions {
  /**
   * Pin the `claude-code` login to this account root instead of the account
   * DorkOS runs new sessions on. Intended consumer: DOR-1651 (inline sign-in
   * from a session's error card), which knows that session's actual bound
   * account and can pass a root that differs from the default. Callers
   * reaching this through {@link delegateRuntimeLogin} already have it
   * validated against {@link resolveClaudeRootSet}, and rejected outright —
   * never even reaching this function — for every runtime type other than
   * `claude-code`.
   */
  accountRoot?: string;
}

/**
 * Resolve the login invocation for a runtime type, or `null` when its binary
 * cannot be found (the caller surfaces an honest "install first" state).
 *
 * For `claude-code`, the spawn env pins `CLAUDE_CONFIG_DIR` to
 * `opts.accountRoot` — or, when omitted, to {@link resolveActiveClaudeRoot},
 * the account DorkOS runs a NEW session on. This is what makes "Fix sign-in"
 * re-authenticate the account DorkOS would actually use, rather than
 * whatever `CLAUDE_CONFIG_DIR` the server process happens to have inherited
 * (DOR-1652). `opts.accountRoot` targets a DIFFERENT, already-decided account
 * instead; its intended caller is DOR-1651 (inline sign-in from a session's
 * error card), which knows that session's actual bound account.
 *
 * @param type - Runtime type (`'claude-code'` | `'codex'`).
 * @param opts - Resolution options (`accountRoot`, `claude-code` only).
 */
export async function resolveLoginCommand(
  type: string,
  opts: ResolveLoginCommandOptions = {}
): Promise<LoginCommand | null> {
  switch (type) {
    case 'codex': {
      const binary = await resolveCodexBinaryPath();
      return binary ? { binary, args: ['login'] } : null;
    }
    case 'claude-code': {
      const binary = resolveClaudeCliPath();
      if (!binary) return null;
      const root = opts.accountRoot ?? resolveActiveClaudeRoot();
      return {
        binary,
        args: ['auth', 'login'],
        env: {
          // eslint-disable-next-line no-restricted-syntax -- the CLI needs the full shell env (PATH, etc.) alongside the pinned account; see claude-code-runtime.ts for the identical pattern
          ...process.env,
          ...claudeConfigDirEnv(root),
        },
      };
    }
    default:
      return null;
  }
}

/**
 * Whether `root` is one of the Claude account roots DorkOS actually knows
 * about ({@link resolveClaudeRootSet}). Guards {@link delegateRuntimeLogin}'s
 * optional `accountRoot` — an id or path from a future caller must never reach
 * a spawn unvalidated.
 *
 * @param root - Candidate account root to check.
 */
function isKnownClaudeAccountRoot(root: string): boolean {
  const target = path.resolve(root);
  return resolveClaudeRootSet().some((known) => path.resolve(known) === target);
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
    const child = spawn(cmd.binary, cmd.args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      ...(cmd.env ? { env: cmd.env } : {}),
    });

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
    const child = spawn(cmd.binary, cmd.args, {
      stdio: ['pipe', 'ignore', 'pipe'],
      ...(cmd.env ? { env: cmd.env } : {}),
    });

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
 * `deps.accountRoot` pins a `claude-code` login to a specific account instead
 * of the account DorkOS runs new sessions on. Its intended caller is DOR-1651
 * (inline sign-in from a session's error card), which knows that session's
 * actual bound account (DOR-1652 introduces the seam; DOR-1651 is the first
 * caller to pass a non-default root). It is rejected outright for any type
 * other than `claude-code` — accounts are a Claude-only concept here — and
 * for `claude-code` it is validated against {@link resolveClaudeRootSet}
 * BEFORE anything spawns: a root that resolver does not recognize resolves
 * to an honest `{ ok: false }` rather than reaching a child process with an
 * arbitrary caller-supplied path. Omitted, the login pins to {@link
 * resolveActiveClaudeRoot} (see {@link resolveLoginCommand}) — the account
 * DorkOS runs a new session on by default.
 *
 * @param type - Runtime type (`'claude-code'` | `'codex'`).
 * @param deps - Injectable timeout + spawn seam + command resolver (for tests),
 *   plus the optional account pin.
 */
export async function delegateRuntimeLogin(
  type: string,
  deps: {
    timeoutMs?: number;
    spawn?: SpawnFn;
    resolveCommand?: (
      type: string,
      opts?: ResolveLoginCommandOptions
    ) => Promise<LoginCommand | null>;
    accountRoot?: string;
  } = {}
): Promise<DelegatedLoginResult> {
  if (deps.accountRoot !== undefined) {
    if (type !== 'claude-code') {
      return { ok: false, error: `"${type}" does not support pinning a specific account.` };
    }
    if (!isKnownClaudeAccountRoot(deps.accountRoot)) {
      return { ok: false, error: 'That Claude account is not recognized on this machine.' };
    }
  }

  const target = deps.accountRoot === undefined ? '' : path.resolve(deps.accountRoot);
  const existing = inFlightLogins.get(type);
  if (existing) {
    // Same target: hand back the SAME attempt. Every card watching this runtime
    // then settles on one outcome instead of racing a second browser window.
    if (existing.target === target) return existing.promise;
    // Different account, same runtime: there is one vendor CLI and one browser
    // flow, so this cannot be honoured — and answering with the in-flight
    // attempt's result would report a sign-in for an account nobody signed in.
    return {
      ok: false,
      error: `A sign-in for ${runtimeDisplayName(type)} is already in progress.`,
    };
  }

  const attempt = (async (): Promise<DelegatedLoginResult> => {
    const resolveCommand = deps.resolveCommand ?? resolveLoginCommand;
    const cmd = await resolveCommand(type, { accountRoot: deps.accountRoot });
    if (!cmd) {
      return { ok: false, error: `The ${type} CLI is not available to sign in.` };
    }
    return runDelegatedLogin(cmd, deps);
  })();

  inFlightLogins.set(type, { target, promise: attempt });
  try {
    return await attempt;
  } finally {
    // Released on every path — success, honest failure, and the bounded timeout
    // — so a login that never completed cannot wedge the runtime forever.
    inFlightLogins.delete(type);
  }
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
