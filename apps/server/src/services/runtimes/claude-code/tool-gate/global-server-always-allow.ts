/**
 * "Always allow" on a tool from a server a person added for every agent stays
 * with the agent that was asked (DOR-3213, Security's T9).
 *
 * A server for every agent has the same name in every agent's session, so a
 * rule the CLI writes to `userSettings` (`~/.claude/settings.json`) would allow
 * that tool in every agent, and one written to `projectSettings` would travel
 * with a checked-in file. One yes would reach agents nobody was looking at. So
 * those two destinations are moved to `localSettings`: the asking agent's own
 * folder, not checked in. `session` stays as it is, and a destination this SDK
 * version did not have is dropped rather than guessed at.
 *
 * This does not read where a message came from; it only narrows where a yes is
 * kept. An agent's own server with the same name is narrowed too, which only
 * keeps its yes closer to home.
 *
 * @module runtimes/claude-code/tool-gate/global-server-always-allow
 */
import type { PermissionUpdate, PermissionUpdateDestination } from '@anthropic-ai/claude-agent-sdk';

/** Whether a server name is one a person added for every agent. */
export type GlobalMcpServerLookup = (serverName: string) => boolean;

let isGlobalServer: GlobalMcpServerLookup = () => false;

/**
 * Tell the gate which server names are servers for every agent. Set once at
 * startup, from the store that owns them.
 *
 * @param lookup - Answers for one server name, read fresh on every card.
 */
export function setGlobalMcpServerLookup(lookup: GlobalMcpServerLookup): void {
  isGlobalServer = lookup;
}

/** Where a kept yes may go for a server for every agent. */
const NARROWED: Partial<Record<PermissionUpdateDestination, PermissionUpdateDestination>> = {
  session: 'session',
  cliArg: 'cliArg',
  localSettings: 'localSettings',
  projectSettings: 'localSettings',
  userSettings: 'localSettings',
};

/** The MCP server a tool call reaches: the SDK's own attribution, else the tool's name. */
function serverOf(toolName: string, mcpServer?: { name: string }): string | undefined {
  if (mcpServer) return mcpServer.name;
  const match = /^mcp__(.+?)__/.exec(toolName);
  return match?.[1];
}

/**
 * The approval context a card is raised with, its "Always allow" kept to this
 * agent when the tool comes from a server for every agent. Anything else comes
 * back unchanged.
 *
 * @param toolName - The tool the call names.
 * @param context - The SDK's approval context.
 */
export function keepAlwaysAllowToAgent<
  T extends { suggestions?: PermissionUpdate[]; mcpServer?: { name: string; source: string } },
>(toolName: string, context: T): T {
  if (!context.suggestions?.length) return context;
  if (context.mcpServer?.source === 'sdk') return context;
  const server = serverOf(toolName, context.mcpServer);
  if (server === undefined || !isGlobalServer(server)) return context;
  const suggestions = context.suggestions.flatMap((update) => {
    const destination = NARROWED[update.destination];
    return destination === undefined ? [] : [{ ...update, destination }];
  });
  return { ...context, suggestions };
}
