/**
 * The shell's route to protected files (DOR-3300, part 2 of DOR-3299).
 *
 * Claude Code runs read-only shell commands (`grep -r`, `rg -uu`, `head`, `sed -n`) without asking,
 * and before `canUseTool` is ever called. So this is a `PreToolUse` hook, and it does two things:
 *
 * - **Reads ask.** Below Full, a command that names a protected read path that exists, or searches
 *   a folder that holds one, goes to a person (`ask`), also when chained after an allowed command.
 *   At Never ask the CLI turns that `ask` into a refusal. At Full nothing changes: `cat` still
 *   reads, the stated limit of that level.
 * - **Setup writes are refused.** At every level, a command that plainly writes an agent's setup
 *   files (`AGENT_HOME_SELF_GRANT_PATHS` and the rest of its `.claude/`) is refused and audited,
 *   because the file-tool denies never covered the shell (DOR-3300, two cases on 2026-11-01). An
 *   agent a person opened its own folder to (`own-folder-open.ts`) may still write its own, except
 *   its `.dork/agent.json`. A script that only mentions such a file is not refused: a false refusal
 *   at Full has no way past it.
 * - **Too much to read is refused too.** The reading happens in the guard's own process
 *   (`guard-host.ts`), on text an agent chose. A write past a cap, a timeout or a crash is refused
 *   at every level, so padding can't hide a write. A read past a cap asks.
 * - **No check at all never means no stop.** When the guard's process can't start, DorkOS can't read
 *   the command, and the server won't do that reading itself. Below Full, a command that names a
 *   setup file is refused and the rest ask. At Full the shell stops, unless a person chose to go on.
 *
 * **A mitigation, not a boundary.** This reads command text. A path built while the command runs
 * (`$(printf …)`, base64, a script file) gets through; `shell-path-guard.test.ts` records such
 * cases as the known limit. The real boundary is agents running as a separate OS user (DOR-3053).
 *
 * @module services/runtimes/claude-code/shell-guard/shell-path-guard
 */
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionModeId } from '@dorkos/shared/schemas';
import { chosenFullAutonomy, gatePermissionMode, type CeilingedMode } from '../turn-permission.js';
import type { ShellChecker } from './guard-host.js';
import { namesSetup, type ShellGuardRoots } from './shell-check.js';

/** What the model is told when a shell read is put to a person. */
export const SHELL_READ_ASK_REASON =
  'This command reaches a protected file, so a person decides whether it runs.';

/** What the model is told when a shell write to setup files is refused. */
export const SHELL_WRITE_DENY_REASON =
  'An agent’s shell can’t change an agent’s setup files. Post the change for a person to apply.';

/** What the model is told when a command is too much to check. */
export const SHELL_UNREADABLE_DENY_REASON =
  'DorkOS could not check this command, so it did not run. If it is long or opens into many paths, split it into smaller commands.';

/**
 * What the model is told when the check didn't start. Under load that is most often just slow, so
 * the same command usually runs on a retry (DOR-4304). Reworded, it would be the same command.
 */
export const SHELL_NO_CHECK_REASON =
  'DorkOS’s check on shell commands didn’t start in time, so this command did not run. Retry this exact command in a few seconds. Don’t reword it.';

/** What the model is told when the check still can't start, and a person has been told. */
export const SHELL_NO_CHECK_TOLD_REASON =
  'DorkOS still can’t check shell commands, so this command did not run. A person has been told. Retry this exact command later. Don’t reword it.';

/** What a person is asked when DorkOS has no check to run. */
export const SHELL_NO_CHECK_ASK_REASON =
  'DorkOS can’t check this command for protected files, so a person decides.';

/** The tools that take a shell command. */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'Monitor', 'PowerShell']);

/**
 * Why a shell command was refused: `writes` it writes an agent's setup files, `unreadable` it is too
 * much to read, `failed` the check broke on it, `no-check` the check never started.
 */
export type ShellRefusalVerdict = 'writes' | 'unreadable' | 'failed' | 'no-check';

