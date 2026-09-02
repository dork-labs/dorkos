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
 * ## The id a hit lands on
 *
 * Every message carries the JSONL record `uuid` that the session view will
 * render it under, so a search hit opens ON the message rather than at the top
 * of the conversation (DOR-1579, spec Amendment 12). One wrinkle makes that more
 * than a copied field, and `closeAssistantRun` is where it lives: the view folds
 * a whole assistant turn into ONE message keeping the LAST record's uuid, while
 * this indexes each record that carries text separately. Nothing is ever
 * synthesized, and a fold this function gets wrong costs a landing rather than
 * moving one.
 *
 * @module server/services/search/projections/claude-code
 */
import { isApiErrorRecord } from '../../runtimes/claude-code/sdk/api-error-record.js';
import {
  extractTextContent,
  isPersonAuthoredUserRecord,
  stripSystemTags,
  type TranscriptLine,
} from '../../runtimes/claude-code/sessions/transcript-parser.js';
import { isKickoffEnvelope } from '@dorkos/shared/kickoff';
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
  // The open assistant run: which messages are still waiting for the id of the
  // record that will close it, and the newest candidate for that id. See
  // `closeAssistantRun`.
  const openRun: number[] = [];
  let runId: string | null = null;

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

    const uuid = typeof line.uuid === 'string' && line.uuid !== '' ? line.uuid : null;

    // Transparent in both senses — not indexed, and not a candidate to close a
    // run. See `isResumeBootstrapReply`.
    if (isResumeBootstrapReply(line)) continue;

    // An assistant record continues the open run (or opens one) and its uuid
    // becomes the newest candidate to close it. A tool RESULT is transparent:
    // it rides the `user` role but the parser emits nothing for it, so it does
    // not end a turn there either — and it is what sits between the two halves
    // of nearly every agentic turn. Everything else ends the run, whether or not
    // the parser would have ended it, because ending one turn early costs a
    // landing while ending one late would move it (see `closeAssistantRun`).
    if (line.type === 'assistant') {
      if (uuid !== null) runId = uuid;
    } else if (endsAssistantTurn(line)) {
      closeAssistantRun(messages, openRun, runId);
      runId = null;
    }

    const projected = readSpeech(line);
    if (projected === null) continue;

    messages.push({
      originKey: context.originKey,
      ordinal: ordinal++,
      // The record's OWN uuid, or nothing — and for an assistant record, patched
      // below to the uuid of the record that CLOSES its run. See
      // `closeAssistantRun`. Never a uuid this function made up: `parseTranscript`
      // falls back to `crypto.randomUUID()` for a record without one, and that
      // branch mints a fresh id per parse, so an indexed copy of one would name a
      // message no later read agrees exists (DOR-1579).
      messageId: uuid,
      role: projected.role,
      // Whatever the record stamped, verbatim. A fabricated timestamp would
      // sort results into an order nobody can explain, so a record without one
      // contributes null.
      createdAt: typeof line.timestamp === 'string' ? line.timestamp : null,
      body: projected.body,
    });
    if (projected.role === 'assistant') openRun.push(messages.length - 1);
  }

  closeAssistantRun(messages, openRun, runId);

  return { messages, skipped };
}

