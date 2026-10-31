/**
 * The DorkOS context an OpenCode turn carries on its system channel, assembled
 * in one place.
 *
 * Two blocks, and the second one is conditional in a way that has to be got
 * right: the runtime-neutral identity/persona/env append every adapter injects,
 * plus the `<room_tools>` block — but only when this session actually carries
 * those tools.
 *
 * Kept beside the runtime rather than inside it because `opencode-runtime.ts` is
 * at the repo's 500-line ceiling, and because "what goes into the prompt" reads
 * better as one named thing than as three-quarters of a page inside
 * `sendMessage`.
 *
 * @module services/runtimes/opencode/turn-context
 */
import { buildAgentContextAppend } from '../../shared/agent-context.js';
import type { AgentHome } from '../../../core/agent-identity/index.js';
import { buildRoomToolsBlock } from '../../shared/room-tools-context.js';
import {
  renderBlockedAreaLines,
  resolveToolVisibilityFor,
} from '../../shared/permission-tool-filter.js';
import { OPENCODE_DORKOS_TOOL_PREFIX } from '../../shared/dorkos-tool-names.js';
import { joinFitted, type ContextPart } from '../../shared/window/context-fit.js';

/**
 * Build the DorkOS context for one OpenCode turn.
 *
 * The neutral half is the same set of blocks the Claude adapter injects
 * (identity, persona, safety boundaries, `<dorkos_context>`, `<env>`), so an
 * OpenCode agent knows who it is and how to reach its capabilities. `.text` is
 * the whole append, memory block included: the `stable` half of that result
 * exists only for claude-code's relaunch fingerprint, and OpenCode has no warm
 * process to keep.
 *
 * Sending the whole thing every turn is CHEAP here and deliberately so: the
 * result rides `body.system`, which the sidecar replaces per request rather
 * than persisting into the conversation (DOR-477, `turn-input.ts`). So one copy
 * reaches the model per turn instead of one per turn ever taken, and an edited
 * SOUL.md or a freshly written memory note lands on the very next turn.
 *
 * The room half is named under OpenCode's OWN MCP prefix — one underscore and
 * no `mcp` marker, which is nothing like claude-code's — because a
 * wrongly-prefixed tool name is as uncallable as a bare one (DOR-1292). With
 * `dorkosApplied` false the result is byte-identical to what an OpenCode turn
 * carried before the DorkOS tools existed.
 *
 * @param cwd - The session's working directory.
 * @param dorkosApplied - Whether the `dorkos` MCP server is actually registered
 *   on the sidecar for this directory RIGHT NOW, as reported by the reconcile.
 *   Never an intention: an agent told it can post in rooms, whose server was
 *   refused or failed to register, spends a turn discovering that.
 * @param agentPath - The home of the agent this turn acts as (DOR-2091,
 *   DOR-2355), or `undefined` when it acts as nobody. Its identity and memory
 *   are read from here, never from `cwd`, and its Blocked areas are the ones
 *   listed.
 */
export async function buildOpenCodeTurnContext(
  cwd: string,
  dorkosApplied: boolean,
  agentPath: AgentHome | undefined
): Promise<string> {
  return joinFitted(await buildOpenCodeTurnParts(cwd, dorkosApplied, agentPath), []);
}

/**
 * The same context as {@link buildOpenCodeTurnContext}, as tagged parts, so a
 * small window can leave whole blocks out (`context-fit.ts`, DOR-2839).
 *
 * The room tools guide is never left out on a room turn: there the agent's only
 * way to answer is the posting tool it describes.
 *
 * @param roomTurn - Whether this turn answers a room.
 */
export async function buildOpenCodeTurnParts(
  cwd: string,
  dorkosApplied: boolean,
  agentPath: AgentHome | undefined,
  roomTurn = false
): Promise<ContextPart[]> {
  const append = await buildAgentContextAppend(agentPath, cwd);
  const neutral = append.parts ?? [{ block: null, text: append.text }];
  if (!dorkosApplied) return [...neutral];
  // One line per Blocked permission area (spec `agent-permissions` D15); the
  // runtime listener hides the same area's tools from this turn's list.
  // Read at the ANCHORED agent (DOR-2091): a room worktree reads as its agent,
  // and a refused turn as nobody — never the directory's own agent.
  const blocked = renderBlockedAreaLines((await resolveToolVisibilityFor(agentPath)).blockedAreas);
  return [
    ...neutral,
    {
      block: roomTurn ? null : 'room_tools',
      text: buildRoomToolsBlock(OPENCODE_DORKOS_TOOL_PREFIX),
    },
    ...(blocked ? [{ block: null, text: blocked }] : []),
  ];
}
