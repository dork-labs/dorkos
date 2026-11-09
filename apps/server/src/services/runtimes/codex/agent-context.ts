/**
 * The DorkOS context one Codex turn carries in its prompt, after the context
 * gate has chosen what of the neutral append this turn owes.
 *
 * One function for the runtime and for the context viewer, so the viewer's
 * Codex preview is written by the code a turn runs (spec `context-viewer`
 * phase 3).
 *
 * @module services/runtimes/codex/agent-context
 */
import type { AgentHome } from '../../core/agent-identity/index.js';
import { buildRoomToolsBlock } from '../shared/room-tools-context.js';
import {
  renderBlockedAreaLines,
  resolveToolVisibilityFor,
} from '../shared/permission-tool-filter.js';
import { CODEX_DORKOS_TOOL_PREFIX } from '../shared/dorkos-tool-names.js';

/**
 * Join the gated neutral context with the room verbs and the Blocked-area
 * lines.
 *
 * The room verbs ride ONLY when this turn actually carries them — gated on
 * the resolved injection itself, not on a second guess at it, so the prose
 * and the wiring cannot disagree (spec `tool-only-room-replies` §D11). Named
 * under codex's own MCP prefix, never claude-code's: a bare or
 * wrongly-prefixed name is uncallable, which is the DOR-1292 defect.
 *
 * Outside the context gate, and deliberately: whether this session HAS the
 * room tools is answered per turn, so a menu written in the wrong tense must
 * never survive into a turn where it is false. Beside it, one line per
 * Blocked permission area (spec `agent-permissions` D15), resolved per turn
 * like the menu, read where the agent's manifest lives — the listener hides
 * the same areas keyed on the same anchor.
 *
 * @param neutralText - What the context gate selected of the neutral append.
 * @param dorkosTools - Whether this turn carries the DorkOS tools.
 * @param agentPath - The agent's home, or `undefined`.
 */
export async function buildCodexAgentContext(
  neutralText: string,
  dorkosTools: boolean,
  agentPath: AgentHome | undefined
): Promise<string> {
  if (!dorkosTools) return neutralText;
  return [
    neutralText,
    buildRoomToolsBlock(CODEX_DORKOS_TOOL_PREFIX),
    renderBlockedAreaLines((await resolveToolVisibilityFor(agentPath)).blockedAreas),
  ]
    .filter(Boolean)
    .join('\n\n');
}
