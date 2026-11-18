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
 * `<chat_tools>`, `<room_tools>`, … blocks in `messaging/context-builder.ts` —
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
 *   {@link ALWAYS_LOADED_TOOLS} set on every session. A room turn is the case that
 *   cannot afford a lookup: the agent is answering a person in a shared room, and a
 *   search step before it can react is a turn spent on plumbing. `list_capabilities`
 *   joins them as the discovery entry point. Sessions that ARE a registered mesh
 *   agent additionally get {@link AGENT_TO_AGENT_TOOLS} for direct agent-to-agent
 *   exchanges; see {@link alwaysLoadedToolsFor}.
 * - **`searchHint`** is a short phrase the tool can be FOUND by, so the deferred
 *   remainder is discoverable by intent rather than by guessing a name. Every tool
 *   gets one, derived mechanically from what it already says about itself.
 *
 * **Always-loading the whole server would be the wrong trade**, which is why these
 * are sets and not a flag: the whole tool surface would ride every turn's prompt
 * to save a lookup that only a few turns cannot afford.
 *
 * ## Input schema conversion
 *
 * Ordinary capabilities register full strict objects through
 * `registerClaudeCapabilityTools`; the SDK `tool()` factory generates their
 * loading metadata without registering its raw descriptor. Hand tools keep
 * the factory's raw definitions and their independent once-only parse guard.
 * SDK 0.3.304 already accepts raw defaulted fields; the full-object migration
 * preserves object strictness and refinements rather than fixing that old bug.
 *
 * Older SDK/Zod combinations failed whole-server listing on records. That
 * history explains existing `catchall` maps in core schemas; it is not a
 * current-pin guarantee that records break listing. Do not widen extension
 * support from an SDK rendering observation: `extension-api/tool-check.ts`
 * still enforces its closed subset before contribution, refusing record,
 * lazy/open and unrepresentable declarations. Direct full registration can
 * make one unconvertible input fail the entire list.
 *
 * `__tests__/tool-exposure.test.ts` drives actual plain, agent and principal
 * listings. `mcp-default-arguments.test.ts` composes current-schema and
 * extension listability contracts through real SDK/registry execution. Keep
 * shared-schema aliases current, and rebuild own shared artifacts when a
 * targeted test would otherwise read stale `dist` output. The living contract
 * and measured migration scope are in `contributing/agent-operator-surface.md`.
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
