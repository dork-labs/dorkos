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
import { buildAgentContextAppend } from '../shared/agent-context.js';
import {
  buildRoomToolsBlock,
  roomReplyModeForToolCapableSession,
} from '../shared/room-tools-context.js';
import { OPENCODE_DORKOS_TOOL_PREFIX } from '../shared/dorkos-tool-names.js';

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
 */
export async function buildOpenCodeTurnContext(
  cwd: string,
  dorkosApplied: boolean
): Promise<string> {
  const neutralContext = (await buildAgentContextAppend(cwd)).text;
  return dorkosApplied
    ? `${neutralContext}\n\n${buildRoomToolsBlock(
        OPENCODE_DORKOS_TOOL_PREFIX,
        // Per TURN, like codex: this whole prefix is rebuilt every turn, so the
        // mode is always current.
        roomReplyModeForToolCapableSession()
      )}`
    : neutralContext;
}
