/**
 * How Claude Code EXPOSES the in-session `dorkos` server's tools to the model:
 * what each one is called, which are in the prompt from the first turn, and what
 * the rest can be found by (DOR-1292).
 *
 * ## Names
 *
 * `createSdkMcpServer({ name: 'dorkos' })` does not hand the model the names this
 * codebase registers. The Claude Code subprocess qualifies every MCP tool as
 * `mcp__<server>__<tool>`, so a capability registered as `react_to_room_entry` is
 * callable only as `mcp__dorkos__react_to_room_entry`. The short name is not an
 * alias — it is not a tool at all, and calling it answers `No such tool available`.
 *
 * That bites because the two halves live in different files. The registration side
 * (`mcp-tools/*.ts`, `services/**\/*-capabilities.ts`) names tools bare, correctly,
 * because the MCP protocol carries bare names. The TEACHING side — the
 * `<relay_tools>`, `<room_tools>`, … blocks in `messaging/context-builder.ts` —
 * used to name them bare too, and a model that copies what it reads copied a
 * string it could not call.
 *
 * ## Loading
 *
 * Tool search is on in this SDK, so an MCP server's tools are deferred by default:
 * absent from the turn-1 prompt, reachable only after `ToolSearch`. The SDK offers
 * two escapes and this module uses both, deliberately unevenly:
 *
 * - **`alwaysLoad`** puts a tool in the prompt from turn 1. Granted to exactly the
 *   {@link ALWAYS_LOADED_TOOLS} five. A room turn is the case that cannot afford a
 *   lookup: the agent is answering a person in a shared room, and a search step
 *   before it can react is a turn spent on plumbing. `list_capabilities` joins them
 *   as the discovery entry point — the one name that leads to the other seventy.
 * - **`searchHint`** is a short phrase the tool can be FOUND by, so the deferred
 *   remainder is discoverable by intent rather than by guessing a name. Every tool
 *   gets one, derived mechanically from what it already says about itself.
 *
 * **Always-loading the whole server would be the wrong trade**, which is why this
 * is a set and not a flag: eighty-odd tool schemas would ride every turn's prompt,
 * on every session, to save a lookup that only rooms genuinely cannot afford.
 *
 * Nothing here is runtime-neutral. Codex and OpenCode reach the same tools through
 * the external `/mcp` server — under `dorkos_ui` for the UI server Codex spawns
 * itself, and otherwise under whatever the person's harness config named it — so
 * the runtime-neutral blocks under `runtimes/shared/` and the capability
 * descriptions must never spell this prefix.
 *
 * @module services/runtimes/claude-code/mcp-tools/tool-exposure
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

/**
 * The tools that ride the turn-1 prompt instead of waiting behind a search.
 *
 * Bare names, because that is what a tool is registered as; the loading flag is
 * attached at registration, before Claude Code qualifies anything.
 *
 * Kept deliberately short — see the module note on why the server as a whole stays
 * deferred. Each of these five earns it by being needed in a turn that has no
 * room for a lookup first:
 *
 * - the four room verbs, because a room turn is a person waiting in a shared
 *   channel, and DOR-1292 measured a whole turn lost to searching for one;
 * - `list_capabilities`, because it is how an agent finds everything else, and a
 *   discovery entry point nobody can discover is not one.
 */
export const ALWAYS_LOADED_TOOLS: ReadonlySet<string> = new Set([
  'post_to_room',
  'react_to_room_entry',
  'read_room_history',
  'search_room_history',
  'list_capabilities',
]);

/** Longest search hint kept; anything past this is a description, not a hint. */
const SEARCH_HINT_MAX_CHARS = 120;

/**
 * Reduce a tool's own words to the phrase it should be findable by.
 *
 * Mechanical on purpose. A hand-maintained hint table is a second description to
 * keep in sync with the first, and the first already says what the tool is for —
 * so this takes its opening sentence and stops. A sentence ends at a period
 * followed by whitespace and a CAPITAL: splitting on `. ` alone cut
 * "…message, e.g. 👍 on a post" down to "…e.g", which is why the lookahead is
 * there rather than the simpler pattern. An em-dash aside is cut too, because the
 * clause before it is the part that names the job.
 *
 * Over-long hints are cut at a WORD boundary. Cutting at the character count
 * turned `relay_inbox`'s hint into "…or o", which is not a phrase anybody or
 * anything can match on — a hint that ends mid-word is worse than a shorter one.
 *
 * @param source - The capability's title, or the tool's description.
 * @returns A trimmed one-line hint, or `undefined` when there is nothing to say.
 */
export function searchHintFrom(source: string): string | undefined {
  const firstSentence = source.split(/\.\s+(?=[A-Z])/)[0] ?? '';
  const beforeAside = firstSentence.split(/\s[—-]\s/)[0] ?? '';
  const hint = beforeAside
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '')
    .trim();
  if (hint === '') return undefined;
  if (hint.length <= SEARCH_HINT_MAX_CHARS) return hint;

  const clipped = hint.slice(0, SEARCH_HINT_MAX_CHARS - 1);
  const lastSpace = clipped.lastIndexOf(' ');
  // A single word longer than the budget has no boundary to fall back to, so it
  // is cut where it is rather than dropped entirely.
  const body = lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped;
  return `${body.replace(/[,;:\s]+$/, '')}…`;
}

/**
 * The `tool()` extras that decide how one tool is exposed.
 *
 * Both halves are computed rather than declared per tool, so a tool added tomorrow
 * is hinted without anyone remembering to hint it, and always-loading stays a
 * deliberate five-name decision rather than a default.
 *
 * @param bareName - The registered tool name.
 * @param hintSource - The capability's title, or the tool's description.
 * @returns Extras to pass as `tool()`'s fifth argument.
 */
export function toolExposure(
  bareName: string,
  hintSource: string
): { alwaysLoad?: true; searchHint?: string } {
  const searchHint = searchHintFrom(hintSource);
  return {
    ...(ALWAYS_LOADED_TOOLS.has(bareName) ? { alwaysLoad: true as const } : {}),
    ...(searchHint ? { searchHint } : {}),
  };
}
