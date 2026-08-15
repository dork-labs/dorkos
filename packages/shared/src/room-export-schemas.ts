/**
 * The JSONL a room export is made of — `GET /api/rooms/:id/export` and
 * `dorkos room export` (DOR-1225).
 *
 * Rooms live only in SQLite, which is a deliberate architecture decision and
 * costs them the things a file gives you for free: you cannot grep them, you
 * cannot copy them onto a USB stick, and you cannot take them with you when you
 * leave. An export is the **projection** that pays those back. It is a copy and
 * never a sync target: the database stays the truth, and nothing reads one of
 * these files back in.
 *
 * ## The format
 *
 * One JSON object per line, `type` first — the same family a session transcript
 * is in, on purpose. Three line types, always in this order:
 *
 * 1. **One {@link RoomExportHeaderSchema}** — the room, its roster, and who made
 *    the file when.
 * 2. **Zero or more {@link RoomExportEntrySchema}**, in ascending `seq`. Thread
 *    replies ride in the same stream as the messages they hang off, because a
 *    thread is a relation between entries and not a room of its own
 *    (ADR 260728-022013); `threadRootEntryId` is what puts one back in its
 *    thread.
 * 3. **One {@link RoomExportSummarySchema}** — the receipt. A file that stops
 *    without it was truncated, which is the one failure a downloaded copy
 *    cannot otherwise tell you about.
 *
 * ## Every line stands alone
 *
 * Author ids are resolved to names and handles **inline, on the line that uses
 * them** — the message's author, the people it mentions, and everyone behind
 * each reaction — rather than into one table at the top. That is what makes
 * `grep` work: one line tells you who said what to whom, without a reader that
 * holds the header in memory. It costs a little repetition, and repetition is
 * exactly what a greppable file is made of.
 *
 * @module shared/room-export-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { ResponseModeSchema } from './mesh-schemas.js';
import {
  AuthorKindSchema,
  ReactionEmojiSchema,
  RoomAttachmentSchema,
  RoomEntryKindSchema,
  RoomKindSchema,
  RoomMomentSchema,
  RoomNoticeCodeSchema,
} from './room-schemas.js';

extendZodWithOpenApi(z);

/**
 * What the file says it is, on its header line.
 *
 * A named constant rather than a bare string so a reader can check one field and
 * know it is not looking at a session transcript, which is the same shape and a
 * different thing.
 */
export const ROOM_EXPORT_FORMAT = 'dorkos.room-export';

/**
 * The format version.
 *
 * **What bumps it: anything a reader of version 1 would get wrong.** An existing
 * field that changes meaning or leaves, and — the case worth spelling out —
 * **a new `type` of line.** {@link RoomExportLineSchema} is a discriminated
 * union, so a fourth line type is not an addition a reader can shrug off: a
 * strict reader refuses the file outright and a lenient one silently skips
 * whatever the new line was carrying. Either way it is a break, so it is a bump.
 *
 * **What does not bump it: a new FIELD on an existing line type.** Readers are
 * expected to ignore fields they do not know, and a version that moved on every
 * addition would train people to stop reading it.
 *
 * The obligation that makes both halves work is on the reader, and it is the one
 * thing a consumer of this format must implement: **parse each line, and treat
 * an unrecognized `type` as a reason to check the header's `version` — not as a
 * corrupt file.** That is what lets a version-1 reader give an honest "this file
 * is newer than I am" instead of a parse error.
 */
export const ROOM_EXPORT_VERSION = 1;

/**
 * Who somebody is, as an export line names them.
 *
 * A deliberately thinner {@link AuthorRefSchema} — no `emoji`, `color` or
 * `imageUrl`. Those three are a render cache pointing at state that lives
 * somewhere else on this machine, and a file you took with you when you left
 * cannot resolve them. What survives the trip is identity: the id it was stored
 * under, what it was called, and what you typed to reach it.
 */
export const RoomExportAuthorSchema = z
  .object({
    id: z.string().min(1).describe('Opaque author id (ULID), exactly as the room stored it.'),
    kind: AuthorKindSchema,
    displayName: z.string().min(1).describe('What this author was called at the time of export.'),
    handle: z
      .string()
      .nullable()
      .describe('What you typed after an `@` to reach them, or `null` when nothing did.'),
    agentRef: z
      .string()
      .optional()
      .describe('Agents only: the stable reference derived from the agent directory.'),
  })
  .openapi('RoomExportAuthor');

