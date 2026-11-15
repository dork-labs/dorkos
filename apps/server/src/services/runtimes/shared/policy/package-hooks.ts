/**
 * Run an installed package's own shell guards for runtimes that have no hooks
 * of their own (DOR-4379).
 *
 * Claude Code reads a package's `PreToolUse` hooks natively. OpenCode and the
 * Dork runtime do not, so a guard like Safety Hooks' `git-guard.mjs` protected
 * nothing there. Both runtimes already pass every shell command through a check
 * DorkOS owns, in every mode, Full included: OpenCode's `permission.asked` for
 * `bash` and Doe's approval callback for `shell`. That check calls
 * {@link checkShellCommand}, which runs the same scripts Claude Code would run,
 * with the same stdin Claude Code sends, and refuses the command when one says
 * so.
 *
 * Codex is not covered here. Its own hook engine runs a package's hooks only
 * after a person trusts them in Codex, and DorkOS must never write that trust
 * for them (Security, Nov 14). DorkOS's Codex approval channel sees only
 * commands that leave the sandbox, so it cannot stand in either. The app says
 * "doesn't run on this runtime yet" for Codex instead.
 *
 * Which packages run is decided exactly as for Claude Code, by
 * `consentedHookPackages`: a package a person has not allowed, or has turned
 * down, runs nowhere.
 *
 * **Fails closed.** Claude Code treats any exit but 2 as "go ahead". Here a
 * guard that crashes, times out, cannot start or says nothing readable blocks
 * the command, with a message saying which check failed: a safety check that
 * silently stops working is the failure this module exists to prevent. Exit 0
 * allows, unless its stdout carries Claude Code's JSON "deny" or "block"
 * decision.
 *
 * @module services/runtimes/shared/policy/package-hooks
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { pluginEnvPrefix } from '@dorkos/harness';
import { isShellCheckHook } from '@dorkos/shared/marketplace-schemas';

import { resolveDorkHome } from '../../../../lib/dork-home.js';
import { logger, logError } from '../../../../lib/logger.js';
import {
  consentedHookPackages,
  scanHookRequests,
  withProvenInstalls,
  type ConsentedHookPackage,
} from '../../../harness/project-with-consent.js';
import type { HookDecisions } from '../../../harness/hook-consent.js';
import { runtimeEnvironment } from '../runtime-environment-config.js';
import type { EnvironmentRuntime } from '../runtime-environment.js';

/** How long one guard may run before the command is blocked, matching Claude Code's default. */
export const PACKAGE_HOOK_TIMEOUT_MS = 60_000;

/** Guards run in their own process group, so a timeout can stop all of it. */
const POSIX = process.platform !== 'win32';

/** The most guard output kept for the reason shown to the agent. */
const MAX_REASON_CHARS = 2_000;

/**
 * Seam for tests: the consent lists to obey. `undefined` means the running
 * server's own, read from its config store.
 *
 * @internal Exported for testing only.
 */
export const _internal = {
  decisions: (): HookDecisions | undefined => undefined,
};

/** What {@link checkShellCommand} decided. */
export type ShellCommandVerdict =
  | { allowed: true }
  | {
      allowed: false;
      /** The guard's own words, or what went wrong with it. Shown to the agent. */
      reason: string;
      /** The package whose guard refused or failed. */
      packageName: string;
    };

/** One shell command about to run, as a runtime's own check sees it. */
export interface ShellCommandCheck {
  /** The runtime asking, for the child environment. Never `claude-code` or `codex`. */
  runtime: Extract<EnvironmentRuntime, 'opencode' | 'doe'>;
  /** The project the session runs in; its installed packages are the ones consulted. */
  cwd: string;
  /**
   * The exact command line the agent asked to run. Absent when the runtime
   * could not read one: refused if any shell check applies, since a guard
   * cannot clear a command it cannot see.
   */
  command: string | undefined;
  /** DorkOS session id, sent as `session_id`. */
  sessionId: string;
  /** The session's permission mode, sent as `permission_mode`. */
  permissionMode?: string;
  /** Aborts every running guard; the command is then blocked. */
  signal?: AbortSignal;
}

/** One guard to run: a package's `PreToolUse` command whose matcher covers `Bash`. */
interface ShellGuard {
  packageName: string;
  command: string;
  installRoot?: string;
}

