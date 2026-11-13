/**
 * The guards every Claude Code launch puts on MCP tools, in one place: the
 * browser tools no agent is offered, and a managed server the agent no longer
 * gets (DOR-3872).
 *
 * @module services/runtimes/claude-code/tool-gate/mcp-tool-guards
 */
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { browserToolHookMatcher } from './browser-tool-deny.js';
import { managedServerHookMatcher } from './managed-server-deny.js';

export { applyBrowserToolDeny } from './browser-tool-deny.js';

/**
 * The `PreToolUse` entries for MCP tools, for one launch.
 *
 * @param agentDir - The folder of the agent the chat acts as, if any.
 */
export function mcpToolHookMatchers(agentDir: string | null | undefined): HookCallbackMatcher[] {
  return [
    // A browser tool that runs code outside the page, on any server, at every level.
    browserToolHookMatcher(),
    // A server the agent no longer gets, refused at its next call.
    managedServerHookMatcher(agentDir),
  ];
}
