/**
 * Auto-first-turn kickoff marker — the honesty seam for a freshly created
 * agent's opening greeting (M4, spec `agent-creation-redesign`).
 *
 * When an agent is born, DorkOS triggers its very first turn with a synthetic
 * instruction ("introduce yourself…") so the agent speaks first. That
 * instruction is a real turn the model reads, so runtimes record it as an
 * ordinary `user` message. It must NEVER render as if the person typed it.
 * This module owns the single suppression seam both sides share:
 *
 * - The client wraps the instruction with {@link wrapKickoff} before
 *   triggering the turn.
 * - The server applies {@link filterKickoffHistory} at its wire boundaries
 *   (the `GET /:id/messages` route and the `/events` snapshot) for EVERY
 *   runtime — one seam, not per-runtime copies.
 * - The client applies the same filter to its rendered list as a backstop
 *   (e.g. the in-process Direct transport, which bypasses HTTP routes).
 *
 * Suppression is deliberately narrow — three conditions, all required:
 * 1. `role === 'user'` (an assistant message is never suppressed),
 * 2. the FIRST user record of the history only (the kickoff is by
 *    construction the birth session's opening turn),
 * 3. after stripping the known server-injected context blocks (ADR-0273
 *    prepends e.g. `<git_status>…</git_status>`), the remainder is an exact
 *    fence ENVELOPE: it starts with `<dork-kickoff>` AND ends with
 *    `</dork-kickoff>`. Either/or is not enough — a message that merely
 *    mentions, opens, or closes the tag is genuine content and stays visible.
 *
 * Accepted residual, documented honestly: a person who deliberately pastes a
 * complete, exact fence envelope as the entire FIRST user message of a session
 * is still suppressed. That is deliberate mimicry of the internal marker, not
 * accidental capture; no partial, quoted, or mid-conversation use of the tag
 * is ever affected.
 *
 * @module shared/kickoff
 */
import { CONTEXT_TAG } from './additional-context.js';

/** The tag name that fences an auto-first-turn kickoff instruction. */
export const KICKOFF_TAG = 'dork-kickoff';

const OPEN_TAG = `<${KICKOFF_TAG}>`;
const CLOSE_TAG = `</${KICKOFF_TAG}>`;

/**
 * Wrap a kickoff instruction in the {@link KICKOFF_TAG} fence.
 *
 * The model reads the instruction inside the fence; the fence envelope is the
 * signal to the suppression seam that this turn was DorkOS-injected, not
 * user-authored.
 *
 * @param instruction - The plain kickoff instruction for the agent.
 * @returns The instruction fenced for triggering + honest suppression.
 */
export function wrapKickoff(instruction: string): string {
  return `${OPEN_TAG}\n${instruction.trim()}\n${CLOSE_TAG}`;
}

/**
 * Remove the known server-injected context blocks from message content: every
 * {@link CONTEXT_TAG} wrapper (git_status, ui_state, …) plus
 * `<system-reminder>`. Driven off `CONTEXT_TAG` so a new `ContextKind` is
 * stripped here automatically — the same no-drift guarantee the claude-code
 * render strip (`stripSystemTags`) relies on.
 *
 * @param text - Raw message content as a runtime stored it.
 * @returns The content with injected blocks removed, trimmed.
 */
function stripInjectedContext(text: string): string {
  let result = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  for (const tag of Object.values(CONTEXT_TAG)) {
    result = result.replace(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'g'), '');
  }
  return result.trim();
}

/**
 * Whether message content is EXACTLY a kickoff envelope: after stripping the
 * known injected context blocks, the remainder starts with the open tag AND
 * ends with the close tag. Both anchors are required — content that merely
 * begins with the open tag (a person asking "&lt;dork-kickoff&gt; what is
 * this?") or merely ends with the close tag is genuine content, never
 * suppressed.
 *
 * Role and position scoping are the caller's job ({@link filterKickoffHistory});
 * this predicate judges shape only. See the module doc for the accepted
 * residual (a deliberate full-envelope paste).
 *
 * @param content - Raw message content from a runtime's stored history.
 * @returns True when the content is shaped exactly like a kickoff envelope.
 */
export function isKickoffEnvelope(content: string): boolean {
  const core = stripInjectedContext(content);
  return core.startsWith(OPEN_TAG) && core.endsWith(CLOSE_TAG);
}

/**
 * The ONE suppression seam: drop the auto-first-turn kickoff from a session's
 * message history, runtime-agnostically. Applied server-side where history
 * leaves the process (`GET /:id/messages`, the `/events` snapshot) and
 * client-side as a rendering backstop.
 *
 * Scope (all three required, see module doc): only a `user`-role message, only
 * the FIRST user record in the list, and only when its content is an exact
 * fence envelope per {@link isKickoffEnvelope}. Everything else — assistant
 * messages, later user messages, partial/quoted tag uses — passes through
 * untouched. Returns the input array unchanged (same reference) when nothing
 * is suppressed.
 *
 * @param messages - Message history in transcript order.
 * @returns The history without the kickoff record, or the input as-is.
 */
export function filterKickoffHistory<T extends { role: string; content: string }>(
  messages: T[]
): T[] {
  const firstUserIndex = messages.findIndex((m) => m.role === 'user');
  if (firstUserIndex === -1) return messages;
  if (!isKickoffEnvelope(messages[firstUserIndex].content)) return messages;
  return messages.filter((_, i) => i !== firstUserIndex);
}
