/**
 * Comments on a doc (DOR-2983): threads anchored to words in a markdown file,
 * kept in their own store beside the file rather than in it.
 *
 * A doc is `{ cwd, path }` on the wire (the canvas's working directory and a
 * path inside it). A thread's `anchor` is opaque here: the editor's
 * `@blintz/comments` makes it and reads it back, and the server only stores
 * it. Authors are room authors, so a person or an agent has one identity
 * whether they write in a room or on a doc.
 *
 * @module shared/doc-comments
 */
import { z } from 'zod';

/** The longest comment, in characters. */
export const DOC_COMMENT_BODY_MAX = 10_000;

/** The largest stored anchor, as JSON. An editor anchor is a quote with 32 characters of context. */
export const DOC_COMMENT_ANCHOR_MAX_BYTES = 8_192;

/** How many UTF-8 bytes a value takes as JSON. */
function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** How many anchors one batch update may carry. */
export const DOC_COMMENT_ANCHOR_BATCH_MAX = 500;

/** The longest doc path a comment route accepts. */
export const DOC_PATH_MAX = 1_024;

/**
 * A thread's place in the text, as the editor made it. Opaque: any JSON
 * object, stored and handed back untouched.
 */
export const DocCommentAnchorSchema = z
  .object({})
  .catchall(z.unknown())
  .refine((anchor) => jsonBytes(anchor) <= DOC_COMMENT_ANCHOR_MAX_BYTES, {
    message: `An anchor must be under ${DOC_COMMENT_ANCHOR_MAX_BYTES} bytes.`,
  });

/** A thread's place in the text. See {@link DocCommentAnchorSchema}. */
export type DocCommentAnchor = z.infer<typeof DocCommentAnchorSchema>;

/** Which doc a request is about: the folder the canvas reads files from, and a path inside it. */
export const DocRefSchema = z.object({
  /** The working directory, as the files routes take it. */
  cwd: z.string().min(1),
  /** The doc's path inside it. */
  path: z.string().min(1).max(DOC_PATH_MAX),
});

/** Which doc a request is about. */
export type DocRef = z.infer<typeof DocRefSchema>;

/** Who wrote a comment, as a reader is shown them. */
export const DocCommentAuthorSchema = z.object({
  /** The author's id (a room author id). */
  id: z.string(),
  /** A person, an agent, or DorkOS itself. */
  kind: z.enum(['human', 'agent', 'system']),
  /** The name to show. */
  displayName: z.string(),
  /** What follows an `@` to reach them, or `null` when nothing does. */
  handle: z.string().nullable(),
  /** Emoji avatar, when they have one. */
  emoji: z.string().nullable(),
  /** Identity colour, when they have one. */
  color: z.string().nullable(),
  /** Whether this author is the person who owns this computer. */
  isOwner: z.boolean(),
});

/** Who wrote a comment. */
export type DocCommentAuthor = z.infer<typeof DocCommentAuthorSchema>;

/** One comment in a thread. */
export const DocCommentSchema = z.object({
  /** The comment's id. */
  id: z.string(),
  /** The thread it belongs to. */
  threadId: z.string(),
  /** Who wrote it. */
  author: DocCommentAuthorSchema,
  /** What they wrote (markdown). */
  body: z.string(),
  /** Author ids its `@handles` reached, resolved once when it was written. */
  mentions: z.array(z.string()),
  /** When it was written (ISO 8601). */
  createdAt: z.string(),
  /** When its author last changed it, or `null` when never. */
  editedAt: z.string().nullable(),
});

/** One comment in a thread. */
export type DocComment = z.infer<typeof DocCommentSchema>;

/** A thread of comments on some words of a doc. */
export const DocCommentThreadSchema = z.object({
  /** The thread's id. */
  id: z.string(),
  /** The doc's path inside its folder, normalized. */
  path: z.string(),
  /** Where it sits in the text. Opaque; see {@link DocCommentAnchorSchema}. */
  anchor: DocCommentAnchorSchema,
  /** Whether somebody marked it done. */
  resolved: z.boolean(),
  /** When it was marked done, or `null`. */
  resolvedAt: z.string().nullable(),
  /** Who marked it done, or `null`. */
  resolvedBy: DocCommentAuthorSchema.nullable(),
  /** When it was opened (ISO 8601). */
  createdAt: z.string(),
  /** When anything in it last changed (ISO 8601). */
  updatedAt: z.string(),
  /** Its comments, oldest first. The first one opened the thread. */
  comments: z.array(DocCommentSchema),
});

/** A thread of comments. */
export type DocCommentThread = z.infer<typeof DocCommentThreadSchema>;

/** `GET /api/documents/comments`'s answer. */
export const DocCommentThreadListSchema = z.object({
  /** Every thread on the doc, resolved ones included, oldest first. */
  threads: z.array(DocCommentThreadSchema),
});

/** `GET /api/documents/comments`'s answer. */
export type DocCommentThreadList = z.infer<typeof DocCommentThreadListSchema>;

