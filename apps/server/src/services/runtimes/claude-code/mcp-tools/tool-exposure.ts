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
 * - **`alwaysLoad`** puts a tool in the prompt from turn 1. Granted to the
 *   {@link ALWAYS_LOADED_TOOLS} eight on every session. A room turn is the case that
 *   cannot afford a lookup: the agent is answering a person in a shared room, and a
 *   search step before it can react is a turn spent on plumbing. `list_capabilities`
 *   joins them as the discovery entry point — the one name that leads to the other
 *   eighty. Sessions that ARE a registered mesh agent additionally get the
 *   {@link AGENT_TO_AGENT_TOOLS} six, for the same reason applied to a different
 *   turn; see {@link alwaysLoadedToolsFor}.
 * - **`searchHint`** is a short phrase the tool can be FOUND by, so the deferred
 *   remainder is discoverable by intent rather than by guessing a name. Every tool
 *   gets one, derived mechanically from what it already says about itself.
 *
 * **Always-loading the whole server would be the wrong trade**, which is why these
 * are sets and not a flag: eighty-odd tool schemas would ride every turn's prompt,
 * on every session, to save a lookup that only a few turns genuinely cannot afford.
 *
 * Nothing here is runtime-neutral. Codex and OpenCode reach the same tools through
 * the external `/mcp` server — under `dorkos_ui` for the UI server Codex spawns
 * itself, and otherwise under whatever the person's harness config named it — so
 * the runtime-neutral blocks under `runtimes/shared/` and the capability
 * descriptions must never spell this prefix.
 *
 * @module services/runtimes/claude-code/mcp-tools/tool-exposure
 */

import { DORKOS_MCP_SERVER_NAME } from '../../shared/dorkos-tool-names.js';

/**
 * The name the in-session MCP server is created under.
 *
 * Re-exported rather than declared: the same name keys the `dorkos` server that
 * codex and opencode dial over HTTP, so it has one definition in
 * `runtimes/shared/dorkos-tool-names.ts` and every consumer reads that one. A
 * second copy here is how the registered name and the prefixes built from it
 * drift apart.
 */
export { DORKOS_MCP_SERVER_NAME };

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
 * deferred. Each of these eight earns it by being needed in a turn that has no
 * room for a lookup first:
 *
 * - the four room verbs, because a room turn is a person waiting in a shared
 *   channel, and DOR-1292 measured a whole turn lost to searching for one;
 * - `list_capabilities`, because it is how an agent finds everything else, and a
 *   discovery entry point nobody can discover is not one;
 * - `memory_write`, because there must be **no ToolSearch hop between an agent
 *   and remembering** (the A-06 lesson). The prompt tells every agent, on every
 *   turn of every runtime, to save what it learns before the turn ends; a tool
 *   named in that instruction and then deferred is the DOR-1292 defect with a
 *   different name. The thing an agent fails to save is gone;
 * - `list_member_rooms` and `search_member_rooms` (agent-memory spec D6), for the
 *   same reason and in the same turn. `<session_model>` now tells every agent to
 *   use `search_member_rooms` when it is asked about something said in another
 *   room, and the ask lands in a room turn — the same waiting-person turn the
 *   four verbs are here for. A tool the prompt names and the SDK defers is the
 *   DOR-1292 defect wearing a third name. They ride together because the pair is
 *   one act: the search hands back a room id, and the list is where an agent gets
 *   one when the search found nothing to start from.
 *
 * **`get_room` and `find_room` are deliberately NOT here** (DOR-1610), and the
 * omission is written down because this list otherwise reads as "the room tools"
 * and now names six of the domain's eight. The rule that admits a tool is not
 * "it is a room verb" but "the prompt already tells an agent to reach for it":
 * every entry above is named in a prompt block, rides with one that is (the
 * listing pair, for the reason the bullet above gives), or is the entry point to
 * everything else. Nothing in the turn-1 prompt names either lookup, so deferring
 * them costs a search only on the turns that actually want one — and both are
 * the kind of tool `searchHint` finds by intent. Add them the day a prompt block
 * names them, and not before; that is the DOR-1292 rule read in this direction.
 *
 * **`merge_to_room_main` is named in a block and is still not here** (DOR-1599),
 * which is the one place the rule above is read narrowly rather than literally,
 * so the reasoning is written down. `<room_context>` tells a project-room turn
 * how to get its work into the room, and it names the verb as a searchable
 * ENDING with the instruction to look it up — a form that is honest on all three
 * runtimes and that assumes a lookup rather than being defeated by one. What
 * earns a place on this list is a turn with no room for that lookup: a room
 * REPLY is a person waiting, and DOR-1292 measured a whole turn lost to it.
 * Merging is not that turn. It never opens one — it follows work the agent has
 * already done and committed — so the search lands mid-turn, among the git
 * commands it is already running. The cost the other way is a schema in the
 * turn-1 prompt of EVERY session on the install, including the majority with no
 * project room at all.
 */