/**
 * Give every assistant message of the run that just ended the uuid of the record
 * that closed it, and forget the run.
 *
 * **This exists because the session view MERGES an assistant turn and this
 * projection does not.** `parseTranscript` emits one message per assistant
 * record and then folds consecutive ones into a single turn keeping the LAST
 * id (`mergeConsecutiveAssistantMessages`), while this function indexes each
 * record that carries text as its own searchable message — which is right for
 * search, since each is a separate thing that was said. Carrying each record's
 * own uuid therefore addressed the rendered turn only when the text happened to
 * sit in the last record of it, which an agentic turn's rarely does — it almost
 * always ends on a `tool_use` record. Measured over 120 real transcripts, 7,352
 * indexed messages, 2026-08-26: **14% of assistant messages matched a rendered
 * id that way, and 92% match with the turn folded here.**
 *
 * **Guessing the run wrong costs a landing rather than misplacing one**, which
 * is what makes this safe to do at all. Every rendered id is the uuid of the
 * record that closed some run; the uuid of any other record is an id no rendered
 * message has. So a run this function ends too EARLY yields an id that matches
 * nothing, and the hit opens its conversation exactly as it does today.
 *
 * **That holds on one precondition, and it is worth stating because it is the
 * only way this can misplace a hit: every record indexed here must be one the
 * parser also renders.** A run ending too LATE spans a record the parser
 * emitted a message for, and the id it hands back is then a real rendered
 * message — the right one whenever the indexed text is inside it, which is what
 * makes the precondition load-bearing rather than the boundary itself.
 * `endsAssistantTurn` mirrors the parser's emit/skip decision branch by branch
 * for exactly that reason, and `isResumeBootstrapReply` closes the one record
 * that was indexed here and drawn nowhere there. Measured over 186 real
 * transcripts and 9,470 indexed messages (2026-08-26): 0 messages carrying an id
 * that names a different rendered message, against 1 before those two guards,
 * and 91% carrying one that names their own; the rest match nothing.
 *
 * The same follows for a run split across two sweeps: an incremental read sees
 * the batch's last record as the closer, which is either right or unmatched.
 *
 * @param messages - The messages built so far, patched in place.
 * @param openRun - Indices into `messages` awaiting the run's closing id.
 *   Emptied here.
 * @param runId - The uuid of the last assistant record seen in the run, or
 *   `null` when none of them carried one.
 */
function closeAssistantRun(
  messages: ProjectedMessage[],
  openRun: number[],
  runId: string | null
): void {
  if (openRun.length === 0) return;
  if (runId !== null) {
    for (const index of openRun) messages[index]!.messageId = runId;
  }
  openRun.length = 0;
}

/**
 * The CLI's resume-bootstrap reply — the zero-token synthetic assistant record
 * it pairs with the `isMeta` "Continue from where you left off." prompt DorkOS
 * writes on every `query({resume})` turn.
 *
 * `parseTranscript` skips it outright, so the session view never draws it, and
 * it is skipped here for the same reason and in both senses: nobody said it, so
 * it is not indexed; and it cannot close an assistant run, so its uuid never
 * becomes the id another message lands on.
 *
 * **Indexing it was the one measured way a hit could reach a DIFFERENT rendered
 * message.** Its text is in the index and nowhere on screen, so the run's
 * closing uuid names a real turn that does not contain it — see
 * `closeAssistantRun` for why every OTHER shape degrades to a miss instead. Over
 * the 186 transcripts measured (2026-08-26) the corpus held 29 of these records
 * and exactly one produced such a landing.
 *
 * The CLI's other `<synthetic>` records are its API-error notices, and they are
 * excluded for the first reason but not the second: nobody said them, so
 * `readSpeech` drops them, while the parser still renders one (as an error card
 * — DOR-1649) so its uuid may still close a run.
 *
 * @param line - The record to classify.
 */
function isResumeBootstrapReply(line: TranscriptLine): boolean {
  if (line.type !== 'assistant' || line.message?.model !== '<synthetic>') return false;
  const content = line.message.content;
  if (!Array.isArray(content)) return false;
  return extractTextContent(content).trim() === 'No response requested.';
}

/**
 * The string-content `user` records `parseTranscript` walks straight past — one
 * unconditional `continue` there for each, and the reason each is machine
 * plumbing is in that file.
 *
 * They matter here only because a record the parser skips does not end an
 * assistant turn, and `<task-notification>` is the commonest record of any kind
 * between the two halves of one (12,503 assistant records over the 120
 * transcripts measured, against 524 where it really was the end).
 */
const SKIPPED_USER_PREFIXES = [
  '<task-notification>',
  '<dorkos-system-note>',
  '<local-command',
] as const;

