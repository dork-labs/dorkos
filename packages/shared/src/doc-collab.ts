/**
 * Live doc editing on the wire (DOR-2984): the socket every editor of a doc
 * joins, the notes the server sends beside Yjs sync, and the saved versions a
 * person can restore.
 *
 * A doc is a markdown file named `{ cwd, path }`: `cwd` is the session working
 * directory the canvas already uses for `/api/files`, `path` is relative to it.
 *
 * The socket speaks the Yjs sync and awareness protocols (`y-protocols`) in
 * the framing `y-websocket` uses: each binary frame starts with a varint
 * message type ({@link DOC_COLLAB_MESSAGE}), then its payload. The server adds
 * one type of its own, {@link DOC_COLLAB_MESSAGE.note}, whose payload is a
 * JSON {@link DocCollabNote} as a varstring.
 *
 * @module shared/doc-collab
 */
import { z } from 'zod';

/** The socket path. The doc is named by `cwd` and `path` query parameters. */
export const DOC_COLLAB_SOCKET_PATH = '/api/documents/live';

/** The message types a frame on the doc socket starts with. */
export const DOC_COLLAB_MESSAGE = {
  /** Yjs sync (`y-protocols/sync`): step 1, step 2 and updates. */
  sync: 0,
  /** Presence (`y-protocols/awareness`). */
  awareness: 1,
  /** A {@link DocCollabNote} from the server. */
  note: 100,
} as const;

/** A doc, as every Docs route names it. */
export const DocRefSchema = z.object({
  /** The session working directory the doc is reached from. */
  cwd: z.string().min(1),
  /** The doc's path inside it. */
  path: z.string().min(1),
});

/** A doc, as every Docs route names it. */
export type DocRef = z.infer<typeof DocRefSchema>;

/** Who changed a doc. */
export const DocWriterSchema = z.object({
  /**
   * `agent` for an agent's write, `person` for a person's (a restore),
   * `disk` for a change to the file that DorkOS did not make itself.
   */
  kind: z.enum(['agent', 'person', 'disk']),
  /** The writer's name, when known. */
  name: z.string().optional(),
});

/** Who changed a doc. */
export type DocWriter = z.infer<typeof DocWriterSchema>;

/**
 * Why a version was kept: `before-change` is the doc just before somebody
 * other than its editors changed it (`changedBy`); `unsaved-edits` is text an
 * editor typed that could not reach the file or the live doc, kept so it can
 * be put back.
 */
export const DocVersionReasonSchema = z.enum(['before-change', 'unsaved-edits']);

/** Why a version was kept. */
export type DocVersionReason = z.infer<typeof DocVersionReasonSchema>;

/** One saved version of a doc. */
export const DocVersionSchema = z.object({
  /** Sortable, unique within the doc. */
  id: z.string(),
  /** When it was saved. ISO 8601. */
  savedAt: z.string(),
  /** Why it was kept. */
  reason: DocVersionReasonSchema.default('before-change'),
  /** Whose change came right after this version (for `unsaved-edits`, who typed it). */
  changedBy: DocWriterSchema,
  /** Its size, in bytes. */
  bytes: z.number().int().nonnegative(),
});

/** One saved version of a doc. */
export type DocVersion = z.infer<typeof DocVersionSchema>;

/** A doc's saved versions, newest first. */
export const DocVersionListSchema = z.object({
  versions: z.array(DocVersionSchema),
});

/** A doc's saved versions, newest first. */
export type DocVersionList = z.infer<typeof DocVersionListSchema>;

/** Keep text an editor could not save as a version of the doc, so it can be put back. */
export const KeepDocDraftRequestSchema = DocRefSchema.extend({
  /** The text, as markdown. */
  markdown: z.string().max(5 * 1024 * 1024),
});

/** Keep text an editor could not save as a version. */
export type KeepDocDraftRequest = z.infer<typeof KeepDocDraftRequestSchema>;

/** Put a saved version back. */
export const RestoreDocVersionRequestSchema = DocRefSchema.extend({
  /** The version to restore. */
  versionId: z.string().min(1),
});

/** Put a saved version back. */
export type RestoreDocVersionRequest = z.infer<typeof RestoreDocVersionRequestSchema>;

/** What a restore did. */
export const RestoreDocVersionResponseSchema = z.object({
  ok: z.literal(true),
  /** Whether the doc was open, so the restore reached its editors live. */
  live: z.boolean(),
});

/** What a restore did. */
export type RestoreDocVersionResponse = z.infer<typeof RestoreDocVersionResponseSchema>;

/** A note the server sends on the doc socket, beside Yjs sync. */
export const DocCollabNoteSchema = z.discriminatedUnion('type', [
  z.object({
    /** First on every connection: which copy of the doc this server holds. */
    type: z.literal('hello'),
    /**
     * Changes whenever the server loads the doc afresh. An editor that held an
     * older copy must start again from this one rather than merge into it.
     */
    generation: z.string(),
  }),
  z.object({
    /** Somebody other than an editor on this socket changed the doc. */
    type: z.literal('changed'),
    changedBy: DocWriterSchema,
  }),
  z.object({
    /** The doc's saved versions changed. */
    type: z.literal('versions'),
  }),
  z.object({
    /**
     * The doc's file was moved or deleted. Its text is kept as a version; the
     * doc stops saving until the file is back.
     */
    type: z.literal('gone'),
  }),
  z.object({
    /**
     * Proof of life, every few seconds, so an editor notices a connection
     * that died without closing and reconnects.
     */
    type: z.literal('heartbeat'),
  }),
  z.object({
    /**
     * The file now holds the doc as of `snapshot` (an encoded Yjs snapshot,
     * base64: what was inserted AND what was deleted). An editor whose doc
     * the snapshot fully contains has nothing unsaved. Sent after each save,
     * and on joining.
     */
    type: z.literal('saved'),
    /** The file's sha256 after the save: what a later save of this text is based on. */
    hash: z.string(),
    snapshot: z.string(),
  }),
]);

/** How often the server sends a heartbeat note to each editor. */
export const DOC_COLLAB_HEARTBEAT_MS = 15_000;

/** The socket query parameter an editor names the copy of the doc it holds with. */
export const DOC_COLLAB_GENERATION_PARAM = 'generation';

/** A note the server sends on the doc socket. */
export type DocCollabNote = z.infer<typeof DocCollabNoteSchema>;
