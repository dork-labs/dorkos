/**
 * Claude Code's side of the tool-read mark (DOR-3291, `core/turn-power/tool-read-marks.ts`).
 *
 * A `PostToolUse` hook, which the CLI awaits before it hands the tool's result to the model. It
 * does two things after every tool, on the main thread and in helpers alike:
 *
 * 1. **Marks** the turn when the tool read from outside: a web tool or another MCP server's tool
 *    (`nativeToolReadsOutside`), or a file read that leaves the agent's folders. DorkOS's own
 *    actions marked the turn already, at the capability registry.
 * 2. **Folds** a mark the turn now carries into the session's ceiling for this turn, as the bound
 *    that names it without capping power. Everything Claude Code reads the mark from reads that
 *    ceiling: the held-turn hook (Bash and git or `.dork` edits ask), `canUseTool` (no "Always
 *    allow"), and the ceiling background work keeps after the turn (`warm-ceiling.ts`).
 *
 * Answers nothing to the CLI: it only records.
 *
 * @module services/runtimes/claude-code/tool-gate/tool-read-hook
 */
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { TurnPermissionBound, TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import { CARRIED_OUTSIDER_LEVEL } from '@dorkos/shared/permission-semantics';
import { marksOf } from '../../../core/turn-power/turn-levels.js';
import { markToolRead } from '../../../core/turn-power/tool-read-marks.js';
import { nativeToolReadsOutside } from '../../../core/turn-power/native-tool-reads.js';
import { carriesOutsiderMark } from '../turn-permission.js';
import { fileReadStaysInside, isFileReadTool } from './held-turn-reads.js';
import type { HeldTurnFolders } from './held-turn-hook.js';

/** The session fields the hook reads and writes, read at call time. */
export interface ToolReadSession {
  /** The session's id once the CLI assigned it. */
  sdkSessionId?: string;
  /** This turn's ceiling, assigned on every send; the hook adds the tool-read bound to it. */
  turnPermissionCeiling?: TurnPermissionCeiling;
  /** The ceiling background work from an earlier turn still runs under. */
  backgroundPermissionCeiling?: TurnPermissionCeiling;
}

/** The bound a folded tool-read mark rides as: the loosest level, marked. */
const TOOL_READ_BOUND: TurnPermissionBound = Object.freeze({
  ...CARRIED_OUTSIDER_LEVEL,
  toolRead: true as const,
});

/**
 * Whether one of the CLI's own tools read from outside the agent's folders or off this computer.
 *
 * @param toolName - The tool.
 * @param input - Its arguments.
 * @param folders - The agent's folders.
 */
export function cliToolReadsOutside(
  toolName: string,
  input: Record<string, unknown>,
  folders: HeldTurnFolders
): boolean {
  if (nativeToolReadsOutside(toolName)) return true;
  return (
    isFileReadTool(toolName) && !fileReadStaysInside(toolName, input, folders.cwd, folders.roots)
  );
}

/**
 * The hook.
 *
 * @param session - The live session, whose ceiling the hook adds to.
 * @param sessionId - The id the turn was sent under.
 * @param agentPath - The agent the turn runs as, for a turn this process recorded under no id here.
 * @param folders - The agent's folders, for the file reads that stay inside.
 */
export function createToolReadHook(
  session: ToolReadSession,
  sessionId: string,
  agentPath: string | undefined,
  folders: HeldTurnFolders
): HookCallback {
  return async (hookInput) => {
    if (hookInput.hook_event_name !== 'PostToolUse') return {};
    const key = session.sdkSessionId ?? sessionId;
    const input =
      hookInput.tool_input !== null && typeof hookInput.tool_input === 'object'
        ? (hookInput.tool_input as Record<string, unknown>)
        : {};
    if (cliToolReadsOutside(hookInput.tool_name, input, folders)) {
      markToolRead({ sessionId: key, ...(agentPath ? { agentPath } : {}) });
    }
    const marked = [key, sessionId].some((id) => marksOf(id, agentPath).toolRead === true);
    if (marked && !carriesOutsiderMark(session)) {
      const ceiling = session.turnPermissionCeiling;
      session.turnPermissionCeiling =
        ceiling === undefined
          ? TOOL_READ_BOUND
          : [
              ...(Array.isArray(ceiling)
                ? (ceiling as readonly TurnPermissionBound[])
                : [ceiling as TurnPermissionBound]),
              TOOL_READ_BOUND,
            ];
    }
    return {};
  };
}
