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
import type { AgentHome } from '@dorkos/shared/agent-facts';
import { buildRoomToolsBlock } from '../shared/room-tools-context.js';
import {
  renderBlockedAreaLines,
  resolveToolVisibilityFor,
} from '../shared/permission-tool-filter.js';
import { CODEX_DORKOS_TOOL_PREFIX } from '../shared/dorkos-tool-names.js';

/**
 * Where a Codex agent drives a browser (DOR-4357). On macOS, Codex's own
 * sandbox refuses the Mach lookup Chromium needs, so a browser the agent
 * starts itself fails. The browser tools DorkOS serves run outside
 * that sandbox. Claude Code learns them from its `<ui_tools>` block; this is
 * Codex's only pointer to them. It names no way around the sandbox.
 *
 * @param prefix - The prefix Codex calls DorkOS tools under.
 */
function buildBrowserToolsBlock(prefix: string): string {
  return `<browser_tools>
In a Codex chat, use the browser tools DorkOS gives you. Codex can’t start its own browser on macOS.
The Agent browser, a website a person shares with this chat: ${prefix}local_browser_observe, then ${prefix}local_browser_act. It works only in a direct chat; in a room, ask the person to continue in a direct chat with you.
Each agent starts signed out in its own separate Chrome window. Only a person can share their browser from the panel; Stop sharing removes access. Never raise a sharing card yourself. The embedded browser is for the person alone.
Each chat owns its page. On not_opened or tab_gone, ask the person to open this chat’s browser. On profile_busy or profile_held, wait until the person finishes using that browser. Never close another chat’s page, resume yourself, or open a browser yourself.
A preview DorkOS serves: ${prefix}browser_read_page, then ${prefix}browser_click and ${prefix}browser_type.
</browser_tools>`;
}

/**
 * Why `gh` can't sign in on a Codex turn (DOR-4028). DorkOS keeps GitHub's
 * sign-in on the protected-files list, and Codex's sandbox enforces that list
 * for every program the agent starts, so `gh` fails there. The agent is told
 * so, never how to sign in another way, and never to set a token itself.
 * It never changes, so it rides with the stable half, once per thread, DorkOS
 * tools or not.
 */
const GITHUB_CLI_BLOCK = `<github_cli>
The gh command can’t sign in to GitHub in this chat: DorkOS keeps GitHub’s sign-in out of reach here. Don’t try to sign gh in, and don’t set a GitHub token yourself (GH_TOKEN, GITHUB_TOKEN).
If you need GitHub, use the GitHub tools DorkOS gives you when the person has connected GitHub in Connections. Otherwise, tell the person what you need.
</github_cli>`;

/**
 * Join the gated neutral context with the GitHub CLI notice, the room verbs,
 * the browser pointer and the Blocked-area lines.
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
 * @param selection - What the context gate selected of the neutral append, and
 *   whether it carries the stable half, which the GitHub CLI notice rides with;
 *   a plain string (the context viewer's template) counts as carrying it.
 * @param dorkosTools - Whether this turn carries the DorkOS tools.
 * @param agentPath - The agent's home, or `undefined`.
 */
export async function buildCodexAgentContext(
  selection: string | { text: string; carriesStable: boolean },
  dorkosTools: boolean,
  agentPath: AgentHome | undefined
): Promise<string> {
  const { text: neutralText, carriesStable } =
    typeof selection === 'string' ? { text: selection, carriesStable: true } : selection;
  const github = carriesStable ? GITHUB_CLI_BLOCK : '';
  if (!dorkosTools) return [neutralText, github].filter(Boolean).join('\n\n');
  return [
    neutralText,
    github,
    buildRoomToolsBlock(CODEX_DORKOS_TOOL_PREFIX),
    buildBrowserToolsBlock(CODEX_DORKOS_TOOL_PREFIX),
    renderBlockedAreaLines((await resolveToolVisibilityFor(agentPath)).blockedAreas),
  ]
    .filter(Boolean)
    .join('\n\n');
}
