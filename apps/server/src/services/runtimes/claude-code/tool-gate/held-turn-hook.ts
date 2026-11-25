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
 * **Below Full on any turn, the same answer for a rule nobody approved (DOR-5237).** A turn that
 * is not held gets the same `ask` when the launch's folder-settings check says a person must
 * decide (`folder-file-allows.ts`). The same calls pass through, plus, under Accept edits, an edit
 * inside the working folder, which that mode runs anyway.
 *
 * @module services/runtimes/claude-code/tool-gate/held-turn-hook
 */
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionModeId } from '@dorkos/shared/schemas';
import path from 'node:path';
import {
  chosenFullAutonomy,
  gatePermissionMode,
  heldForOutsider,
  type CeilingedMode,
} from '../turn-permission.js';
import { dorkosAutoAllows } from './auto-allow.js';
import {
  fileReadStaysInside,
  isPlainReadCommand,
  realLocation,
  type ReadFolders,
} from './held-turn-reads.js';
import type { ToolGateLogger } from '../messaging/interactive-handlers.js';
import type { FolderAllowWatch } from './folder-file-allows.js';

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

/**
 * The hook. Answers nothing unless the running turn (or background work an earlier one left) is
 * held to the runtime's default, or the call is one only a folder rule nobody approved could allow,
 * and the call is one DorkOS would not run unasked anyway, or a read that stays inside the agent's
 * folders (`held-turn-reads.ts`).
 *
 * @param session - The session's chosen mode and both ceilings.
 * @param resolveIdentity - The memoized session-identity resolver `canUseTool` uses.
 * @param log - Where a failed identity lookup is reported.
 * @param folders - The agent's folders, for the reads let through.
 * @param folderAllows - The launch's check of the folder's own allow rules (DOR-5237).
 */
export function createHeldTurnHook(
  session: CeilingedMode<PermissionModeId>,
  resolveIdentity: () => Promise<unknown>,
  log: ToolGateLogger,
  folders: ReadFolders,
  folderAllows?: Pick<FolderAllowWatch, 'mustAsk'>
): HookCallback {
  return async (hookInput) => {
    if (hookInput.hook_event_name !== 'PreToolUse') return {};
    // A chat set to Full autonomy asks nobody anything (DOR-3394): no mark, carried ceiling or
    // stranger's hold sends one of its calls to a person. Read from the chat's own setting, never
    // from the mode a ceiling held the launch to; `canUseTool` answers the same way.
    if (chosenFullAutonomy(session)) return {};
    const toolName = hookInput.tool_name;
    const input =
      hookInput.tool_input !== null && typeof hookInput.tool_input === 'object'
        ? (hookInput.tool_input as Record<string, unknown>)
        : {};
    const held = heldForOutsider(session);
    // A held turn runs at Default or stricter, a mode that asks.
    if (PASS_THROUGH_TOOLS.has(toolName)) return {};
    if (
      !held &&
      (acceptEditsRunsIt(session, toolName, input, folders.cwd) ||
        !(await folderAllows?.mustAsk(toolName, input)))
    ) {
      return {};
    }
    if (fileReadStaysInside(toolName, input, folders.cwd, folders.roots)) return {};
    if (
      toolName === 'Bash' &&
      typeof input.command === 'string' &&
      isPlainReadCommand(input.command, folders.cwd, folders.roots)
    ) {
      return {};
    }
    if (
      await dorkosAutoAllows(
        session,
        toolName,
        input,
        hookInput.mcp_server,
        resolveIdentity,
        log,
        folders
      )
    ) {
      return {};
    }
    return held ? ASK : askFor(FOLDER_RULE_ASK_REASON);
  };
}

/** The file tools Accept edits runs inside the working folder, and the field each names its file in. */
const EDIT_PATHS: Readonly<Record<string, string>> = {
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

/**
 * Whether the turn's mode is Accept edits and the call edits a file inside the working folder, by
 * real path: the mode runs that with no card, so asking adds nothing.
 */
function acceptEditsRunsIt(
  session: CeilingedMode<PermissionModeId>,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string
): boolean {
  const field = EDIT_PATHS[toolName];
  const target = field === undefined ? undefined : input[field];
  if (gatePermissionMode(session) !== 'acceptEdits' || typeof target !== 'string' || !target) {
    return false;
  }
  const rel = path.relative(
    realLocation(path.resolve(cwd)),
    realLocation(path.resolve(cwd, target))
  );
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** What the model is told when only a folder rule nobody approved would have run a call. */
export const FOLDER_RULE_ASK_REASON =
  'A person has not approved the folder allow rule that would run this, so they decide.';

/** The hook's answer when a person must decide, and why. */
function askFor(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'ask' as const,
      permissionDecisionReason: reason,
    },
  };
}

/** The hook's answer on a held turn. */
const ASK = askFor(HELD_TURN_ASK_REASON);
