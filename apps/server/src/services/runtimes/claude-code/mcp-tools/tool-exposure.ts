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
 *   {@link ALWAYS_LOADED_TOOLS} eleven on every session. A room turn is the case that
 *   cannot afford a lookup: the agent is answering a person in a shared room, and a
 *   search step before it can react is a turn spent on plumbing. `list_capabilities`
 *   joins them as the discovery entry point — the one name that leads to the other
 *   eighty. Sessions that ARE a registered mesh agent additionally get the
 *   {@link AGENT_TO_AGENT_TOOLS} four, for the same reason applied to a different
 *   turn; see {@link alwaysLoadedToolsFor}.
 * - **`searchHint`** is a short phrase the tool can be FOUND by, so the deferred
 *   remainder is discoverable by intent rather than by guessing a name. Every tool
 *   gets one, derived mechanically from what it already says about itself.
 *
 * **Always-loading the whole server would be the wrong trade**, which is why these
 * are sets and not a flag: eighty-odd tool schemas would ride every turn's prompt,
 * on every session, to save a lookup that only a few turns genuinely cannot afford.
 *
 * ## Schemas: no `z.record()` in an in-session tool's input
 *
 * An in-session tool's input schema must not contain `z.record(...)` at ANY depth,
 * `z.json()` included — it builds its object branch from a record. This is a hard
 * constraint rather than a style note, and one tool breaking it takes down all
 * ninety.
 *
 * `claude-agent-sdk` 0.3.257+ converts tool schemas to JSON Schema through the
 * installed zod's own per-schema processor, but builds the conversion context
 * itself, and that context carries no `deferred` array. zod 4.5.3+ is the first
 * version whose record processor pushes onto `ctx.deferred` (its only user, for
 * rewriting key names), so a record throws `Cannot read properties of undefined`
 * INSIDE the `tools/list` handler. `tools/list` answers for the whole server, so
 * the model is handed zero DorkOS tools — no error card, no log line, nothing to
 * debug from. Bisected on the 0.3.224 → 0.3.268 bump: SDK 0.3.252 + zod 4.5.4 is
 * fine and 0.3.257 is not; SDK 0.3.268 + zod 4.5.2 is fine and 4.5.3 is not. Both
 * halves are the vendors' to fix; until one of them does, this constraint stands.
 *
 * `z.object({}).catchall(valueType)` is the drop-in: it accepts the same values,
 * and its JSON Schema (`additionalProperties`) says the same thing without the
 * `propertyNames` clause a record adds. Four schemas were converted for this reason,
 * each carrying a pointer back here — `CONTROL_UI_INPUT.content`,
 * `operator.config_patch`'s `patch`, `McpServerTransportSchema`'s `env`/`headers`,
 * and `ConnectorJsonValueSchema` (which `z.json()` no longer builds).
 * `__tests__/tool-exposure.test.ts` lists tools off the live server on all three
 * session shapes, so a record added to any of them reds there immediately rather
 * than shipping — but read that as broad coverage, not as a proof over the whole
 * surface. Its plain and agent shapes build from
 * `composeCapabilityRegistryForDocs()`, which does now compose every domain (it
 * omitted `connectorExecutionDomain` until that was fixed, and
 * `self-description/__tests__/dorkos-registry.test.ts` pins it). Listing is
 * surface-gated regardless: the connector execute capabilities declare
 * `surfaces: {}`, so no registry composition puts them on these two shapes, and
 * they are reached only by the third — the connector-turn shape, which registers
 * those ids directly. A capability that declares no MCP surface anywhere would
 * still carry a record unseen.
 *
 * The aliases for `@dorkos/shared/{mesh,connector}-schemas` in
 * `apps/server/vitest.config.ts` are the other half of that guard: four of these
 * schemas live in `@dorkos/shared`, and against a stale `dist/` the test reads the
 * old ones and passes. Measured — a record put back on
 * `McpServerTransportSchema.env` reds 0 of 17 without those aliases and 7 with.
 *
 * The qualification and provenance helpers are Claude-specific; loading and
 * search policy is shared. Codex and OpenCode reach the same tools through
 * the external `/mcp` server — under `dorkos_ui` for the UI server Codex spawns
 * itself, and otherwise under whatever the person's harness config named it — so
 * the runtime-neutral blocks under `runtimes/shared/` and the capability
 * descriptions must never spell this prefix.
 *
 * @module services/runtimes/claude-code/mcp-tools/tool-exposure
 */

import {
  CLAUDE_CODE_DORKOS_TOOL_PREFIX,
  DORKOS_MCP_SERVER_NAME,
} from '../../shared/dorkos-tool-names.js';

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
export const IN_SESSION_TOOL_PREFIX = CLAUDE_CODE_DORKOS_TOOL_PREFIX;

/**
 * Whether an MCP tool call could be served by the in-session server THIS host
 * registered, read from the provenance Claude Code attaches to it (SDK 0.3.274:
 * `mcpServer` on `canUseTool`, `mcp_server` on tool hooks).
 *
 * The name and the {@link IN_SESSION_TOOL_PREFIX} are not proof. A project's
 * `.mcp.json` can declare a server called `dorkos` whose tools then carry the
 * very same `mcp__dorkos__…` names, and the SDK says in as many words: "Key
 * trust decisions on `source`, not on the name or the tool-name prefix."
 * `source: 'sdk'` cannot be forged — only the host can register one — and any
 * other value, including one this code has never seen, is a configured server.
 *
 * ABSENT provenance passes, and must. The field is missing for every non-MCP
 * tool (the built-ins on the read-only list) and on a CLI older than 0.3.274,
 * which is exactly what every call looked like before the field existed; a
 * present-but-foreign source is the only thing this check can and does refuse.
 *
 * @param provenance - The call's MCP server provenance, if Claude Code sent one.
 */
export function isHostServedOrUnattributed(provenance?: { source: string }): boolean {
  return provenance === undefined || provenance.source === 'sdk';
}

/**
 * Qualify a registered tool name the way Claude Code exposes it.
 *
 * @param bare - The name the tool is registered under (`react_to_room_entry`).
 * @returns The only string the model can actually call.
 */
export function inSessionToolName(bare: string): string {
  return `${IN_SESSION_TOOL_PREFIX}${bare}`;
}

export {
  ALWAYS_LOADED_TOOLS,
  AGENT_TO_AGENT_TOOLS,
  loadsAgentToAgentTools,
  alwaysLoadedToolsFor,
  searchHintFrom,
  toolExposure,
} from '../../shared/tools/tool-exposure-policy.js';