export const ALWAYS_LOADED_TOOLS: ReadonlySet<string> = new Set([
  'post_to_room',
  'react_to_room_entry',
  'read_room_history',
  'search_room_history',
  'list_member_rooms',
  'search_member_rooms',
  'list_capabilities',
  'memory_write',
]);

/**
 * The six tools an agent-to-agent turn cannot afford to search for first.
 *
 * Granted eagerly only to sessions that ARE a registered mesh agent with Relay
 * on — never to a plain session, which is most of them. The trade is the same
 * one the eight above make and it is paid by a different set of turns: reaching
 * a peer means finding it (`mesh_list`), reading its address
 * (`mesh_inspect`), and sending (`relay_send`, `relay_send_async`,
 * `relay_send_and_wait`, `relay_inbox`), and DorkOS's own tester watched an
 * agent narrate the cost — "I'll need to search for the mesh_list and relay
 * tool schemas since they're deferred" — inside a three-minute call budget
 * (DOR-1337 / F8).
 *
 * Kept to six. The rest of the relay and mesh surface (endpoint registration,
 * topology writes, adapters, traces) is not on the critical path of one
 * agent asking another a question, and stays deferred.
 */
export const AGENT_TO_AGENT_TOOLS: ReadonlySet<string> = new Set([
  'mesh_list',
  'mesh_inspect',
  'relay_send',
  'relay_send_async',
  'relay_send_and_wait',
  'relay_inbox',
]);

/**
 * The one rule that decides whether a session gets {@link AGENT_TO_AGENT_TOOLS}.
 *
 * Two call sites read it and they MUST agree, because they are two halves of
 * one claim: `mcp-tools/index.ts` decides what is actually loaded, and
 * `messaging/context-builder.ts` writes the sentence telling the agent so. A
 * prompt that says "already in your tool list" about a deferred tool spends the
 * turn it was written to save, and one that stays silent about a loaded tool
 * spends a `ToolSearch` for nothing. Written here, once, so the two cannot
 * drift by editing one of them.
 *
 * Both inputs are derived from the SESSION'S OWN working directory — the same
 * `session.cwd` the MCP factory is handed. Not the turn's effective cwd, which
 * a per-message override can move: the relay identity these tools publish as is
 * resolved from `session.cwd` too, so keying exposure anywhere else would load
 * six tools for a session whose sends are then refused as a non-agent.
 *
 * @param hasRegisteredAgentAtSessionCwd - Whether Mesh knows an agent at the
 *   session's working directory.
 * @param relayWired - Whether Relay is available to this process at all; with
 *   no bus the six tools can only answer RELAY_DISABLED, so preloading their
 *   schemas would be prompt spent on nothing.
 */
export function loadsAgentToAgentTools(
  hasRegisteredAgentAtSessionCwd: boolean,
  relayWired: boolean
): boolean {
  return hasRegisteredAgentAtSessionCwd && relayWired;
}

/**
 * The always-loaded set for one session.
 *
 * @param agentToAgent - The answer from {@link loadsAgentToAgentTools}. False
 *   for every plain session, which then sees exactly {@link ALWAYS_LOADED_TOOLS}.
 */
export function alwaysLoadedToolsFor(agentToAgent: boolean): ReadonlySet<string> {
  if (!agentToAgent) return ALWAYS_LOADED_TOOLS;
  return new Set([...ALWAYS_LOADED_TOOLS, ...AGENT_TO_AGENT_TOOLS]);
}

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
 * @param alwaysLoaded - The set that decides eager loading for THIS session.
 *   Defaults to {@link ALWAYS_LOADED_TOOLS}; an agent session passes the wider
 *   set from {@link alwaysLoadedToolsFor}.
 * @returns Extras to pass as `tool()`'s fifth argument.
 */
export function toolExposure(
  bareName: string,
  hintSource: string,
  alwaysLoaded: ReadonlySet<string> = ALWAYS_LOADED_TOOLS
): { alwaysLoad?: true; searchHint?: string } {
  const searchHint = searchHintFrom(hintSource);
  return {
    ...(alwaysLoaded.has(bareName) ? { alwaysLoad: true as const } : {}),
    ...(searchHint ? { searchHint } : {}),
  };
}