export type RoomExportAuthor = z.infer<typeof RoomExportAuthorSchema>;

/** One member of the room, as the header lists them. */
export const RoomExportMemberSchema = z
  .object({
    author: RoomExportAuthorSchema,
    responseMode: ResponseModeSchema.describe("This member's per-room response mode."),
    joinedAt: z.string().describe('When they joined.'),
    joinedSeq: z
      .number()
      .int()
      .min(0)
      .describe("The room's highest seq when they joined — the floor under what they can read."),
  })
  .openapi('RoomExportMember');

export type RoomExportMember = z.infer<typeof RoomExportMemberSchema>;

/**
 * How much of the room this file holds, and why it is not more.
 *
 * **The one place the join-seq decision is visible**, and it is on the file
 * rather than only in the code that wrote it: somebody reading an export a year
 * from now has to be able to tell "this is the whole room" from "this is my
 * slice of it" without asking the server that made it.
 */
export const RoomExportScopeSchema = z
  .object({
    fromSeq: z
      .number()
      .int()
      .min(0)
      .describe(
        'The exclusive floor: entries strictly above this are in the file. `0` means the room from its first message.'
      ),
    joinFloorApplied: z
      .boolean()
      .describe(
        "Whether `fromSeq` is the exporter's own join point. `false` on the operator's export of their own room — the whole-room copy that is the exit path — and `true` for everybody else, who does not retroactively read what was said before they arrived."
      ),
  })
  .openapi('RoomExportScope');

export type RoomExportScope = z.infer<typeof RoomExportScopeSchema>;

/** The first line of every export: what this is, of what, by whom, and when. */
export const RoomExportHeaderSchema = z
  .object({
    type: z.literal('room-export'),
    format: z.literal(ROOM_EXPORT_FORMAT),
    version: z.literal(ROOM_EXPORT_VERSION),
    exportedAt: z.string().describe('When the file was written (ISO 8601).'),
    exportedBy: RoomExportAuthorSchema.describe('Who asked for it.'),
    dorkosVersion: z.string().describe('The DorkOS version that wrote it.'),
    room: z
      .object({
        id: z.string().min(1),
        kind: RoomKindSchema,
        slug: z.string().nullable().describe('Channels only.'),
        title: z.string().min(1),
        topic: z.string().nullable(),
        archived: z.boolean(),
        wellKnown: z
          .string()
          .nullable()
          .describe("`'team'` for the channel every install is opened with, else `null`."),
        createdAt: z.string(),
        lastActivityAt: z.string(),
      })
      .describe('The room itself, as it stood when the file was written.'),
    members: z.array(RoomExportMemberSchema).describe('The roster, oldest membership first.'),
    scope: RoomExportScopeSchema,
  })
  .openapi('RoomExportHeader');

export type RoomExportHeader = z.infer<typeof RoomExportHeaderSchema>;

/** Everyone who left one emoji on one message, with each of them resolved. */
export const RoomExportReactionSchema = z
  .object({
    emoji: ReactionEmojiSchema,
    firstAt: z.string().describe('When the first of these landed.'),
    by: z.array(RoomExportAuthorSchema).describe('Who reacted, in the order they did.'),
  })
  .openapi('RoomExportReaction');

export type RoomExportReaction = z.infer<typeof RoomExportReactionSchema>;

/**
 * One message, or one thing the room said about itself.
 *
 * `text` sits at the top level rather than under a `body` object, because the
 * point of the file is that a person can read a line of it, and a message's
 * words are the thing they are looking for.
 *
 * **Attachments are references, not bytes.** `url` is server-relative and only
 * answers while this install is running; `id`, `name`, `size` and `mimeType` are
 * what survives on their own. A JSONL file cannot carry a 40MB video without
 * ceasing to be greppable, so it carries the manifest of what was shared instead.
 */
