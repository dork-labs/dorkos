/**
 * A server an agent no longer gets is refused at the very next call, in a chat
 * that is already running (DOR-3872).
 *
 * A running chat keeps the MCP servers it was handed until its next turn swaps
 * them, so a server a person removed, turned off or kept from this agent could
 * still be called mid-turn, from a helper, or by a process that has not had a
 * turn since. This `PreToolUse` hook reads the agent's servers fresh on every MCP
 * call and refuses one whose server this chat had and no longer gets. A hook's
 * deny is decided in every mode, `bypassPermissions` included.
 *
 * Only servers DorkOS manages for the agent (its own and the ones for every
 * agent) are tracked, so an agent's own server of the same name stays usable. A
 * server the repo or the account loads under the SAME name as a removed one is
 * refused too, because its tool names are identical; that is the safer side.
 * One under any other name is never touched.
 *
 * @module services/runtimes/claude-code/tool-gate/managed-server-deny
 */
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';

/** What the agent is told when it calls one. */
export const REMOVED_SERVER_MESSAGE =
  'This MCP server was removed or turned off for you, so its tools no longer run.';

/** The names of the MCP servers DorkOS hands an agent right now. */
type ManagedServerNames = (agentDir: string) => readonly string[];

let managedServerNames: ManagedServerNames = () => [];

/**
 * Wire how the hook reads an agent's managed servers. Set once at startup.
 *
 * @param lookup - The names an agent's folder gets right now, read fresh.
 */
export function setManagedServerNames(lookup: ManagedServerNames): void {
  managedServerNames = lookup;
}

/** A server's name the way Claude Code spells it inside a tool name. */
function toolNamePart(serverName: string): string {
  return serverName.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * The `PreToolUse` entry for one launch. With no agent folder there are no
 * managed servers, so it refuses nothing.
 *
 * @param agentDir - The folder of the agent the chat acts as, if any.
 */
export function managedServerHookMatcher(agentDir: string | null | undefined): HookCallbackMatcher {
  // Every managed server this chat has had, in tool-name spelling.
  const seen = new Set<string>();
  const current = (): Set<string> => {
    const now = new Set((agentDir ? managedServerNames(agentDir) : []).map(toolNamePart));
    for (const name of now) seen.add(name);
    return now;
  };
  current();
  return {
    matcher: '^mcp__',
    hooks: [
      async (hookInput) => {
        if (hookInput.hook_event_name !== 'PreToolUse') return {};
        const now = current();
        // The longest name that owns the tool, so `mcp__a__b__x` belongs to
        // `a__b` when both exist, never to `a`.
        const owner = [...seen]
          .filter((name) => hookInput.tool_name.startsWith(`mcp__${name}__`))
          .sort((a, b) => b.length - a.length)[0];
        if (owner === undefined || now.has(owner)) return {};
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: REMOVED_SERVER_MESSAGE,
          },
        };
      },
    ],
  };
}
