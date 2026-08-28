/**
 * OpenCode's projection: message and part rows in, searchable messages out.
 *
 * **Pure.** No filesystem, no database, no clock — it is handed rows that
 * `opencode-store.ts` already read out of a snapshot, and it hands back
 * messages. That split is what lets every rule below be table-tested without a
 * SQLite file anywhere near the test.
 *
 * ## What survives
 *
 * Text, and only text. OpenCode splits a turn into parts — `text`, `reasoning`,
 * `tool`, `step-start`, `step-finish`, `snapshot`, `patch`, `agent` — and this
 * projection keeps `text`. The same rule the Claude Code projection follows, for
 * the same reasons (spec §1.2): reasoning is not something anyone said, and tool
 * input and output are arguments and file contents rather than speech.
 *
 * **It therefore keeps strictly less than the runtime's own history mapper**
 * (`runtimes/opencode/session-mapper.ts`), which the spec pointed at as reusable.
 * That mapper renders a conversation and so keeps reasoning blocks and tool
 * calls; this one answers "where did we talk about X". The two share their
 * authorship rules — `ignored` text never rendered, and `synthetic` user text is
 * SDK-injected rather than typed by a person — and diverge on everything that is
 * about display. Reusing the mapper directly is not possible in any case: it
 * returns `HistoryMessage` and is typed against `@opencode-ai/sdk`, whose import
 * is confined to the adapter directory (Hard Rule 2).
 *
 * ## What is counted rather than dropped
 *
 * A message whose `data` will not parse, whose parsed envelope is not an object,
 * or whose `role` is neither `user` nor `assistant`, is counted as `skipped` and
 * the session continues. So is a part whose `data` will not parse. That count is
 * the only thing separating "OpenCode's private JSON shape moved underneath us"
 * from "nobody said anything" — the sharpest negative recorded in
 * ADR 260728-214214 — and one bad row must never cost a session.
 *
 * A message that parses cleanly and simply has no text — an assistant turn that
 * only called a tool, a user turn that was only a file attachment — is dropped
 * silently. That is the expected outcome, not a drift signal.
 *
 * @module server/services/search/projections/opencode
 */
import type { ProjectedMessage, Projection } from '../types.js';

/**
 * One `message` row, with its `part` rows, as the snapshot read them.
 *
 * `data` fields are raw JSON text on purpose: parsing is this module's job, and
 * a store that hands over parsed objects has already decided what a malformed
 * one means.
 */
export interface OpenCodeMessageRow {
  /**
   * The message's position in its session, numbered from 1.
   *
   * Assigned by the read rather than by this function, because a message that
   * projects to nothing still occupies its position: numbering only what
   * survives would make the watermark advance past rows that were never read.
   */
  ordinal: number;

  /**
   * The OpenCode message id.
   *
   * Carried onto the indexed row as {@link ProjectedMessage.messageId}: it is
   * the same id the session view renders this message under — the mapper builds
   * `HistoryMessage.id` from the SDK's `info.id`, which is this row
   * (`runtimes/opencode/session-mapper.ts`) — so it is what lets a search hit
   * land on the message (DOR-1579).
   */
  id: string;

  /** `message.time_created`, epoch milliseconds. */
  timeCreated: number;

  /** `message.data` — the message envelope, as stored. */
  data: string;

  /** Each `part.data` belonging to this message, in part order. */
  parts: readonly string[];
}

/** The message envelope, as much of it as this projection reads. */
interface MessageEnvelope {
  role?: unknown;
}

/** The part envelope, as much of it as this projection reads. */
interface PartEnvelope {
  type?: unknown;
  text?: unknown;
  ignored?: unknown;
  synthetic?: unknown;
}

/**
 * Project OpenCode messages into searchable messages.
 *
 * @param originKey - The OpenCode session id. Composed by the read and parsed
 *   nowhere.
 * @param rows - The session's messages, in ordinal order, each carrying its own
 *   ordinal.
 * @returns The messages that carry text, and the count of rows whose shape this
 *   projection did not recognise.
 */
export function projectOpenCodeMessages(
  originKey: string,
  rows: readonly OpenCodeMessageRow[]
): Projection {
  const messages: ProjectedMessage[] = [];
  let skipped = 0;

  for (const row of rows) {
    const envelope = parseObject<MessageEnvelope>(row.data);
    if (envelope === null) {
      skipped += 1;
      continue;
    }

    if (envelope.role !== 'user' && envelope.role !== 'assistant') {
      skipped += 1;
      continue;
    }
    const role = envelope.role;

    const spoken: string[] = [];
    for (const raw of row.parts) {
      const part = parseObject<PartEnvelope>(raw);
      if (part === null) {
        skipped += 1;
        continue;
      }
      const text = readSpokenText(part, role);
      if (text !== null) spoken.push(text);
    }

    const body = spoken.join('\n').trim();
    if (body === '') continue;

    messages.push({
      originKey,
      ordinal: row.ordinal,
      // The store's own message id, or nothing for a row that carries none.
      // Never a substitute: an id invented here would differ on the next read.
      messageId: row.id === '' ? null : row.id,
      role,
      createdAt: toIso(row.timeCreated),
      body,
    });
  }

  return { messages, skipped };
}

/**
 * What one part contributes, or `null` when it is not something someone said.
 *
 * @param part - The parsed part envelope.
 * @param role - Whose message the part belongs to. `synthetic` only disqualifies
 *   a part on a USER message: SDK-injected user text is command expansions and
 *   system context nobody typed, while the flag means nothing on an assistant
 *   turn.
 */
function readSpokenText(part: PartEnvelope, role: 'user' | 'assistant'): string | null {
  if (part.type !== 'text') return null;
  if (part.ignored === true) return null;
  if (role === 'user' && part.synthetic === true) return null;
  if (typeof part.text !== 'string' || part.text === '') return null;
  return part.text;
}

/**
 * Parse JSON that must be a plain object.
 *
 * @param raw - The stored JSON text.
 * @returns The object, or `null` for anything that will not parse or parses to
 *   an array, a primitive, or `null`. All four are the same thing to a caller:
 *   a row whose shape this projection does not recognise.
 */
function parseObject<T>(raw: string): T | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as T;
}

/**
 * OpenCode's epoch-millisecond stamp as ISO-8601, or `null` when it is not a
 * time.
 *
 * A fabricated timestamp would sort results into an order nobody can explain, so
 * an unusable stamp contributes `null` rather than "now".
 */
function toIso(timeCreated: number): string | null {
  if (typeof timeCreated !== 'number' || !Number.isFinite(timeCreated)) return null;
  const at = new Date(timeCreated);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}