export const RoomExportEntrySchema = z
  .object({
    type: z.literal('entry'),
    seq: z.number().int().min(1).describe("The entry's position in the room. Ascending, no gaps."),
    id: z.string().min(1),
    createdAt: z.string(),
    kind: RoomEntryKindSchema.describe(
      "`post` for somebody talking, `notice` for the room's own voice."
    ),
    author: RoomExportAuthorSchema,
    text: z.string(),
    notice: RoomNoticeCodeSchema.optional().describe(
      "Notices only: which of the room's standing lines this is."
    ),
    subject: RoomExportAuthorSchema.optional().describe(
      'Who a notice or a moment is ABOUT, when that is not its author.'
    ),
    moment: RoomMomentSchema.optional().describe('The milestone this post marks, if any.'),
    mentions: z
      .array(RoomExportAuthorSchema)
      .describe(
        'Who this message addressed, resolved once at write time and never re-parsed from the text.'
      ),
    sessionId: z
      .string()
      .nullable()
      .describe('The agent session that produced this, when one did.'),
    parentEntryId: z.string().nullable().describe('The entry this answers, for a thread reply.'),
    threadRootEntryId: z
      .string()
      .nullable()
      .describe("The head of this entry's thread, or `null` when it is top-level."),
    reactions: z.array(RoomExportReactionSchema).describe('Oldest pill first. `[]` when none.'),
    attachments: z
      .array(RoomAttachmentSchema)
      .describe('The files posted with this message, by reference. `[]` when none.'),
  })
  .openapi('RoomExportEntry');

export type RoomExportEntry = z.infer<typeof RoomExportEntrySchema>;

/**
 * The last line: the receipt that says the file is whole.
 *
 * A download that dies half-way is a valid JSONL file of the messages that made
 * it, and nothing inside it would say so. This line is how a reader tells a
 * complete export from a truncated one — check that the last line is a
 * `summary`, then check `entryCount` against the entry lines you read.
 */
export const RoomExportSummarySchema = z
  .object({
    type: z.literal('summary'),
    entryCount: z.number().int().min(0).describe('How many `entry` lines precede this one.'),
    firstSeq: z
      .number()
      .int()
      .min(1)
      .nullable()
      .describe('The seq of the first entry in the file, or `null` when it holds none.'),
    lastSeq: z
      .number()
      .int()
      .min(1)
      .nullable()
      .describe('The seq of the last entry in the file, or `null` when it holds none.'),
  })
  .openapi('RoomExportSummary');

export type RoomExportSummary = z.infer<typeof RoomExportSummarySchema>;

/**
 * Any one line of an export, told apart by `type`.
 *
 * The schema a reader parses each line against. A discriminated union rather
 * than a loose object, so an unrecognized `type` fails at that line instead of
 * quietly parsing as a message with no text.
 *
 * **That strictness is why a new line type bumps {@link ROOM_EXPORT_VERSION}.**
 * This schema refuses a `type` it does not know, so a fourth kind of line is a
 * breaking change for every existing reader and is versioned as one — see the
 * version constant for the full policy, and for the reader's side of it: a
 * refusal here means "check the header's `version`", never "this file is
 * corrupt".
 */
export const RoomExportLineSchema = z
  .discriminatedUnion('type', [
    RoomExportHeaderSchema,
    RoomExportEntrySchema,
    RoomExportSummarySchema,
  ])
  .openapi('RoomExportLine');

export type RoomExportLine = z.infer<typeof RoomExportLineSchema>;

/** The media type a room export is served as. One object per line, UTF-8. */
export const ROOM_EXPORT_CONTENT_TYPE = 'application/x-ndjson';

/**
 * The filename an export is offered under.
 *
 * A channel is named by its slug, which is the name a person knows it by; a DM
 * has none, so it falls back to the id. The date is the export's, never the
 * room's: two exports of one room a month apart must not overwrite each other in
 * a downloads folder.
 *
 * @param room - The room's slug (channels) and id.
 * @param exportedAt - The export timestamp, ISO 8601.
 */
export function roomExportFilename(
  room: { slug: string | null; id: string },
  exportedAt: string
): string {
  const day = exportedAt.slice(0, 10);
  // The slug is already `[a-z0-9-]` by construction and an id is a ULID, so
  // neither can contribute a path separator or a quote to the name.
  return `room-${room.slug ?? room.id}-${day}.jsonl`;
}
