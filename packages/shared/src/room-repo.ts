/**
 * The room-repo sidecar: what DorkOS knows about a room's own git repo.
 *
 * A project room keeps its files in a git repo under the DorkOS data directory,
 * and `room-repo.json` is the file-first truth for that binding (spec
 * `project-rooms` §3.1). It follows the `agent.json` pattern of ADR-0043:
 * written before any cache row, deleted after it, and reconciled back into the
 * `room_repos` table by a sweep. Nothing of substance lives only in SQLite —
 * git itself is most of the truth.
 *
 * ```
 * {dorkHome}/rooms/<roomId>/
 *   room-repo.json       <- this schema
 *   attachments/
 *   repo/                <- the room's main checkout, the integration tree
 *   worktrees/<agentSlug>/
 * ```
 *
 * **The sidecar sits OUTSIDE `repo/` on purpose.** It records what the room's
 * repo is allowed to be — its mode and its caps — and a repo that could rewrite
 * that file could rewrite its own grant. Member-written content never decides
 * what member-written content may do.
 *
 * @module room-repo
 */
import { z } from 'zod';

/**
 * The vocabulary of room-repo modes, including the one this build does not
 * implement.
 *
 * `'owned'` is a repo DorkOS created and holds entirely: it lives under the
 * DorkOS data directory, DorkOS is the only writer of its main branch, and
 * nothing outside a room depends on it.
 *
 * `'linked'` — binding a room to a checkout that already exists somewhere else
 * on the machine — is **reserved, not built** (spec `project-rooms`
 * §Non-Goals). It is named here rather than left out so that a sidecar written
 * by a future build parses into a value this build can recognise and refuse by
 * name, instead of failing with "expected 'owned'" and leaving the operator to
 * guess what happened. {@link RoomRepoSidecarSchema} is what refuses it.
 */
export const RoomRepoModeSchema = z.enum(['owned', 'linked']);

/** A room-repo mode, `'linked'` included. See {@link RoomRepoModeSchema}. */
export type RoomRepoMode = z.infer<typeof RoomRepoModeSchema>;

/**
 * What a caller is told when a sidecar names a mode this build does not
 * implement.
 *
 * Exported so the refusal reads the same everywhere — the parse error, the
 * enable route, and any test that pins it are one string, not three.
 */
export const LINKED_REPO_UNSUPPORTED_MESSAGE =
  'Linked repos are not built yet — a room repo has to be one DorkOS owns';

/**
 * The size ceilings a room repo enforces, and the values every new binding gets
 * (spec `project-rooms` §3.1).
 *
 * These are stored ON the sidecar rather than read from user config at use
 * time, so a room's caps are what it was created under and a config change
 * cannot retroactively make an existing repo's contents illegal. Config seeds
 * them; the sidecar remembers them.
 */
export const ROOM_REPO_CAP_DEFAULTS = {
  /** 5 MB — one file. Anything larger belongs in the room's attachments. */
  maxFileBytes: 5 * 1024 * 1024,
  /** 500 MB — the whole checkout. */
  maxRepoBytes: 500 * 1024 * 1024,
  /** 24 KB — `ROOM.md`, which rides every member agent's turn. */
  maxRoomMdBytes: 24 * 1024,
} as const;

/**
 * The caps a room repo carries.
 *
 * Every leaf has a default and the object itself does too, so a sidecar written
 * before a cap existed still parses and gains the new ceiling — which is the
 * behaviour a file-first store needs when the schema outruns the files on disk.
 */
export const RoomRepoCapsSchema = z
  .object({
    /**
     * The largest single file a merge may bring into the room's main tree.
     * Over-cap files refuse the merge (`FILE_TOO_LARGE`); they are never
     * truncated or silently skipped.
     */
    maxFileBytes: z.number().int().positive().default(ROOM_REPO_CAP_DEFAULTS.maxFileBytes),
    /**
     * How large the whole checkout may grow. A merge that would cross it
     * refuses (`REPO_CAP_EXCEEDED`).
     */
    maxRepoBytes: z.number().int().positive().default(ROOM_REPO_CAP_DEFAULTS.maxRepoBytes),
    /**
     * How much of `ROOM.md` reaches a turn. Over-cap, the conventions block is
     * replaced by a one-line notice naming the overage — never truncated
     * silently, because half a rule reads as a whole one.
     */
    maxRoomMdBytes: z.number().int().positive().default(ROOM_REPO_CAP_DEFAULTS.maxRoomMdBytes),
  })
  .default(() => ({ ...ROOM_REPO_CAP_DEFAULTS }));

/** The caps a room repo carries. See {@link RoomRepoCapsSchema}. */
export type RoomRepoCaps = z.infer<typeof RoomRepoCapsSchema>;

/**
 * `room-repo.json` — the file-first record that a room has a repo.
 *
 * `mode` accepts the whole {@link RoomRepoModeSchema} vocabulary and then
 * refuses everything but `'owned'`, so a `'linked'` sidecar fails with
 * {@link LINKED_REPO_UNSUPPORTED_MESSAGE} rather than a shape error. The
 * refinement narrows the inferred type, so a parsed sidecar is `'owned'` and no
 * consumer has to carry a branch for a mode that cannot reach it.
 */
export const RoomRepoSidecarSchema = z.object({
  /** The room this repo belongs to. */
  roomId: z.string().min(1),
  /**
   * How the repo is bound. Only `'owned'` parses; see
   * {@link RoomRepoModeSchema} for why `'linked'` is in the vocabulary at all.
   */
  mode: RoomRepoModeSchema.refine((mode): mode is 'owned' => mode === 'owned', {
    message: LINKED_REPO_UNSUPPORTED_MESSAGE,
  }),
  /** When the operator enabled the repo. */
  createdAt: z.string().datetime(),
  /**
   * The author id of the operator who enabled it.
   *
   * An author id rather than a name: names are a render cache that a rebuild
   * may refresh, and this is a record of who did something.
   */
  createdBy: z.string().min(1),
  /**
   * The branch that is the room's integration tree. Always `main` — the repo is
   * created by DorkOS with `git init -b main`, and per-agent work lives on
   * `room/<agentSlug>` branches merged into it.
   */
  defaultBranch: z.literal('main'),
  /** The size ceilings this repo was created under. */
  caps: RoomRepoCapsSchema,
  /**
   * The `seq` of the room entry announcing the most recent merge, or `null`
   * when nothing has been merged yet.
   *
   * A pointer into the room's own timeline rather than a commit sha, because
   * what it answers is "where does the file explorer refresh from" — the
   * explorer follows the room stream, and git already knows the commits.
   */
  lastMergeSeq: z.number().int().nonnegative().nullable(),
});

/** A parsed `room-repo.json`. See {@link RoomRepoSidecarSchema}. */
export type RoomRepoSidecar = z.infer<typeof RoomRepoSidecarSchema>;