/** The answer a guard gave, before it is turned into a verdict. */
type GuardOutcome = { kind: 'allow' } | { kind: 'refuse'; reason: string };

/** The guards that apply to a shell command, from the allowed packages. */
function shellGuards(allowed: readonly ConsentedHookPackage[]): ShellGuard[] {
  return allowed.flatMap(({ request, installRoots }) =>
    request.hooks.filter(isShellCheckHook).map((hook) => ({
      packageName: request.packageName,
      command: hook.command,
      ...(installRoots[0] !== undefined ? { installRoot: installRoots[0] } : {}),
    }))
  );
}

/** Single-quote a string for a POSIX shell (`'` becomes `'\''`). */
function shellQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

/**
 * The variables Claude Code gives a hook it runs, exported ahead of the
 * package's own command so a script reading them finds the same paths: the
 * project, and the plugin's root and data folders exactly as the Claude Code
 * settings merge exports them (`pluginEnvPrefix`).
 */
function hookEnvPrefix(cwd: string, installRoot: string | undefined): string {
  const plugin = installRoot === undefined ? '' : pluginEnvPrefix(installRoot, process.platform);
  return `export CLAUDE_PROJECT_DIR=${shellQuote(cwd)}; ${plugin}`;
}

/** The stdin Claude Code sends a `PreToolUse` hook for its `Bash` tool. */
function hookPayload(check: ShellCommandCheck & { command: string }): string {
  return JSON.stringify({
    session_id: check.sessionId,
    cwd: check.cwd,
    hook_event_name: 'PreToolUse',
    ...(check.permissionMode !== undefined ? { permission_mode: check.permissionMode } : {}),
    tool_name: 'Bash',
    tool_input: { command: check.command },
  });
}

/** Trim a guard's output to a reason a model can read. */
function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_REASON_CHARS ? `${trimmed.slice(0, MAX_REASON_CHARS)}…` : trimmed;
}

/**
 * Claude Code's JSON decision on stdout, when a guard that exited 0 still
 * refuses: `hookSpecificOutput.permissionDecision: "deny"` or the older
 * `decision: "block"`. Anything else is "no objection".
 */
function stdoutRefusal(stdout: string): string | undefined {
  const text = stdout.trim();
  if (!text.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(text) as {
      decision?: unknown;
      reason?: unknown;
      hookSpecificOutput?: { permissionDecision?: unknown; permissionDecisionReason?: unknown };
    };
    const specific = parsed.hookSpecificOutput;
    if (specific?.permissionDecision === 'deny') {
      return typeof specific.permissionDecisionReason === 'string'
        ? specific.permissionDecisionReason
        : '';
    }
    if (parsed.decision === 'block') return typeof parsed.reason === 'string' ? parsed.reason : '';
  } catch {
    // Not JSON after all: plain output from a guard that allowed the command.
  }
  return undefined;
}

/**
 * Run one guard and read its answer. Never throws: every way a guard can fail
 * comes back as a refusal.
 */
