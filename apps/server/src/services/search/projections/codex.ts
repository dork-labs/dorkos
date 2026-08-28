/**
 * Codex's projection: rollout lines in, searchable messages out.
 *
 * **Pure.** No filesystem, no database, no clock — and no `@openai/codex-sdk`,
 * which Hard Rule 2 confines to the adapter. It reads the bytes the CLI already
 * wrote, exactly as the Claude Code projection reads what that SDK wrote.
 *
 * ## The one trap, named so it is not discovered
 *
 * **The same messages appear in TWO families and this function must read exactly
 * one.** A rollout carries `response_item` records (the model's own transcript)
 * AND `event_msg` records (`user_message` / `agent_message`, the CLI's UI feed)
 * for the same turn. Reading both double-counts nearly every message. Measured
 * over this machine's corpus 2026-08-25 — 18 files, 2,200 lines, zero malformed:
 * `response_item` 1,179 · `event_msg` 928 · `turn_context` 68 · `session_meta` 18
 * · `world_state` 6 · `compacted` 1. Of the `response_item` records, 261 are
 * messages; the `event_msg` family carries 219 of the same messages again.
 * **Read `response_item` ONLY.**
 *
 * ## What counts as something somebody said
 *
 * Of those 261 message records, **214 are indexed**. What the other 47 are, and
 * why each is not a message (measured, same corpus):
 *
 * - **20 `developer` records.** Codex writes its own instructions on a third
 *   role — `<permissions instructions>`, `<skills_instructions>`,
 *   `<collaboration_mode>`, `<model_switch>`. Nobody said them, and
 *   `ProjectedMessage.role` has no third value to put them under.
 * - **22 `user` records that are nothing but injected context**: 9 are the
 *   `# AGENTS.md instructions for <path>` project-doc dump, 7 are
 *   `<environment_context>`, 3 `<recommended_plugins>`, 2 `<turn_aborted>`, 1 a
 *   `<skill>` body. Each is 200 B to 16 KB of machine text on the person's role.
 * - **5 `user` records that are a widget CLICK and no words** — a `<ui_action>`
 *   block DorkOS injects when someone presses a button in a generative-UI card
 *   (five moves of one tic-tac-toe game). The person acted; they did not say
 *   anything, and what would go in the index is the machine's own instruction
 *   text.
 *
 * **Why the gate is a leading-block strip rather than a list of tag names.** A
 * Codex prompt is assembled by `codex/turn-input.ts` as blocks joined with a
 * blank line — `<gen_ui>`, then the DorkOS agent context (`<agent_identity>`,
 * `<agent_persona>`, `<dorkos_context>`, `<user_profile>`, `<env>`), then any
 * per-turn context (`<git_status>`, `<ui_state>`, …), and the person's words
 * LAST. Codex then prepends its own (`<environment_context>`, the AGENTS.md
 * dump). None of that is a registry anything can be driven off: the DorkOS tags
 * are literals in `runtimes/shared/agent-context.ts`, and Codex's are another
 * program's. So this strips leading blocks by SHAPE and keeps the remainder,
 * which is the same position-sensitive move `stripRelayContext` makes for
 * claude-code — and it cannot drift when either side adds a block.
 *
 * **And this is why claude-code's projection needs no such gate**, which looks
 * like an inconsistency until you see where each runtime puts the same text:
 * claude-code delivers all of it through `systemPromptAppend`, a channel the
 * transcript never records. Codex has no system channel per turn
 * (`turn-input.ts` says so at length), so the identical blocks land inside the
 * user's own record and must be taken back out here.
 *
 * The cost of the shape rule, stated rather than discovered: a person whose
 * message is entirely a tag-shaped block with a newline after the opening tag —
 * pasted XML and nothing else — indexes as nothing. Prose anywhere after it
 * survives, which is what makes the trade acceptable; 0 records on this corpus
 * are in that shape.
 *
 * @module server/services/search/projections/codex
 */
import type { ProjectedMessage, Projection } from '../types.js';

/** Which container these lines belong to, and where its ordinals resume. */
export interface CodexProjectionContext {
  /**
   * The session id, composed by discovery from the rollout's filename and parsed
   * nowhere.
   */
  originKey: string;

  /**
   * The ordinal for the first message this batch produces.
   *
   * Handed in rather than starting at zero because a rollout is read
   * incrementally: the mechanism reads only the bytes appended since the last
   * sweep, and those messages continue the file's numbering rather than
   * restarting it.
   */
  firstOrdinal: number;
}

/** The `response_item` payload shape this projection reads, once narrowed. */
interface CodexMessagePayload {
  /**
   * The item's own id, as Codex writes it. The SDK's live event stream keys its
   * per-item state off the same field (`event-mapper.ts`), so it is the id this
   * message has anywhere Codex talks about it.
   */
  id?: unknown;

  /** `'message'` for a turn; `'reasoning'`, `'function_call'`, … for everything else. */
  type?: unknown;

  /** `'user'`, `'assistant'`, or Codex's own `'developer'`. */
  role?: unknown;

  /** `input_text` / `output_text` blocks. */
  content?: unknown;
}

/**
 * The opening tag of a machine-written block, plus the newline that proves it is
 * one.
 *
 * The newline is load-bearing, not cosmetic: every injected block is written
 * multi-line, so requiring it leaves an inline `<div>hello</div>` somebody typed
 * completely alone.
 *
 * `\r?` because the Windows build is real (alpha, but shipping), and a rollout
 * written there carries CRLF — where a `\n`-only rule would quietly stop
 * stripping and index every injected block as something the person said.
 */
