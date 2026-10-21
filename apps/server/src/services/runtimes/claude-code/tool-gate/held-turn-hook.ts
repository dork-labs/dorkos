/**
 * A held turn asks about the calls the folder's own allow rules would have run (DOR-3204).
 *
 * A turn held to the runtime's default (a stranger's message, a Wi-Fi sign-in, a teammate, a
 * continuation of one: `ceilingOn` answers `'stranger'`) runs Claude Code in Default mode. Default
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
import { ceilingOn, type CeilingedMode } from '../turn-permission.js';
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
    // The runtime-default bound always holds Claude Code to Default (or stricter), a mode that
    // asks, so there is no mode here that would mean "do not ask".
    if (ceilingOn(session) !== 'stranger') return {};
    const toolName = hookInput.tool_name;
    if (PASS_THROUGH_TOOLS.has(toolName)) return {};
    const input =
      hookInput.tool_input !== null && typeof hookInput.tool_input === 'object'
        ? (hookInput.tool_input as Record<string, unknown>)
        : {};
    if (fileReadStaysInside(toolName, input, folders.cwd, folders.roots)) return {};
    if (
      toolName === 'Bash' &&
      typeof input.command === 'string' &&
      isPlainReadCommand(input.command)
    ) {
      return {};
    }
    if (
      await dorkosAutoAllows(session, toolName, input, hookInput.mcp_server, resolveIdentity, log)
    ) {
      return {};
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: HELD_TURN_ASK_REASON,
      },
    };
  };
}
