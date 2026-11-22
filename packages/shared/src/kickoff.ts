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
 * Suppression in the RENDER path ({@link filterKickoffHistory}) is deliberately
 * narrow — three conditions, all required:
 * 1. `role === 'user'` (an assistant message is never suppressed),
 * 2. the FIRST user record of the history only (the kickoff is by
 *    construction the birth session's opening turn),
 * 3. after stripping the known server-injected context blocks (ADR-0273
 *    prepends e.g. `<git_status>…</git_status>`), the remainder is an exact
 *    fence ENVELOPE: it starts with `<dork-kickoff>` AND ends with
 *    `</dork-kickoff>`. Either/or is not enough — a message that merely
 *    mentions, opens, or closes the tag is genuine content and stays visible.
 *
 * THE SEARCH INDEX APPLIES 1 AND 3, NEVER 2, and that is a real difference
 * rather than an oversight. The three projections
 * (`services/search/projections/{claude-code,codex,opencode}.ts`) call
 * {@link isKickoffEnvelope} directly, because position is not a fact they hold:
 * a projection reads records from a container it is walking incrementally by
 * byte offset, so it has no history in hand to find a FIRST user record in, and
 * re-reading the whole container to recover that position is the exact cost the
 * frontier exists to avoid.
 *
 * So the two paths accept DIFFERENT residuals and the search one is wider.
 * Render: a person who deliberately pastes a complete, exact fence envelope as
 * the entire FIRST user message of a session has it hidden. Search: the same
 * paste is unfindable ANYWHERE in a session — it still renders in the
 * transcript, it just cannot be searched for. Both are deliberate mimicry of an
 * internal marker rather than accidental capture, and on both paths a partial,
 * quoted, or otherwise non-envelope use of the tag is never affected.
 *
 * @module shared/kickoff
 */
import { stripInjectedTagBlocks } from './additional-context.js';

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
  const core = stripInjectedTagBlocks(content);
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

/**
 * The part of a recorded message a person may see as a title or preview.
 *
 * A new agent's greeting kickoff is DorkOS's own message, not the person's, so
 * it reads as empty here: the chat stays untitled until the person writes, and
 * its fence tag never shows as a title or preview (DOR-4976).
 *
 * @param content - Raw message content a runtime recorded.
 * @returns The content, or `''` for a greeting kickoff.
 */
export function shownToPerson(content: string): string {
  return isKickoffEnvelope(content) ? '' : content;
}

/** Any DorkOS fence tag, opening or closing: `<dork-kickoff>`, `</dork-…>`. */
const DORK_MARKUP = /<\/?dork-[a-z0-9-]*>/i;

/**
 * A chat title as a person may see it: `''` when it carries DorkOS markup.
 *
 * Titles are stored, so one derived from a greeting kickoff before DOR-4976 still
 * reads `<dork-kickoff>`. Every runtime passes its titles through here on the way
 * out, and the client does again when it renders, so no `<dork-…>` tag ever
 * shows as a title; `''` renders as the untitled label.
 *
 * @param title - A runtime's stored or derived title (may be missing).
 * @returns The title, or `''` when it is missing or carries DorkOS markup.
 */
export function titleShownToPerson(title: string | null | undefined): string {
  if (!title || DORK_MARKUP.test(title)) return '';
  return title;
}

/**
 * A copy of a stored chat whose title and preview a person may see ({@link titleShownToPerson}).
 *
 * The read-side strip every runtime applies where a stored chat comes back in,
 * so a chat named from a greeting kickoff before DOR-4976 shows the untitled
 * label instead of the tag, and its next real message can still name it.
 *
 * @param session - A stored chat record with a title and an optional preview.
 * @returns A shallow copy with any DorkOS markup title or preview blanked.
 */
export function sessionShownToPerson<T extends { title: string; lastMessagePreview?: string }>(
  session: T
): T {
  return {
    ...session,
    title: titleShownToPerson(session.title),
    ...(session.lastMessagePreview !== undefined
      ? { lastMessagePreview: titleShownToPerson(session.lastMessagePreview) }
      : {}),
  };
}