/**
 * Whether this non-assistant record ends the assistant turn the session view
 * would draw.
 *
 * **Read against `parseTranscript`'s own loop, branch by branch.** A turn ends
 * there when a NON-assistant message is emitted between two assistant ones; a
 * record that emits nothing leaves the assistant records either side of it
 * consecutive, and they are folded into one message.
 *
 * - **`user`** — a closer except for the four shapes the parser skips outright,
 *   each of them one unconditional `continue` there: a record carrying a
 *   `tool_result` block (the record between the two halves of nearly every
 *   agentic turn, read into the tool call rather than emitted), and the
 *   `<task-notification>`, `<dorkos-system-note>` and `<local-command…` string
 *   records, which are machine plumbing nobody said. Every OTHER user shape is
 *   treated as a closer whether or not the parser really emits for it (a
 *   CLI-internal `isMeta` record usually does not, a slash command does): being
 *   wrong this way costs a landing, and being wrong the other way would move
 *   one.
 * - **`system`** — only `local_command`, whose captured output the parser emits
 *   as a message. `compact_boundary` holds metadata for the record after it and
 *   emits nothing.
 * - **anything else** — `attachment`, `file-history-snapshot`, and every kind
 *   nobody has named yet reach no branch of the parser at all, so they cannot
 *   end a turn. This is exact rather than conservative: the parser's loop has
 *   `user`, `assistant` and two `system` subtypes in it and nothing more.
 *
 * @param line - The record to classify. Never an `assistant` record — the
 *   caller has already handled those, which are what a turn is made of.
 */
function endsAssistantTurn(line: TranscriptLine): boolean {
  if (line.type === 'system') return line.subtype === 'local_command';
  if (line.type !== 'user') return false;
  // BEFORE the content shape, because `parseTranscript` checks it before it
  // looks at the content at all — and its `isMeta` branch can flush a pending
  // slash command, which emits a bubble and splits the turn. Reading the shape
  // first left an `isMeta` record carrying a `tool_result` continuing the run
  // here while it ended one there.
  if (line.isMeta === true) return true;
  const content = line.message?.content;
  // `tool_use_id` and not merely the block type, mirroring the parser's own
  // `hasToolResult` exactly: a `tool_result` block missing one does not suppress
  // the record's sibling text blocks there, so the record IS emitted and the
  // turn splits.
  if (Array.isArray(content)) {
    return !content.some((block) => block.type === 'tool_result' && Boolean(block.tool_use_id));
  }
  if (typeof content !== 'string') return true;
  return !SKIPPED_USER_PREFIXES.some((prefix) => content.startsWith(prefix));
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
    if (body === '') return null;
    // The auto-first-turn kickoff is DorkOS's own instruction wearing the
    // person's role, and `stripSystemTags` cannot reach it: it strips
    // `<system-reminder>` and the eight `CONTEXT_TAG` wrappers, and
    // `dork-kickoff` is not one of them. Without this the birth turn is
    // returned by search as the person's own words. The predicate is the one
    // the render seams already use, never a second copy of the rule
    // (`@dorkos/shared/kickoff`).
    //
    // Dropping the record here cannot move a turn boundary: `endsAssistantTurn`
    // is decided on its own branch in the walk above, before this runs.
    if (isKickoffEnvelope(body)) return null;
    return { role: 'user', body };
  }

  if (line.type === 'assistant') {
    // A subagent's own turn is not this conversation's, and CLI-internal
    // records are nobody's. Same two exclusions the user branch inherits from
    // `isPersonAuthoredUserRecord`, stated here because that predicate answers
    // only for `user` records.
    if (line.isSidechain === true || line.isMeta === true) return null;
    // A synthetic API-error notice — an expired sign-in, a 5xx, a hit limit —
    // is the CLI reporting a failure, not the agent speaking, and the session
    // view now draws it as an error card rather than a sentence (DOR-1649).
    // Indexing it under the agent's voice would answer "what did it say" with
    // words nobody said. Skipped HERE only: it is still an assistant record for
    // run bookkeeping, and the parser still renders a message for it, so it
    // remains a valid closer for the run its uuid names.
    //
    // One unobserved shape diverges on purpose: a notice ALSO carrying a
    // `tool_use` block falls through to normal parsing there (so its tool calls
    // survive) and renders its text, while staying unindexed here. That costs a
    // search gap on words nobody said, never a mislanding — 0 of 249 records
    // measured carry one.
    if (isApiErrorRecord(line)) return null;
    // `extractTextContent` keeps `text` blocks and nothing else, so `thinking`
    // and `tool_use` blocks are excluded by construction rather than by a filter
    // that could be forgotten.
    const body = extractTextContent(line.message?.content ?? '').trim();
    return body === '' ? null : { role: 'assistant', body };
  }

  return null;
}
