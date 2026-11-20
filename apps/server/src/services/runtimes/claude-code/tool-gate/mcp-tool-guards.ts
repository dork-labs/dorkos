/**
 * The guards every Claude Code launch puts on MCP tools, in one place: a read
 * of outside text marks the turn before it runs (DOR-3969), the browser tools
 * no agent is offered, and a managed server the agent no longer gets (DOR-3872).
 *
 * @module services/runtimes/claude-code/tool-gate/mcp-tool-guards
 */
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { browserToolHookMatcher } from './browser-tool-deny.js';
import { managedServerHookMatcher } from './managed-server-deny.js';
import { outsideTextHookMatcher } from './outside-text-hook.js';

export { applyBrowserToolDeny } from './browser-tool-deny.js';

/**
 * The `PreToolUse` entries for MCP tools, for one launch. The outside-text mark comes first, so a
 * read is marked even when a later entry refuses it (the safer side).
 *
 * @param agentDir - The folder of the agent the chat acts as, if any.
 * @param sessionId - The chat's current id, read at call time; marks nothing when absent.
 */
export function mcpToolHookMatchers(
  agentDir: string | null | undefined,
  sessionId?: () => string
): HookCallbackMatcher[] {
  return [
    // A page, a search or another server's answer marks the turn before it runs (DOR-3969).
    ...(sessionId ? [outsideTextHookMatcher(sessionId, agentDir)] : []),
    // A browser tool that runs code outside the page, on any server, at every level.
    browserToolHookMatcher(),
    // A server the agent no longer gets, refused at its next call.
    managedServerHookMatcher(agentDir),
  ];
}