/** A comment's words, as a writer sends them. */
const BodySchema = z.string().trim().min(1).max(DOC_COMMENT_BODY_MAX);

/** `POST /api/documents/comments/threads`: open a thread with its first comment. */
export const CreateDocCommentThreadSchema = DocRefSchema.extend({
  /** Where it sits, from the editor's `anchorSelection()`. */
  anchor: DocCommentAnchorSchema,
  /** The first comment. */
  body: BodySchema,
});

/** Open a thread with its first comment. */
export type CreateDocCommentThreadRequest = z.infer<typeof CreateDocCommentThreadSchema>;

/** `POST /api/documents/comments/threads/:threadId/replies`: add a comment to a thread. */
export const ReplyDocCommentSchema = DocRefSchema.extend({
  /** The comment. */
  body: BodySchema,
});

/** Add a comment to a thread. */
export type ReplyDocCommentRequest = z.infer<typeof ReplyDocCommentSchema>;

/** `PATCH /api/documents/comments/threads/:threadId`: mark a thread done, or open it again. */
export const SetDocCommentThreadResolvedSchema = DocRefSchema.extend({
  /** `true` to mark it done, `false` to reopen it. */
  resolved: z.boolean(),
});

/** Mark a thread done, or open it again. */
export type SetDocCommentThreadResolvedRequest = z.infer<typeof SetDocCommentThreadResolvedSchema>;

/** `PATCH /api/documents/comments/threads/:threadId/comments/:commentId`: change your own comment. */
export const EditDocCommentSchema = DocRefSchema.extend({
  /** The comment's new words. */
  body: BodySchema,
});

/** Change your own comment. */
export type EditDocCommentRequest = z.infer<typeof EditDocCommentSchema>;

/** `PUT /api/documents/comments/anchors`: save the anchors the editor moved. */
export const UpdateDocCommentAnchorsSchema = DocRefSchema.extend({
  /** Each moved thread and its fresh anchor, from the editor's `onAnchorsChange`. */
  updates: z
    .array(z.object({ id: z.string().min(1), anchor: DocCommentAnchorSchema }))
    .max(DOC_COMMENT_ANCHOR_BATCH_MAX),
});

/** Save the anchors the editor moved. */
export type UpdateDocCommentAnchorsRequest = z.infer<typeof UpdateDocCommentAnchorsSchema>;

/** `PUT /api/documents/comments/anchors`'s answer. */
export const UpdateDocCommentAnchorsResultSchema = z.object({
  /** How many threads took a new anchor. Ids that are not this doc's threads are skipped. */
  updated: z.number().int().nonnegative(),
});

/** `PUT /api/documents/comments/anchors`'s answer. */
export type UpdateDocCommentAnchorsResult = z.infer<typeof UpdateDocCommentAnchorsResultSchema>;

/** Somebody a comment can `@`-mention. */
export const DocCommentMentionableSchema = DocCommentAuthorSchema.extend({
  /** Never `null` here: only somebody with a handle can be mentioned. */
  handle: z.string(),
});

/** Somebody a comment can mention. */
export type DocCommentMentionable = z.infer<typeof DocCommentMentionableSchema>;

/** `GET /api/documents/comments/mentionable`'s answer. */
export const DocCommentMentionableListSchema = z.object({
  /** Agents first, then people, each by name. */
  people: z.array(DocCommentMentionableSchema),
});

/** `GET /api/documents/comments/mentionable`'s answer. */
export type DocCommentMentionableList = z.infer<typeof DocCommentMentionableListSchema>;

/** A mentioned agent a comment did not wake, and why. */
export const DocCommentUnreachedSchema = z.object({
  /** The agent's author id. */
  authorId: z.string(),
  /** Its name. */
  name: z.string(),
  /**
   * Why: `depth` (the chain of automatic replies reached its limit), `repeat`
   * (this agent was already woken as often as one chain allows), `budget`
   * (the hour's automatic turns are spent), `unprompted` (an agent wrote the
   * comment outside a turn a comment woke, and only such a turn may wake
   * another agent), or `unavailable` (the agent or the computer could not take
   * it just now).
   */
  reason: z.enum(['depth', 'repeat', 'budget', 'unprompted', 'unavailable']),
});

/** A mentioned agent a comment did not wake. */
export type DocCommentUnreached = z.infer<typeof DocCommentUnreachedSchema>;

/** What opening a thread or replying answers with. */
export const DocCommentWriteResultSchema = z.object({
  /** The thread as it is now. */
  thread: DocCommentThreadSchema,
  /** Mentioned agents that were not woken. Empty when everyone was. */
  unreached: z.array(DocCommentUnreachedSchema),
});

/** What opening a thread or replying answers with. */
export type DocCommentWriteResult = z.infer<typeof DocCommentWriteResultSchema>;

/** What resolving, reopening or editing answers with. */
export const DocCommentThreadResultSchema = z.object({
  /** The thread as it is now. */
  thread: DocCommentThreadSchema,
});

/** What resolving, reopening or editing answers with. */
export type DocCommentThreadResult = z.infer<typeof DocCommentThreadResultSchema>;
