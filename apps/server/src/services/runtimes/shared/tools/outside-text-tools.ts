/**
 * Which tool calls inside an agent's own runtime hand its turn someone else's text (DOR-3969,
 * spec §4.7): a web page, a search result, an answer from another MCP server. Such a call marks the
 * turn as one that read outside text (`markRunningTurnOutsider`), so a send, a destructive action
 * or a room post later in that turn carries the mark.
 *
 * Two places ask: Claude Code's `PreToolUse` hook, before the tool runs (`outside-text-hook.ts`),
 * and the stream every runtime's turn passes through (`audit/record-tool-use.ts`), as the call
 * starts, for Codex, OpenCode and Doe, which have no hook that runs first.
 *
 * DorkOS's own tools, its connected-app tools included, are never answered here: the server marks
 * those itself when they return outside text (`core/capabilities/dorkos-tool-reads.ts`). Local tools
 * (file reads, searches, edits, the shell) never mark here.
 *
 * OpenCode spells another server's tool `server_tool`, with no marker, so there every tool that is
 * not one of its own known local tools marks: an unknown name, or none, fails closed.
 *
 * @module services/runtimes/shared/tools/outside-text-tools
 */
import { DORKOS_CONNECTIONS_SERVER_NAME } from '@dorkos/shared/global-mcp-schemas';
import {
  CLAUDE_CODE_DORKOS_TOOL_PREFIX,
  CODEX_DORKOS_TOOL_PREFIX,
  OPENCODE_DORKOS_TOOL_PREFIX,
} from '../dorkos-tool-names.js';

/** Claude Code's tools that bring in outside text: a page, a web search, an MCP server's resource. */
const CLAUDE_CODE_OUTSIDE_TOOLS: ReadonlySet<string> = new Set([
  'WebFetch',
  'WebSearch',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
]);

/** How Claude Code and Codex spell a tool on DorkOS's connected-app server, which marks its own reads. */
const CONNECTIONS_PREFIX = `mcp__${DORKOS_CONNECTIONS_SERVER_NAME}__`;

/**
 * The `matcher` Claude Code's hook is registered under. It carries `^`, so the CLI reads it as a
 * regular expression rather than a list of exact names (`CLASSIFIER_CONTEXT_MATCHER`'s TSDoc has
 * the rule). It is wider than the answer on purpose: {@link toolReadsOutsideText} leaves DorkOS's
 * own tools out, and a matcher too narrow would fail with no symptom.
 */
export const CLAUDE_CODE_OUTSIDE_TEXT_MATCHER =
  '^(WebFetch|WebSearch|ListMcpResourcesTool|ReadMcpResourceTool)$|^mcp__';

/** Codex's tool that searches the web. Codex has no page fetch of its own. */
const CODEX_WEB_SEARCH = 'WebSearch';

/**
 * OpenCode's own tools that only touch this computer, or run nothing by themselves. Not `task`: a
 * helper it starts may read anything, so starting one marks.
 */
const OPENCODE_LOCAL_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'read',
  'write',
  'edit',
  'multiedit',
  'patch',
  'apply_patch',
  'list',
  'glob',
  'grep',
  'lsp',
  'todowrite',
  'todoread',
  'skill',
  'question',
  'invalid',
]);

/** Doe's page fetch, and the prefix it gives another server's tools (`mcpAlias`). */
const DOE_WEB_FETCH = 'web_fetch';
const DOE_MCP_PREFIX = 'mcp_';
const DOE_CONNECTIONS_PREFIX = `mcp_${DORKOS_CONNECTIONS_SERVER_NAME}_`;

/** Whether an `mcp__server__tool` name is another server's: neither DorkOS's own nor its connected apps'. */
function isOtherServerTool(toolName: string, dorkosPrefix: string): boolean {
  return (
    toolName.startsWith('mcp__') &&
    !toolName.startsWith(dorkosPrefix) &&
    !toolName.startsWith(CONNECTIONS_PREFIX)
  );
}

/**
 * Whether a tool call, as this runtime names it, hands the turn someone else's text.
 *
 * @param runtime - The runtime's type.
 * @param toolName - The tool's name as that runtime reported it.
 */
export function toolReadsOutsideText(runtime: string, toolName: string): boolean {
  switch (runtime) {
    case 'claude-code':
      return (
        CLAUDE_CODE_OUTSIDE_TOOLS.has(toolName) ||
        isOtherServerTool(toolName, CLAUDE_CODE_DORKOS_TOOL_PREFIX)
      );
    case 'codex':
      return toolName === CODEX_WEB_SEARCH || isOtherServerTool(toolName, CODEX_DORKOS_TOOL_PREFIX);
    case 'opencode':
      return (
        !OPENCODE_LOCAL_TOOLS.has(toolName) && !toolName.startsWith(OPENCODE_DORKOS_TOOL_PREFIX)
      );
    case 'doe':
      return (
        toolName === DOE_WEB_FETCH ||
        (toolName.startsWith(DOE_MCP_PREFIX) && !toolName.startsWith(DOE_CONNECTIONS_PREFIX))
      );
    default:
      return false;
  }
}
