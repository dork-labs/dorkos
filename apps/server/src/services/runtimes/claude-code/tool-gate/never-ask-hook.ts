/**
 * At Never ask, DorkOS's own safe tools run again (DOR-3042, after #3072).
 *
 * Under `dontAsk` Claude Code never calls `canUseTool`: anything its allow
 * rules don't name is refused before DorkOS is asked (QA, 0 calls in 27
 * cases). So a Never ask chat couldn't read or post to its own room, though
 * those calls run unasked in every other mode. A static allow rule was
 * rejected: it would skip every per-call check DorkOS makes and match any
 * server that calls itself `dorkos`. This hook makes the same per-call
 * decision the gate makes, and only says `allow` when it is certain.
 *
 * **What it allows.** A call to one of {@link DORKOS_AGENT_TOOLS}, by its exact
 * in-session name, served by the server DorkOS registered (`source: 'sdk'`,
 * which only the host can set; a missing or other source gets nothing), that
 * {@link dorkosAutoAllows} lets run for this session RIGHT NOW: the running
 * turn's ceilings, `control_ui` per effect, and the identity the room verbs
 * need. Nothing else: never a built-in tool, so Bash, Edit, Write and WebFetch
 * stay refused.
 *
 * **Stricter than the gate in one place.** A turn held for a stranger gets no
 * `chat_send` at all, not even a queued one. A turn that only carries an
 * outsider's words on may send one: the message carries the mark, so the chat
 * it reaches is gated the same way (DOR-3390, Security's condition on #3201's
 * one-hop laundering point). A turn held to any ceiling, or marked without
 * one, gets no account tools. A marked turn lists none of its own connection
 * grants either (DOR-3205).
 *
 * **Never on a teammate's turn.** A teammate's fence is its own hook's deny,
 * and Claude Code ranks a deny above an allow; this hook does not lean on that
 * ranking and says nothing at all while a teammate tier is set.
 *
 * **It only ever allows, and only at Never ask.** In every other mode, and on
 * any doubt (a throw, a slow lookup, an unknown name), it answers nothing, so
 * `dontAsk` refuses as before and every other mode reaches `canUseTool` as
 * before. A deny rule still beats its allow (QA, proven on the CLI).
 *
 * Read at CALL time from the session, never captured at launch: a warm process
 * serves many turns, and the ceiling is assigned per send.
 *
 * @module services/runtimes/claude-code/tool-gate/never-ask-hook
 */
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionModeId } from '@dorkos/shared/schemas';
import { CHAT_SEND_TOOL } from '@dorkos/shared/chat-messages';
import { NEVER_ASK_MODE_ID } from '../runtime-constants.js';
import { inSessionToolName } from '../mcp-tools/tool-exposure.js';
import {
  ceilingOn,
  gatePermissionMode,
  heldForOutsider,
  type CeilingedMode,
} from '../turn-permission.js';
import { DORKOS_AGENT_TOOLS, dorkosAutoAllows } from './auto-allow.js';
import { OWN_CONNECTION_READS_QUALIFIED } from './own-connection-reads.js';
import type { ToolApprovalContext, ToolGateLogger } from '../messaging/interactive-handlers.js';
import type { AgentSession } from '../agent-types.js';

/** What the hook reads from the session, at call time. */
export type NeverAskSession = CeilingedMode<PermissionModeId> & Pick<AgentSession, 'teammateTier'>;

/** How long the decision may take before it counts as doubt. */
export const NEVER_ASK_HOOK_TIMEOUT_MS = 5_000;

/** Tools refused outright in a held or marked turn: the accounts. */
const NEVER_IN_A_HELD_OR_MARKED_TURN: ReadonlySet<string> = new Set(
  ['accounts_usage', 'accounts_probe'].map(inSessionToolName)
);

/** `chat_send`, refused only in a turn held for a stranger (DOR-3390). */
const CHAT_SEND_QUALIFIED = inSessionToolName(CHAT_SEND_TOOL);

