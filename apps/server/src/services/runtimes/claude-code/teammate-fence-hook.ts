/**
 * The teammate fence in Claude Code (DOR-2955): a `PreToolUse` hook that refuses every call a
 * teammate's turn may not make, before Claude Code's own permission rules are read.
 *
 * **A hook, not `canUseTool`, on purpose.** `canUseTool` is asked only about calls the CLI's own
 * rules did not already settle: a rule saved by an "Always allow" click, or an `allow` line in a
 * settings file, runs the tool without ever reaching it. A `PreToolUse` deny is decided first and
 * cannot be overridden by an allow rule, in every permission mode, for helper agents' calls too.
 * The decision itself lives in `core/turn-power/teammate-fence.ts`; this file only reads the call
 * Claude Code hands it.
 *
 * Read at CALL time from the session, never captured at launch: a warm process serves many turns,
 * and the fence belongs to whichever turn is running (`turn-bounds.ts` assigns it per send).
 *
 * @module services/runtimes/claude-code/teammate-fence-hook
 */
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { logRefusal } from '../../observability/refusals.js';
import {
  teammateFenceRefusal,
  type TeammateFenceCall,
} from '../../core/turn-power/teammate-fence.js';
import type { AgentSession } from './agent-types.js';
import { IN_SESSION_TOOL_PREFIX, isHostServedOrUnattributed } from './mcp-tools/tool-exposure.js';

/**
 * Where a call comes from, as the fence sees it. A tool named like a DorkOS tool but served by a
 * configured server (a project's `.mcp.json` may call itself `dorkos`) is another MCP server's.
 *
 * @param toolName - The name Claude Code reports.
 * @param provenance - The call's MCP server provenance, when Claude Code sent one.
 */
function sourceOf(
  toolName: string,
  provenance: { source: string } | undefined
): Pick<TeammateFenceCall, 'source' | 'name'> {
  if (toolName.startsWith(IN_SESSION_TOOL_PREFIX) && isHostServedOrUnattributed(provenance)) {
    return { source: 'dorkos', name: toolName.slice(IN_SESSION_TOOL_PREFIX.length) };
  }
  if (toolName.startsWith('mcp__')) return { source: 'mcp', name: toolName };
  return { source: 'built-in', name: toolName };
}

/**
 * The hook. Answers nothing (the call goes on to the ordinary gate) unless the running turn is a
 * teammate's and the fence refuses the call.
 *
 * @param session - The session whose running turn may be fenced.
 */
export function createTeammateFenceHook(
  session: Pick<AgentSession, 'teammateFence'>
): HookCallback {
  return async (hookInput) => {
    if (hookInput.hook_event_name !== 'PreToolUse') return {};
    const fence = session.teammateFence;
    if (!fence) return {};
    const input =
      hookInput.tool_input !== null && typeof hookInput.tool_input === 'object'
        ? (hookInput.tool_input as Record<string, unknown>)
        : {};
    const refusal = teammateFenceRefusal(fence, {
      ...sourceOf(hookInput.tool_name, hookInput.mcp_server),
      input,
    });
    if (refusal === null) return {};
    // Shown: the model is handed the reason and the transcript records the
    // refused call. Ids only, never what the teammate wrote.
    logRefusal('[claude-code] a teammate’s turn was refused a tool', {
      reason: 'teammate_fence',
      visibility: 'shown',
      roomId: fence.roomId,
      detail: { toolName: hookInput.tool_name },
    });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: refusal,
      },
    };
  };
}
