/**
 * How the in-session `dorkos` MCP server's tools are NAMED once Claude Code has
 * them (DOR-1292).
 *
 * `createSdkMcpServer({ name: 'dorkos' })` does not hand the model the tool names
 * this codebase registers. The Claude Code subprocess qualifies every MCP tool as
 * `mcp__<server>__<tool>`, so a capability registered as `react_to_room_entry` is
 * callable only as `mcp__dorkos__react_to_room_entry`. The short name is not an
 * alias for the long one — it is not a tool at all, and calling it answers
 * `No such tool available`.
 *
 * That distinction only bites because the two halves are written in different
 * files. The registration side (`mcp-tools/*.ts`, `services/**\/*-capabilities.ts`)
 * names tools bare, correctly, because the MCP protocol carries bare names. The
 * TEACHING side — the `<relay_tools>`, `<room_tools>`, `<marketplace_tools>` … blocks
 * in `messaging/context-builder.ts` — used to name them bare too, and a model that
 * copies what it reads copied a string it could not call. This module is the seam
 * between the two: prose renders through {@link IN_SESSION_TOOL_PREFIX}, the server
 * is created with {@link DORKOS_MCP_SERVER_NAME}, and
 * `messaging/__tests__/context-tool-names.test.ts` diffs the rendered prose against
 * the live server so they cannot drift apart again.
 *
 * Nothing here is runtime-neutral. Codex and OpenCode reach the same tools through
 * the external `/mcp` server, where the prefix is whatever the person's harness
 * config called that server — so the runtime-neutral blocks under
 * `runtimes/shared/` and the capability descriptions must never spell this prefix.
 *
 * @module services/runtimes/claude-code/mcp-tools/tool-names
 */

/**
 * The name the in-session MCP server is created under.
 *
 * Load-bearing twice over: it is what `createSdkMcpServer` is given, and it is the
 * middle of every tool name the model sees.
 */
export const DORKOS_MCP_SERVER_NAME = 'dorkos';

/**
 * What Claude Code prepends to every in-session DorkOS tool name.
 *
 * Prose that teaches a tool must render this in front of it; a bare name in a
 * system-prompt block is a name the model cannot call.
 */
export const IN_SESSION_TOOL_PREFIX = `mcp__${DORKOS_MCP_SERVER_NAME}__` as const;

/**
 * Qualify a registered tool name the way Claude Code exposes it.
 *
 * @param bare - The name the tool is registered under (`react_to_room_entry`).
 * @returns The only string the model can actually call.
 */
export function inSessionToolName(bare: string): string {
  return `${IN_SESSION_TOOL_PREFIX}${bare}`;
}