/** What the hook answers when it lets a call run. */
const ALLOW = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse' as const,
    permissionDecision: 'allow' as const,
    permissionDecisionReason: 'DorkOS runs its own safe tools without asking.',
  },
};

/** Whether the running turn is marked; a throw counts as marked. */
function markedOrDoubtful(isMarked: () => boolean): boolean {
  try {
    return isMarked();
  } catch {
    return true;
  }
}

/**
 * Whether DorkOS lets this call run unasked at Never ask. Never throws.
 *
 * @param session - The session's chosen mode and both ceilings.
 * @param toolName - The tool the model called.
 * @param input - Its arguments.
 * @param mcpServer - The serving server's provenance, from the hook input.
 * @param resolveIdentity - The memoized session-identity resolver.
 * @param log - Where a failed lookup is reported.
 * @param isMarked - Whether the running turn read words DorkOS can't vouch for
 *   (its marks, `marksOf`), which a room turn can be without any ceiling.
 */
export async function neverAskAllows(
  session: NeverAskSession,
  toolName: string,
  input: Record<string, unknown>,
  mcpServer: ToolApprovalContext['mcpServer'],
  resolveIdentity: () => Promise<unknown>,
  log: ToolGateLogger,
  isMarked: () => boolean = () => false
): Promise<boolean> {
  if (gatePermissionMode(session) !== NEVER_ASK_MODE_ID) return false;
  if (session.teammateTier) return false;
  if (!DORKOS_AGENT_TOOLS.has(toolName)) return false;
  // Proven, not assumed: an absent source is NOT the host here.
  if (mcpServer?.source !== 'sdk') return false;
  if (toolName === CHAT_SEND_QUALIFIED) {
    // A stranger's own turn passes nothing on. A turn that only carries an outsider's words on
    // may (DOR-3390): the message carries the mark, so the chat it reaches is marked in turn and
    // its raises, destructive calls and shell still ask.
    if (heldForOutsider(session)) return false;
  } else if (NEVER_IN_A_HELD_OR_MARKED_TURN.has(toolName)) {
    if (ceilingOn(session) !== 'none') return false;
    if (markedOrDoubtful(isMarked)) return false;
  } else if (OWN_CONNECTION_READS_QUALIFIED.has(toolName)) {
    // The agent's own grants (DOR-3205) run in a turn another of our agents holds, but not in
    // one that read an outsider's words: the gate refuses a carried mark, this the turn's own.
    if (markedOrDoubtful(isMarked)) return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), NEVER_ASK_HOOK_TIMEOUT_MS);
    });
    return await Promise.race([
      dorkosAutoAllows(session, toolName, input, mcpServer, resolveIdentity, log),
      timedOut,
    ]);
  } catch (err) {
    log.info('[NeverAsk] could not decide; leaving the call refused', {
      toolName,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The hook. Answers `allow` only when {@link neverAskAllows} says so, and
 * nothing otherwise.
 *
 * @param session - The session's chosen mode and both ceilings.
 * @param resolveIdentity - The memoized session-identity resolver `canUseTool` uses.
 * @param log - Where a failed lookup is reported.
 * @param isMarked - Whether the running turn is marked, read at call time.
 */
export function createNeverAskHook(
  session: NeverAskSession,
  resolveIdentity: () => Promise<unknown>,
  log: ToolGateLogger,
  isMarked: () => boolean = () => false
): HookCallback {
  return async (hookInput) => {
    if (hookInput.hook_event_name !== 'PreToolUse') return {};
    const input =
      hookInput.tool_input !== null && typeof hookInput.tool_input === 'object'
        ? (hookInput.tool_input as Record<string, unknown>)
        : {};
    const allowed = await neverAskAllows(
      session,
      hookInput.tool_name,
      input,
      hookInput.mcp_server,
      resolveIdentity,
      log,
      isMarked
    );
    return allowed ? ALLOW : {};
  };
}