const BLOCK_OPEN = /^<([A-Za-z_][A-Za-z0-9_-]*)>\r?\n/;

/**
 * Codex's project-instruction dump, which announces itself with a markdown
 * heading instead of a tag and carries its 16 KB in an `<INSTRUCTIONS>` block
 * underneath.
 */
const PROJECT_DOC_HEADING = /^#\s+AGENTS\.md instructions for [^\n]*\n+/;

/**
 * Project rollout lines into searchable messages.
 *
 * Two kinds of line are counted as `skipped` rather than dropped, and both mean
 * the same thing: the format has drifted underneath this function, which is
 * otherwise indistinguishable from a quiet source (ADR 260728-214214's sharpest
 * recorded negative).
 *
 * - **A line that will not parse**, or that parses to something other than an
 *   object with a string `type`. Measured over this corpus: zero.
 * - **A `response_item` message whose `content` is not an array.** It is a
 *   record this function recognises as its own and cannot read.
 *
 * Everything else — every other record type, the `developer` role, a message
 * with no text left — is dropped silently, because that is the expected outcome
 * for 82% of a rollout's lines.
 *
 * @param lines - Complete lines from ONE rollout, in file order.
 * @param context - The container and the ordinal to start at.
 */
export function projectCodexLines(
  lines: readonly string[],
  context: CodexProjectionContext
): Projection {
  const messages: ProjectedMessage[] = [];
  let skipped = 0;
  let ordinal = context.firstOrdinal;

  for (const raw of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      skipped += 1;
      continue;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      skipped += 1;
      continue;
    }

    const line = parsed as { type?: unknown; timestamp?: unknown; payload?: unknown };
    if (typeof line.type !== 'string') {
      skipped += 1;
      continue;
    }

    // The `event_msg` family carries these same messages a second time. See this
    // module's header: reading both is the one way to get this badly wrong.
    if (line.type !== 'response_item') continue;
    if (line.payload === null || typeof line.payload !== 'object') continue;

    const payload = line.payload as CodexMessagePayload;
    if (payload.type !== 'message') continue;

    const role = payload.role;
    if (role !== 'user' && role !== 'assistant') continue;

    if (!Array.isArray(payload.content)) {
      skipped += 1;
      continue;
    }

    const text = blockText(payload.content);
    const body = role === 'user' ? personAuthoredText(text) : text.trim() || null;
    if (body === null) continue;

    messages.push({
      originKey: context.originKey,
      ordinal: ordinal++,
      // The record's own `item.id`, or nothing — never a substitute (DOR-1579).
      // It is carried because it is the id Codex itself uses for this item, not
      // because anything can land on it yet: the session view rebuilds a Codex
      // conversation from DorkOS's own event log and numbers its messages
      // `user-<seq>` / `assistant-<seq>` (`session/event-log-history.ts`), which
      // is a different id space. See `message-search-target.ts` for the
      // allowlist that decides which sources actually land.
      messageId: typeof payload.id === 'string' && payload.id !== '' ? payload.id : null,
      role,
      // Whatever the record stamped, verbatim — present on 2,200 of 2,200 lines
      // measured. A fabricated timestamp would sort results into an order nobody
      // can explain, so a record without one contributes null.
      createdAt: typeof line.timestamp === 'string' ? line.timestamp : null,
      body,
    });
  }

  return { messages, skipped };
}

/**
 * The text of one message's content blocks, concatenated in order.
 *
 * `input_text` on a user turn, `output_text` on an assistant one, and the block
 * type is deliberately not filtered on: the field that matters is `text`, and a
 * future block kind carrying prose should be searchable rather than dropped by a
 * whitelist nobody remembered to extend. A block with no string `text` — an
 * image, a file reference — contributes nothing.
 *
 * @param content - The `payload.content` array.
 * @returns The joined text, possibly empty.
 */
function blockText(content: readonly unknown[]): string {
  let text = '';
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const value = (block as { text?: unknown }).text;
    if (typeof value === 'string') text += value;
  }
  return text;
}

/**
 * What the PERSON typed in a user record, or `null` when they typed nothing.
 *
 * Strips the machine-written blocks that lead the record and keeps what follows.
 * See this module's header for why the rule is about position and shape rather
 * than about a list of tag names.
 *
 * @param text - The record's whole text.
 * @returns The person's words, or `null` when nothing is left.
 */
function personAuthoredText(text: string): string | null {
  let rest = text.trim();
  for (;;) {
    const shortened = dropLeadingBlock(rest);
    if (shortened === null) break;
    rest = shortened.trim();
  }
  return rest === '' ? null : rest;
}

/**
 * `text` with one leading machine-written block removed, or `null` when it does
 * not start with one.
 *
 * An UNTERMINATED opening tag is left alone rather than treated as a block that
 * swallows the rest of the record: `<thoughts>\n` with no closing tag is much
 * more likely to be something a person wrote than a block DorkOS or Codex
 * assembled, and the failure mode of guessing wrong is deleting their message.
 *
 * @param text - The remaining text, already trimmed.
 * @returns The remainder after the block, or `null`.
 */
function dropLeadingBlock(text: string): string | null {
  const heading = PROJECT_DOC_HEADING.exec(text);
  if (heading !== null) return text.slice(heading[0].length);

  const open = BLOCK_OPEN.exec(text);
  if (open === null) return null;
  const close = `</${open[1]}>`;
  const end = text.indexOf(close);
  if (end === -1) return null;
  return text.slice(end + close.length);
}
