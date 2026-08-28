/**
 * What a room's files look like on the wire (spec `project-rooms` §3.9).
 *
 * A project room keeps its files in a git repo DorkOS owns, and this is the
 * read-only view of it: one directory at a time, each entry carrying who last
 * touched it, plus a single file's contents.
 *
 * **Everything here describes a COMMIT, never a working directory.** The server
 * reads `main`'s tip through git's own plumbing, so a half-written edit sitting
 * in the checkout is not something a reader can see, and a `.git` directory is
 * not something a path can reach — it is not in the tree. `commit` on every
 * response says exactly which snapshot was read, which is also what a later
 * write will check itself against.
 *
 * **The bodies are member-written content.** Nothing in a listing or a file is
 * authored by DorkOS, so a client renders it as untrusted text — the same
 * treatment a message body gets — and never as a document with an origin.
 *
 * @module room-files
 */
import { z } from 'zod';

/**
 * What a directory entry IS.
 *
 * A `symlink` is listed rather than followed, and that is the whole reason it
 * is a kind of its own: a link in the tree can name anything, including a path
 * outside the repo, so the reader shows it as a link and refuses to serve what
 * it points at. `submodule` is the same posture for a gitlink — a pointer at
 * another repository, which this API has nothing to say about.
 */
export const RoomFileKindSchema = z.enum(['file', 'dir', 'symlink', 'submodule']);

/** What a directory entry is. See {@link RoomFileKindSchema}. */
export type RoomFileKind = z.infer<typeof RoomFileKindSchema>;

/**
 * The last commit that touched one path — a room's answer to "who changed
 * this, and when".
 *
 * `author` is the name on the commit, which for a room repo is a person's
 * profile name or an agent's, and is member-written text like any other label.
 */
export const RoomFileCommitSchema = z.object({
  /** The full commit sha. */
  sha: z.string(),
  /** The name on the commit. Untrusted text; render it as a label, never as markup. */
  author: z.string(),
  /** When it was authored, ISO 8601 with an offset. */
  at: z.string(),
  /** The commit's subject line. Untrusted text. */
  subject: z.string(),
});

/** The last commit that touched a path. See {@link RoomFileCommitSchema}. */
export type RoomFileCommit = z.infer<typeof RoomFileCommitSchema>;

/** One entry in a room directory listing. */
export const RoomFileEntrySchema = z.object({
  /** The entry's own name, with no directory in it. */
  name: z.string(),
  /**
   * Its path from the repo root, `/`-separated and never leading with one.
   *
   * **Hand this straight back to the content route.** The server never rewrites
   * a path — no trimming, no case folding, no unicode normalisation — so what a
   * listing mints is exactly what a read accepts, and a name that ends in a
   * space stays a name that ends in a space.
   */
  path: z.string(),
  /** What it is. See {@link RoomFileKindSchema}. */
  kind: RoomFileKindSchema,
  /**
   * The blob's size in bytes. `0` for a directory and for a submodule, which
   * have no bytes of their own; a symlink's size is the length of the path it
   * names, which is all a link stores.
   */
  size: z.number().int().nonnegative(),
  /**
   * Who last touched this entry, or `null` when nobody in the searched window
   * did.
   *
   * `null` is an honest "not known here", not "never changed": provenance comes
   * from one bounded walk of the room's history, so an entry untouched for
   * longer than that window answers `null` rather than costing a git process of
   * its own.
   */
  lastCommit: RoomFileCommitSchema.nullable(),
});

/** One entry in a room directory listing. See {@link RoomFileEntrySchema}. */
export type RoomFileEntry = z.infer<typeof RoomFileEntrySchema>;

/** `GET /api/rooms/{id}/files` — the directory to list, defaulting to the root. */
export const RoomFilesQuerySchema = z.object({
  /**
   * The directory, relative to the repo root. Omitted or empty means the root.
   *
   * Refused before git is asked anything: `..`, an absolute path, a backslash,
   * a control character, a doubled slash, and leading or trailing whitespace.
   * The last one is a refusal rather than a repair because a filename may
   * legitimately end in a space, and trimming the REQUEST would answer with a
   * different file's contents. One trailing `/` is fine — `docs/` is `docs`.
   */
  path: z.string().optional(),
});

/** The query `GET /api/rooms/{id}/files` takes. See {@link RoomFilesQuerySchema}. */
export type RoomFilesQuery = z.infer<typeof RoomFilesQuerySchema>;

/** One directory of a room's files. */
export const RoomFileListResponseSchema = z.object({
  /** The directory that was listed, `''` for the repo root. */
  path: z.string(),
  /**
   * The commit this listing was read from, or `null` when the repo has no
   * commits at all.
   */
  commit: z.string().nullable(),
  /**
   * Directories first, then files, each group in code-unit order.
   *
   * Byte order, deliberately not the machine's locale: one room lists the same
   * way on every computer, so a client diffing two listings never sees a
   * phantom move. Every capital therefore sorts ahead of every lowercase.
   */
  entries: z.array(RoomFileEntrySchema),
});

/** One directory of a room's files. See {@link RoomFileListResponseSchema}. */
export type RoomFileListResponse = z.infer<typeof RoomFileListResponseSchema>;

/** `GET /api/rooms/{id}/files/content` — which file to read. */
export const RoomFileContentQuerySchema = z.object({
  /**
   * The file, relative to the repo root. Required — there is no default file.
   *
   * Use a `path` a listing gave you: it is accepted verbatim, and the same
   * refusals the listing route applies apply here.
   */
  path: z.string().min(1),
});

/** The query the content route takes. See {@link RoomFileContentQuerySchema}. */
export type RoomFileContentQuery = z.infer<typeof RoomFileContentQuerySchema>;

/**
 * How a file was answered.
 *
 * Three outcomes rather than one plus two errors, because "too big to show" and
 * "not text" are facts about the file that a reader should render, not failures
 * of the request. Only `text` carries bytes: a binary file's contents are never
 * decoded into a string, which is what stops a reader treating arbitrary bytes
 * as characters.
 */
export const RoomFileBodySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    /** Always `utf-8`; a file that is not valid UTF-8 answers as `binary`. */
    encoding: z.literal('utf-8'),
    /** The file's contents, exactly as committed. */
    text: z.string(),
  }),
  z.object({
    kind: z.literal('binary'),
  }),
  z.object({
    kind: z.literal('too-large'),
    /** The ceiling that was applied, so the reader can say how far over it is. */
    maxBytes: z.number().int().positive(),
  }),
]);

/** How a file was answered. See {@link RoomFileBodySchema}. */
export type RoomFileBody = z.infer<typeof RoomFileBodySchema>;

/** One file from a room's repo. */
export const RoomFileContentResponseSchema = z.object({
  /** The file's path from the repo root. */
  path: z.string(),
  /** The commit it was read from. */
  commit: z.string(),
  /** Its size in bytes, whether or not the bytes were sent. */
  size: z.number().int().nonnegative(),
  /** Who last touched it, or `null`. See {@link RoomFileEntrySchema}. */
  lastCommit: RoomFileCommitSchema.nullable(),
  /** The contents, or why they are not here. See {@link RoomFileBodySchema}. */
  body: RoomFileBodySchema,
});

/** One file from a room's repo. See {@link RoomFileContentResponseSchema}. */
export type RoomFileContentResponse = z.infer<typeof RoomFileContentResponseSchema>;
