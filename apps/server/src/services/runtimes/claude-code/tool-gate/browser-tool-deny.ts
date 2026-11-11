/**
 * The agent-browser tools no agent is offered ({@link AGENT_BROWSER_WITHHELD_TOOLS}), refused on
 * Claude Code twice over:
 *
 * - a deny rule per server DorkOS hands the turn, merged into the launch's settings beside the
 *   others. Claude Code checks deny before allow, at every permission level, so neither
 *   `bypassPermissions` nor a saved `mcp__<server>__*` allow reopens one; and
 * - a `PreToolUse` hook for any server's tool of that name, in any letter case, which also covers
 *   a server Claude Code loads from its own settings (the account's or the project's), whose name
 *   DorkOS never sees. A hook's deny is decided in every mode too.
 *
 * The same hook refuses any browser call that names a file on this computer
 * ({@link AGENT_BROWSER_FILE_ARGUMENT}): a deny rule matches a tool, never its arguments.
 *
 * Named on every server rather than only the ones shaped like the agent browser, so a Playwright
 * server started through a wrapper script is covered too; a deny on a tool a server lacks does
 * nothing.
 *
 * @module services/runtimes/claude-code/tool-gate/browser-tool-deny
 */
import type { HookCallbackMatcher, Options } from '@anthropic-ai/claude-agent-sdk';
import {
  AGENT_BROWSER_WITHHELD_TOOLS,
  browserCallNamesFile,
  isWithheldBrowserTool,
} from '@dorkos/shared/agent-browser';

/** What the agent is told when it calls one anyway. */
export const WITHHELD_BROWSER_TOOL_MESSAGE =
  "Agents can't use this browser tool: it reaches past the page.";

/** What the agent is told when a browser call reaches a file on this computer. */
export const BROWSER_FILE_MESSAGE =
  "Agents can't reach files on this computer through the browser.";

/**
 * A server's name the way Claude Code spells it inside a tool name: anything but letters, digits,
 * `_` and `-` becomes `_`.
 */
function toolNamePart(serverName: string): string {
  return serverName.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * The deny rules that keep every withheld browser tool off each named server.
 *
 * @param serverNames - The MCP servers the turn is handed, by name.
 */
export function browserToolDenyRules(serverNames: Iterable<string>): string[] {
  const rules = new Set<string>();
  for (const name of serverNames) {
    for (const tool of AGENT_BROWSER_WITHHELD_TOOLS)
      rules.add(`mcp__${toolNamePart(name)}__${tool}`);
  }
  return [...rules];
}

/**
 * Deny the withheld browser tools on every server in `sdkOptions.mcpServers`. Run after the
 * turn's servers are final (the managed set and the repo's own), so none is missed.
 *
 * @param sdkOptions - The launch options, mutated in place.
 */
export function applyBrowserToolDeny(sdkOptions: Options): void {
  const rules = browserToolDenyRules(Object.keys(sdkOptions.mcpServers ?? {}));
  if (rules.length === 0) return;
  const base =
    typeof sdkOptions.settings === 'object' && sdkOptions.settings !== null
      ? sdkOptions.settings
      : {};
  const permissions = (base as { permissions?: { deny?: string[] } }).permissions ?? {};
  sdkOptions.settings = {
    ...base,
    permissions: { ...permissions, deny: [...(permissions.deny ?? []), ...rules] },
  } as Options['settings'];
}

/** A pattern that matches `text` in any letter case, for a matcher the CLI reads case-sensitively. */
function anyCase(text: string): string {
  return [...text]
    .map((char) => (/[a-z]/i.test(char) ? `[${char.toLowerCase()}${char.toUpperCase()}]` : char))
    .join('');
}

/** Any server's `browser_*` tool, in any case: the server part, then the tool's own name. */
const BROWSER_TOOL_NAME = /^mcp__.+__(browser_[^_].*)$/i;

/**
 * The `PreToolUse` entry that refuses, on any server and in any case, a withheld browser tool and
 * a browser call that names a file. A pattern, never a bare name list: the CLI reads a matcher of
 * word characters alone as exact tool names, and the anchor is what makes it a regex. It matches
 * every `browser_*` tool; the callback decides.
 */
export function browserToolHookMatcher(): HookCallbackMatcher {
  return {
    matcher: `^${anyCase('mcp__')}.+__${anyCase('browser_')}`,
    hooks: [
      async (hookInput) => {
        if (hookInput.hook_event_name !== 'PreToolUse') return {};
        const tool = BROWSER_TOOL_NAME.exec(hookInput.tool_name)?.[1];
        if (tool === undefined) return {};
        const reason = isWithheldBrowserTool(tool)
          ? WITHHELD_BROWSER_TOOL_MESSAGE
          : browserCallNamesFile(tool, hookInput.tool_input)
            ? BROWSER_FILE_MESSAGE
            : null;
        if (reason === null) return {};
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: reason,
          },
        };
      },
    ],
  };
}
