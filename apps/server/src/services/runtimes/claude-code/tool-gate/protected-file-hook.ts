/**
 * DorkOS's protected-file checks, answered before Claude Code's own card (DOR-4060).
 *
 * Below Full, Claude Code puts a DorkOS tool to a person through `canUseTool`
 * before the call ever reaches DorkOS's tool server, so a check in the server
 * alone would come after a card, and after a saved "Always allow". A
 * `PreToolUse` deny is decided first, in every mode, so these calls are refused
 * with no card at any level. The tool server asks the same checks again
 * (`pre-gate-refusals.ts`), which is what covers Codex and OpenCode.
 *
 * @module services/runtimes/claude-code/tool-gate/protected-file-hook
 */
import type { HookCallback, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { preGateMessage } from '../../../core/capabilities/pre-gate-refusals.js';
import { IN_SESSION_TOOL_PREFIX } from '../mcp-tools/tool-exposure.js';

/** Each guarded tool, by its in-session name, and the id its early check is registered under. */
const GUARDED: Readonly<Record<string, string>> = {
  session_start: 'session_start',
  control_ui: 'ui.control',
  read_canvas_document: 'ui.read_canvas_document',
  post_to_room: 'rooms.post',
  read_canvas: 'rooms.read_canvas',
};

/** Where the turn stands, read once at launch. */
export interface ProtectedFileHookTurn {
  /**
   * The session id the tool server acts under, read at call time: a new
   * session is rekeyed mid-first-turn, and the canvas follows the new id.
   */
  sessionId: () => string;
  /** The folder the turn stands in. */
  cwd: string;
  /** The agent's own home, when the turn is an agent's. */
  agentPath?: string;
}

/**
 * The hook. Denies a guarded DorkOS tool whose early check refuses, and answers
 * nothing for any other call.
 *
 * @param turn - Where the turn stands.
 */
export function createProtectedFileHook(turn: ProtectedFileHookTurn): HookCallback {
  return async (hookInput) => {
    if (hookInput.hook_event_name !== 'PreToolUse') return {};
    const name = hookInput.tool_name.startsWith(IN_SESSION_TOOL_PREFIX)
      ? hookInput.tool_name.slice(IN_SESSION_TOOL_PREFIX.length)
      : null;
    const id = name === null ? undefined : GUARDED[name];
    if (id === undefined) return {};
    const message = preGateMessage(id, hookInput.tool_input, {
      sessionId: turn.sessionId(),
      cwd: turn.cwd,
      ...(turn.agentPath ? { agentPath: turn.agentPath } : {}),
    });
    if (message === null) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: message,
      },
    };
  };
}

/**
 * The matcher entry, first in the turn's `PreToolUse` list. A pattern, never a
 * bare name list: the CLI reads a matcher of word characters alone as exact tool
 * names, and the anchor is what makes it a regex.
 *
 * @param turn - Where the turn stands.
 */
export function protectedFileMatcher(turn: ProtectedFileHookTurn): HookCallbackMatcher {
  return {
    matcher: `^${IN_SESSION_TOOL_PREFIX}(?:${Object.keys(GUARDED).join('|')})$`,
    hooks: [createProtectedFileHook(turn)],
  };
}