function runGuard(
  guard: ShellGuard,
  check: ShellCommandCheck & { command: string },
  timeoutMs: number
): Promise<GuardOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    // Set once the guard starts; `finish` may run before that, on a spawn failure.
    const deadline: { timer?: NodeJS.Timeout } = {};
    let child: ChildProcess | undefined;
    const finish = (outcome: GuardOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline.timer);
      check.signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const failed = (why: string): GuardOutcome => ({
      kind: 'refuse',
      reason: `A safety check from ${guard.packageName} ${why}, so this command was blocked.`,
    });
    // The guard runs in its own process group, so a stuck `node` under the
    // `sh -c` wrapper dies with it rather than outliving the refusal.
    const stop = (): void => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (POSIX && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const onAbort = (): void => {
      stop();
      finish(failed('was stopped before it finished'));
    };

    try {
      child = spawn(
        POSIX ? '/bin/sh' : 'sh',
        ['-c', hookEnvPrefix(check.cwd, guard.installRoot) + guard.command],
        {
          cwd: check.cwd,
          env: runtimeEnvironment(check.runtime, 'process-inspection'),
          detached: POSIX,
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );
    } catch (err) {
      logger.warn('[PackageHooks] A guard could not start', {
        packageName: guard.packageName,
        ...logError(err),
      });
      finish(failed('could not start'));
      return;
    }
    const running = child;
    deadline.timer = setTimeout(() => {
      stop();
      const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
      finish(failed(`did not finish within ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`));
    }, timeoutMs);
    deadline.timer.unref();
    if (check.signal?.aborted) onAbort();
    else check.signal?.addEventListener('abort', onAbort, { once: true });

    running.stdout?.setEncoding('utf8');
    running.stderr?.setEncoding('utf8');
    running.stdout?.on('data', (chunk: string) => {
      if (stdout.length < MAX_REASON_CHARS * 4) stdout += chunk;
    });
    running.stderr?.on('data', (chunk: string) => {
      if (stderr.length < MAX_REASON_CHARS * 4) stderr += chunk;
    });
    running.on('error', (err) => {
      logger.warn('[PackageHooks] A guard could not start', {
        packageName: guard.packageName,
        ...logError(err),
      });
      finish(failed('could not start'));
    });
    running.on('close', (code, signal) => {
      if (code === 0) {
        const refusal = stdoutRefusal(stdout);
        if (refusal === undefined) return finish({ kind: 'allow' });
        return finish({
          kind: 'refuse',
          reason: clip(refusal) || `A safety check from ${guard.packageName} blocked this command.`,
        });
      }
      if (code === 2) {
        return finish({
          kind: 'refuse',
          reason: clip(stderr) || `A safety check from ${guard.packageName} blocked this command.`,
        });
      }
      const detail = clip(stderr);
      return finish(
        failed(
          signal !== null
            ? `stopped with ${signal}`
            : `failed with exit code ${String(code)}${detail ? ` (${detail})` : ''}`
        )
      );
    });
    // The guard may exit before reading stdin (EPIPE); that is its answer, not an error.
    running.stdin?.on('error', () => undefined);
    running.stdin?.end(hookPayload(check));
  });
}

/**
 * Ask every allowed package's shell guard whether a command may run, in
 * install order, stopping at the first refusal.
 *
 * Packages are read fresh on every call, so a package installed, allowed,
 * edited or turned down mid-session governs the very next command. A project
 * with no hook packages spawns nothing.
 *
 * @param check - The command and where it runs.
 * @param timeoutMs - Per-guard limit; tests pass a short one.
 * @returns Allowed, or refused with the reason to give the agent.
 */
export async function checkShellCommand(
  check: ShellCommandCheck,
  timeoutMs: number = PACKAGE_HOOK_TIMEOUT_MS
): Promise<ShellCommandVerdict> {
  let guards: ShellGuard[];
  try {
    const dorkHome = resolveDorkHome();
    // Most projects declare no shell check: answer those without reading consent.
    const declared = scanHookRequests(check.cwd, dorkHome);
    if (!declared.some((request) => request.hooks.some(isShellCheckHook))) return { allowed: true };
    if (check.command === undefined || check.command.trim() === '') {
      return {
        allowed: false,
        packageName: 'DorkOS',
        reason: 'DorkOS could not read this shell command, so it was blocked.',
      };
    }
    const decisions = _internal.decisions();
    const opts = await withProvenInstalls(check.cwd, {
      dorkHome,
      ...(decisions ? { decisions } : {}),
    });
    guards = shellGuards(consentedHookPackages(check.cwd, opts).allowed);
  } catch (err) {
    // Unknowable is not "none installed": a guard that might exist is not skipped.
    logger.warn('[PackageHooks] Could not read the installed safety checks', logError(err));
    return {
      allowed: false,
      packageName: 'DorkOS',
      reason:
        "DorkOS could not read this project's installed safety checks, so this command was blocked.",
    };
  }
  const command = check.command ?? '';
  for (const guard of guards) {
    const outcome = await runGuard(guard, { ...check, command }, timeoutMs);
    if (outcome.kind === 'refuse') {
      logger.warn('[PackageHooks] A package guard refused a shell command', {
        sessionId: check.sessionId,
        runtime: check.runtime,
        packageName: guard.packageName,
      });
      return { allowed: false, packageName: guard.packageName, reason: outcome.reason };
    }
  }
  return { allowed: true };
}
