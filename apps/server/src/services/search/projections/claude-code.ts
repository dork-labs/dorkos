/**
 * Claude Code's projection: transcript lines in, searchable messages out.
 *
 * **Pure.** No filesystem, no database, no clock. That is what makes it
 * table-testable, and it is the property that keeps "adding a source" honest at
 * one function (message-search spec §Code structure).
 *
 * ## What survives, and why so little does
 *
 * What was *said*, in prose, by the person or by the agent — about 4% of
 * transcript lines and under 1% of transcript bytes. Tool results are the other
 * 71% and Claude Code writes each one twice, in two encodings; tool calls are
 * arguments rather than speech; file snapshots are copies of files that are on
 * disk; `attachment` lines are harness plumbing nobody said. Reasoning blocks are
 * excluded too, and that exclusion is nearly free rather than a sacrifice: 99.2%
 * of them carry an empty `thinking` string, and the whole corpus holds 0.19 MB of
 * reasoning text (spec §1.2).
 *
 * The queries that therefore return nothing are stated in the product, not only
 * here: "the error the agent showed me", "that stack trace", "the diff where we
 * changed X" were all tool output (spec §1.3).
 *
 * ## The authorship rules are the shipped ones
 *
 * The JSONL `user` role is a wire role, not an author — DorkOS itself writes on
 * it, and so do resume bootstraps, skill expansions, compaction summaries,
 * task notifications and other agents' relay hand-offs. `isPersonAuthoredUserRecord`
 * already answers "did a human write this?" for the session list, and asking it
 * again here is what keeps the index and the session list from disagreeing about
 * who said something.
 *
 * **What that gate costs, measured rather than assumed** (2026-08-24, 174 files):
 * it drops 2,087 records that carry text — 1,489 `<task-notification>` blocks,
 * 503 CLI-internal records, 56 local-command outputs, 23 compaction summaries,
 * 4 captured bash outputs, and 12 relay hand-offs. Every one but the last is
 * plumbing nobody said.
 *
 * **The 12 are a real gap, and an earlier version of this comment excused them
 * with a claim that does not hold.** It said they arrive as copies of room
 * entries the `rooms` source already indexes. Checked against the live room log:
 * **0 of the 12 appear in `room_entries`.** All twelve carry
 * `From: relay.agent.*` — direct agent-to-agent hand-offs, which never pass
 * through a room at all. So they are dropped outright, and the honest reason is
 * the smaller one: this projection reuses the session list's authorship
 * predicate rather than maintaining a second answer to "who said this", and that
 * predicate is about people. Whether one agent messaging another is a message
 * *you* received is a product question this task did not have to answer at
 * 0.13% of the corpus; it is written down here so the next person answers it
 * deliberately.
 *
 * @module server/services/search/projections/claude-code
 */
import {
  extractTextContent,
  isPersonAuthoredUserRecord,
  stripSystemTags,
  type TranscriptLine,
} from '../../runtimes/claude-code/sessions/transcript-parser.js';
import type { ProjectedMessage, Projection } from '../types.js';

/** Which container these lines belong to, and where its ordinals resume. */
export interface ClaudeCodeProjectionContext {
  /**
   * The session id — the JSONL filename stem, composed by discovery and parsed
   * nowhere.
   */
  originKey: string;

  /**
   * The ordinal for the first message this batch produces.
   *
   * Handed in rather than starting at zero because a transcript is read
   * incrementally: the mechanism reads only the bytes appended since the last
   * sweep, and those messages continue the file's numbering rather than
   * restarting it.
   */
  firstOrdinal: number;
}

/**
 * Project transcript lines into searchable messages.
 *
 * Four kinds of line do not become a message, and the difference between them is
 * why this function reports a count:
 *
 * - **A line that is not speech** — a tool result, a `system` record, a file
 *   snapshot, an attachment, a subagent's own turn, a compaction summary — is
 *   dropped silently. That is the expected outcome for 96% of the corpus.
 * - **A message with no text left after trimming** is dropped silently. An
 *   assistant turn that only called a tool has nothing to search.
 * - **A line that will not parse** is counted as `skipped` and the file
 *   continues. One bad line must never cost a session. Measured over the files
 *   this source reads, the corpus contains none — the 64 that two earlier
 *   measurements found were an artifact of splitting lines with `readline`, which
 *   also breaks on U+2028 and U+2029 (spec Amendment 3), and the reader that
 *   feeds this function splits on `\n` alone.
 * - **A line that parses but is not an object with a `type`** is counted the same
 *   way. It is the format having drifted underneath the projection, which is
 *   otherwise indistinguishable from a quiet source — the sharpest negative
 *   recorded in ADR 260728-214214.
 *
 * @param lines - Complete lines from ONE transcript, in file order.
 * @param context - The container and the ordinal to start at.
 */
export function projectClaudeCodeLines(
  lines: readonly string[],
  context: ClaudeCodeProjectionContext
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

    const line = parsed as TranscriptLine;
    if (typeof line.type !== 'string') {
      skipped += 1;
      continue;
    }

    const projected = readSpeech(line);
    if (projected === null) continue;

    messages.push({
      originKey: context.originKey,
      ordinal: ordinal++,
      role: projected.role,
      // Whatever the record stamped, verbatim. A fabricated timestamp would
      // sort results into an order nobody can explain, so a record without one
      // contributes null.
      createdAt: typeof line.timestamp === 'string' ? line.timestamp : null,
      body: projected.body,
    });
  }

  return { messages, skipped };
}

/** What a record contributes, or `null` when it is not something someone said. */
function readSpeech(line: TranscriptLine): { role: 'user' | 'assistant'; body: string } | null {
  if (line.type === 'user') {
    // The shipped predicate, unchanged: it already drops CLI-internal records,
    // subagent turns, compaction summaries, task notifications, local-command
    // output, and — the case this task names — a record carrying `tool_result`
    // blocks, whose sibling `text` blocks are SDK-internal rather than anyone's.
    if (!isPersonAuthoredUserRecord(line)) return null;
    const body = stripSystemTags(extractTextContent(line.message?.content ?? '')).trim();
    return body === '' ? null : { role: 'user', body };
  }

  if (line.type === 'assistant') {
    // A subagent's own turn is not this conversation's, and CLI-internal
    // records are nobody's. Same two exclusions the user branch inherits from
    // `isPersonAuthoredUserRecord`, stated here because that predicate answers
    // only for `user` records.
    if (line.isSidechain === true || line.isMeta === true) return null;
    // `extractTextContent` keeps `text` blocks and nothing else, so `thinking`
    // and `tool_use` blocks are excluded by construction rather than by a filter
    // that could be forgotten.
    const body = extractTextContent(line.message?.content ?? '').trim();
    return body === '' ? null : { role: 'assistant', body };
  }

  return null;
}