/** Called with the shell call that was refused, and why. */
export type ShellRefusalRecorder = (call: {
  toolName: string;
  toolUseId: string;
  command: string;
  agentId?: string;
  verdict: ShellRefusalVerdict;
}) => void;

/** What the hook needs beyond the session. */
export interface ShellGuardOptions {
  /** This launch's folders, read at each call. */
  roots: () => ShellGuardRoots;
  /** Reads the command, in the guard's own process. */
  check: ShellChecker;
  /** Whether a person chose to go on at Full without the check, until restart. */
  goingOnWithoutCheck?: () => boolean;
  /** Writes the refused call to the audit log. */
  recordRefusal: ShellRefusalRecorder;
  /** Reports what the hook decided. */
  log: {
    info(message: string, data: Record<string, unknown>): void;
    warn(message: string, data: Record<string, unknown>): void;
  };
}

/**
 * The hook. Read at call time from the session: a warm process serves many turns.
 *
 * @param session - The session's chosen mode and both ceilings.
 * @param options - The folders, the audit recorder and the log.
 */
export function createShellPathGuardHook(
  session: CeilingedMode<PermissionModeId>,
  options: ShellGuardOptions
): HookCallback {
  const { roots, check, goingOnWithoutCheck, recordRefusal, log } = options;
  return async (hookInput) => {
    if (hookInput.hook_event_name !== 'PreToolUse') return {};
    if (!SHELL_TOOLS.has(hookInput.tool_name)) return {};
    const input = hookInput.tool_input as { command?: unknown } | null;
    const command = input?.command;
    if (typeof command !== 'string') return {};
    /** Refuse and audit. Never the command in the log: it may hold a token. */
    const refuse = (reason: string, verdict: ShellRefusalVerdict) => {
      log.info('[ShellGuard] refused a shell command', { verdict });
      recordRefusal({
        toolName: hookInput.tool_name,
        toolUseId: hookInput.tool_use_id,
        command,
        ...(hookInput.agent_id ? { agentId: hookInput.agent_id } : {}),
        verdict,
      });
      return decision('deny', reason);
    };
    // At Full the shell reads what it names: the stated limit of that level.
    const runsAtFull = gatePermissionMode(session) === 'bypassPermissions';
    const full = chosenFullAutonomy(session) || runsAtFull;
    let result: Awaited<ReturnType<ShellChecker>>;
    try {
      // A browser sign-in store opens only at the level the command really runs at: a chat set to
      // Full whose turn a stranger's words started stays below Full for it (DOR-4136).
      result = await check(command, { ...roots(), full: runsAtFull }, !full);
    } catch (err) {
      // This is the only stop at Full, so a check that can't answer refuses (Security, #3487). Only
      // the error's name in the log: its message could carry a path from the command.
      log.warn('[ShellGuard] the check failed; refusing', {
        error: err instanceof Error ? err.name : 'unknown',
      });
      result = { outcome: 'failed' };
    }
    if (result.outcome === 'unavailable') {
      // Still a refusal: only the words change once a person has been told (DOR-4304).
      const noCheck = result.told ? SHELL_NO_CHECK_TOLD_REASON : SHELL_NO_CHECK_REASON;
      if (full) {
        return goingOnWithoutCheck?.() ? {} : refuse(noCheck, 'no-check');
      }
      if (namesSetup(command)) return refuse(noCheck, 'no-check');
      log.info('[ShellGuard] no check to run; asking', {});
      return decision('ask', SHELL_NO_CHECK_ASK_REASON);
    }
    if (result.outcome === 'failed') return refuse(SHELL_UNREADABLE_DENY_REASON, 'failed');
    if (result.write !== 'none') {
      return refuse(
        result.write === 'writes' ? SHELL_WRITE_DENY_REASON : SHELL_UNREADABLE_DENY_REASON,
        result.write
      );
    }
    if (!result.reaches) return {};
    log.info('[ShellGuard] a shell command reaches a protected file; asking', {});
    return decision('ask', SHELL_READ_ASK_REASON);
  };
}

/** A `PreToolUse` answer. */
function decision(permissionDecision: 'ask' | 'deny', permissionDecisionReason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision,
      permissionDecisionReason,
    },
  };
}
