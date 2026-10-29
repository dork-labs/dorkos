/**
 * A held turn asks about the calls the folder's own allow rules would have run (DOR-3204).
 *
 * A turn held for words DorkOS cannot vouch for (a stranger's message, a Wi-Fi sign-in, a teammate,
 * a chat or spin-off one of those reached: `heldForOutsider`) runs Claude Code in Default mode. Default
 * still honours the `permissions.allow` lines in the folder's `.claude/settings*.json`, so a rule
 * such as `Bash(python3 *)` would run that command without ever reaching `canUseTool`, and the
 * held turn would get no card.
 *
 * **A `PreToolUse` hook, not dropping the settings layers.** Loading no `local`/`project` settings
 * would close the gap but also drop the folder's deny rules and its own hooks, which still guard a
 * held turn. A hook's `ask` is decided before the CLI's allow rules and sends the call to
 * `canUseTool`, while a deny rule still refuses it, so allow rules become cards and nothing else
 * changes. `canUseTool` then decides as it always does, and offers no "Always allow" on a held
 * turn's card.
 *
 * Read at CALL time from the session, never captured at launch: a warm process serves many turns
 * (`turn-bounds.ts` assigns the ceiling per send), and background work an earlier held turn left
 * running keeps its ceiling too.
 *
 * @module services/runtimes/claude-code/tool-gate/held-turn-hook
 */
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionModeId } from '@dorkos/shared/schemas';
import { carriesOutsiderMark, heldForOutsider, type CeilingedMode } from '../turn-permission.js';
import { dorkosAutoAllows } from './auto-allow.js';
import { fileReadStaysInside, isPlainReadCommand } from './held-turn-reads.js';
import type { ToolGateLogger } from '../messaging/interactive-handlers.js';

/**
 * Tools that pass through untouched: the CLI's own bookkeeping, which runs nothing on the computer
 * by itself. A helper's own calls, and the tools a skill uses, come through this hook one by one.
 */
const PASS_THROUGH_TOOLS: ReadonlySet<string> = new Set([
  'AskUserQuestion',
  'Skill',
  'TodoWrite',
  'Task',
  'Agent',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'TaskOutput',
  'TaskStop',
  'BashOutput',
  'KillShell',
  'ToolSearch',
  'EnterPlanMode',
  'ExitPlanMode',
]);

/** What the model is told when a call it could have run is put to a person instead. */
export const HELD_TURN_ASK_REASON =
  'This turn came from somewhere DorkOS cannot vouch for, so the folder’s allow rules do not apply.';

/** The agent's folders, as this launch granted them. */
export interface HeldTurnFolders {
  /** The working folder, which relative paths resolve against. */
  cwd: string;
  /** Every folder a read may stay inside: the working folder and this turn's grants. */
  roots: readonly string[];
}

/**
 * The hook. Answers nothing unless the running turn (or background work an earlier one left) is
 * held to the runtime's default and the call is one DorkOS would not run unasked anyway, or a read
 * that stays inside the agent's folders (`held-turn-reads.ts`).
 *
 * @param session - The session's chosen mode and both ceilings.
 * @param resolveIdentity - The memoized session-identity resolver `canUseTool` uses.
 * @param log - Where a failed identity lookup is reported.
 * @param folders - The agent's folders, for the reads let through.
 */
export function createHeldTurnHook(
  session: CeilingedMode<PermissionModeId>,
  resolveIdentity: () => Promise<unknown>,
  log: ToolGateLogger,
  folders: HeldTurnFolders
): HookCallback {
  return async (hookInput) => {
    if (hookInput.hook_event_name !== 'PreToolUse') return {};
    const toolName = hookInput.tool_name;
    const input =
      hookInput.tool_input !== null && typeof hookInput.tool_input === 'object'
        ? (hookInput.tool_input as Record<string, unknown>)
        : {};
    // A turn that only carries an outsider's words on runs at its own level (DOR-3390). Until
    // its shell runs sandboxed, only Bash asks: `canUseTool` puts it to a person at any level
    // (`asksForCarriedShell`). Edit and Write still meet the folder's deny rules.
    if (!heldForOutsider(session)) {
      if (!carriesOutsiderMark(session) || !asksForCarriedShell(toolName, input, folders)) {
        return {};
      }
      return CARRIED_ASK;
    }
    // A stranger's turn runs at Default or stricter, a mode that asks.
    if (PASS_THROUGH_TOOLS.has(toolName)) return {};
    if (fileReadStaysInside(toolName, input, folders.cwd, folders.roots)) return {};
    if (
      toolName === 'Bash' &&
      typeof input.command === 'string' &&
      isPlainReadCommand(input.command, folders.cwd, folders.roots)
    ) {
      return {};
    }
    if (
      await dorkosAutoAllows(session, toolName, input, hookInput.mcp_server, resolveIdentity, log)
    ) {
      return {};
    }
    return ASK;
  };
}

/** What the model is told when a shell command in a turn that carries outsider words is asked. */
export const CARRIED_SHELL_ASK_REASON =
  'This turn read words DorkOS can’t vouch for, so its shell commands need a person’s OK.';

/** The hook's answer when a person must decide. */
const ask = (reason: string) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse' as const,
    permissionDecision: 'ask' as const,
    permissionDecisionReason: reason,
  },
});
const ASK = ask(HELD_TURN_ASK_REASON);
const CARRIED_ASK = ask(CARRIED_SHELL_ASK_REASON);

/**
 * Whether a call in a turn that carries an outsider's words on goes to a person (DOR-3390,
 * Security's interim until the shell is sandboxed): a Bash command, unless it only reads inside
 * the agent's folders. Everything else runs at the turn's own level.
 *
 * @param toolName - The tool the model called.
 * @param input - Its arguments.
 * @param folders - The agent's folders, for the reads let through.
 */
export function asksForCarriedShell(
  toolName: string,
  input: Record<string, unknown>,
  folders: HeldTurnFolders
): boolean {
  if (toolName !== 'Bash') return false;
  return !(
    typeof input.command === 'string' &&
    isPlainReadCommand(input.command, folders.cwd, folders.roots)
  );
}
