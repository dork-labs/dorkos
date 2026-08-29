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

/**
 * One agent's branch in a room's repo, as `room_repo_status` and
 * `GET /api/rooms/:id/repo/status` report it (spec `project-rooms` §3.6).
 *
 * **Here rather than beside the service that computes it**, because two ends
 * read it: an agent through the capability, and the file explorer through the
 * route, where it draws the pending-work badges (§3.9). One declaration is what
 * keeps the badge and the tool describing the same fact.
 *
 * It names SLUGS and display names, never the directory an agent lives in.
 */
export const RoomBranchStatusSchema = z.object({
  /** The working copy's directory name, and the tail of the branch name. */
  slug: z.string().describe('The working copy’s directory name, and the tail of the branch.'),
  /** The branch itself. */
  branch: z.string(),
  /** The agent's display name, sanitized. */
  agent: z.string().describe('The agent’s display name, sanitized.'),
  /**
   * The author id of the agent whose branch this is.
   *
   * An id rather than a path: it is the same id the room's roster and its
   * entries carry, so a client can join this row to a member without learning
   * where that agent lives on disk.
   */
  authorId: z
    .string()
    .describe(
      'The agent whose branch this is, by the same author id the roster and the room’s entries carry — so a client can join this row to a member without learning where that agent lives on disk.'
    ),
  /** Whether this row is the caller's own. */
  mine: z.boolean().describe('Whether this row is the caller’s own branch.'),
  /** Whether the agent has a working copy on disk right now. */
  hasWorktree: z.boolean().describe('Whether the working copy is on disk right now.'),
  /** Commits on the branch that `main` does not have. */
  ahead: z.number().int().nonnegative().describe('Commits the branch holds that `main` does not.'),
  /** Commits on `main` that the branch does not have. */
  behind: z.number().int().nonnegative().describe('Commits `main` holds that the branch does not.'),
  /** Whether the working copy holds changes nobody committed. */
  dirty: z.boolean().describe('Whether the working copy has changes nobody committed.'),
  /**
   * Whether this branch holds work `main` has not got — `dirty || ahead > 0`.
   *
   * The same DEFINITION `RoomRepoService.listStrandedWorktrees` uses, restated
   * per branch so a reader does not have to derive it. It is deliberately not
   * the same COMPUTATION: that one walks the worktree directories and this one
   * walks the roster, so the two can disagree in the cases where those disagree
   * — a worktree whose agent has left the room, a branch whose working copy the
   * reap removed, or a directory git cannot read (which the other one calls
   * stranded and this one cannot see at all).
   * {@link RoomRepoStatusSchema}'s `strandedWorktrees` carries that other answer
   * alongside, precisely so the two are visible rather than reconciled behind a
   * reader's back.
   */
  stranded: z
    .boolean()
    .describe('Work `main` has not got — `dirty || ahead > 0`. Drives the explorer’s badge.'),
});

/** One agent's branch in a room's repo. See {@link RoomBranchStatusSchema}. */
export type RoomBranchStatus = z.infer<typeof RoomBranchStatusSchema>;

/**
 * One uncommitted change in a room's own copy of its files (spec §3.10).
 *
 * A room's integration tree has exactly one writer and it is the server, so
 * anything uncommitted in it came from OUTSIDE DorkOS — a person with a
 * terminal, almost always. These records are what the room shows them, and what
 * a repair names when it throws one away.
 */
export const RoomStrayChangeSchema = z.object({
  /** The path, relative to the room's own copy. */
  path: z.string().describe('The file that is different, relative to the room’s own copy.'),
  /**
   * What happened to it, in a word.
   *
   * Coarser than git's own vocabulary on purpose: the question being asked is
   * whether to keep this or throw it away, and "staged for deletion but
   * modified in the tree" is not a distinction that changes that answer.
   */
  kind: z
    .enum(['added', 'modified', 'deleted', 'untracked'])
    .describe('What happened to it: added, modified, deleted, or never tracked at all.'),
  /**
   * Where the file was before somebody renamed it, when that is what happened.
   *
   * A rename is one change with TWO paths, and both are needed to undo it: the
   * new name appears and the old one vanishes, so a discard that knew only the
   * new one would delete the file from the room and leave the old name still
   * missing. The old path is never listed as a change of its own — it is not
   * there to discard — but it rides along here.
   */
  renamedFrom: z
    .string()
    .optional()
    .describe('Where the file was before it was renamed, when that is what happened.'),
});

/** One uncommitted change in a room's own copy. See {@link RoomStrayChangeSchema}. */
export type RoomStrayChange = z.infer<typeof RoomStrayChangeSchema>;

/**
 * How many stray changes one status answer carries — the "fifty" the schemas
 * above and below describe in prose.
 *
 * Here rather than in the server, because both ends depend on it: the server
 * slices its list to this, and a reader that trusted a longer list would draw
 * rows it will never be sent while one that trusted a shorter one would hide
 * changes it was given. `strayCount` still answers how many there really are.
 */
export const MAX_REPORTED_ROOM_STRAYS = 50;

/**
 * What the room's own copy looks like on disk — the dirty-main warning
 * (spec §3.10).
 *
 * Reported rather than only refused: while anything here is uncommitted, every
 * merge and every save in the room answers `MAIN_CHECKOUT_DIRTY`, and a refusal
 * a person cannot act on is a dead end. This is what the room shows them, and
 * what the two operator actions — keep these, or discard exactly these — are
 * chosen from.
 */
export const RoomMainStatusSchema = z.object({
  /** The branch the room's copy is on, or `null` for a detached head. */
  branch: z.string().nullable().describe('The branch the room’s own copy is on.'),
  /**
   * Whether merges and saves are paused right now.
   *
   * True for either fault — stray changes, or a branch that is not `main` — for
   * the same reason both answer one refusal code: what a person does about it
   * is to go and look.
   */
  dirty: z
    .boolean()
    .describe(
      'Whether merges and saves are paused because something outside DorkOS wrote in the room’s own copy.'
    ),
  /**
   * The uncommitted changes, capped at fifty.
   *
   * Capped because the honest answer to "somebody unpacked a build directory in
   * here" is a number and a sample, not fifty thousand rows through an API.
   */
  strays: z
    .array(RoomStrayChangeSchema)
    .describe('The uncommitted changes, up to fifty of them. See `strayCount` for the total.'),
  /** How many there are in total, which may be more than `strays` holds. */
  strayCount: z
    .number()
    .int()
    .nonnegative()
    .describe('How many uncommitted changes there are in total.'),
});

/** What the room's own copy looks like on disk. See {@link RoomMainStatusSchema}. */
export type RoomMainStatus = z.infer<typeof RoomMainStatusSchema>;

/** What `room_repo_status` and `GET /api/rooms/:id/repo/status` answer. */
export const RoomRepoStatusSchema = z.object({
  /** The commit `main` points at. */
  mainCommit: z.string(),
  /** When that commit was made, ISO, or `null` for a repo with no commits. */
  mainCommittedAt: z.string().nullable(),
  /**
   * What the room's own copy holds on disk right now — the dirty-main warning.
   *
   * Beside the commit rather than folded into it, because the two answer
   * different questions: `mainCommit` is what the room has agreed on, and this
   * is whether anything is standing in the way of adding to it.
   */
  main: RoomMainStatusSchema,
  /** One row per agent member, in roster order. */
  branches: z.array(RoomBranchStatusSchema),
  /**
   * Working copies holding work `main` has not got, by directory name.
   *
   * Includes trees no current member maps to — an agent that was renamed, or
   * whose workspace moved, leaves its old worktree behind and the work in it is
   * still somebody's.
   */
  strandedWorktrees: z
    .array(z.string())
    .describe(
      'Working copies holding work `main` has not got, including ones no current member maps to.'
    ),
  /** What the room's files weigh, and what they are allowed to. */
  size: z.object({
    /** Total bytes of every file on `main`. */
    usedBytes: z.number().int().nonnegative(),
    /** The ceiling for the whole repo, from the sidecar. */
    maxRepoBytes: z.number().int().nonnegative(),
    /** The ceiling for one file, from the sidecar. */
    maxFileBytes: z.number().int().nonnegative(),
  }),
});

/** What a room's files hold right now. See {@link RoomRepoStatusSchema}. */
export type RoomRepoStatus = z.infer<typeof RoomRepoStatusSchema>;

/**
 * `POST /api/rooms/{id}/repo/main/repair` — what to do about changes in a
 * room's own copy that DorkOS did not make (spec `project-rooms` §3.10).
 *
 * A room's integration tree has one writer, and it is the server. Anything
 * uncommitted in it therefore came from outside DorkOS — a person with a
 * terminal — and until it is dealt with, every merge and every save in that
 * room refuses. This is how it gets dealt with.
 *
 * **`commit` takes no list and `discard` demands one**, and the asymmetry is
 * the safety rule: keeping changes loses nothing, so it sweeps up whatever is
 * there; throwing them away is the one irreversible act on this surface, so it
 * destroys nothing it was not handed by name — and every name has to be a path
 * the room is reporting as changed right now, so a stale screen cannot delete
 * something that arrived after it was drawn.
 */
export const RoomMainRepairRequestSchema = z.discriminatedUnion('action', [
  z.object({
    /** Keep every uncommitted change, as one commit authored by you. */
    action: z.literal('commit'),
  }),
  z.object({
    /** Throw away exactly the files named below. */
    action: z.literal('discard'),
    /**
     * The files to discard, spelled exactly as `repo/status` reports them.
     *
     * At least one — "discard nothing" is not an action — and capped, because
     * a tree somebody unpacked an archive into can report tens of thousands of
     * changes and a request naming all of them is a mistake, not a decision.
     */
    paths: z.array(z.string().min(1)).min(1).max(500),
  }),
]);

/** What a repair asks for. See {@link RoomMainRepairRequestSchema}. */
export type RoomMainRepairRequest = z.infer<typeof RoomMainRepairRequestSchema>;

/**
 * What a repair did.
 *
 * `clean` is the part a screen has to read, and it is not the same question as
 * "did this work": discarding some of the stray changes and not others is a
 * legitimate thing to do, and it leaves the room paused. The answer says so
 * rather than letting a caller assume saving has resumed.
 */
export const RoomMainRepairResultSchema = z.object({
  /** Which action ran. */
  action: z.enum(['commit', 'discard']),
  /** The commit that kept the changes, or `null` for a discard. */
  commit: z.string().nullable(),
  /** How many paths it dealt with. */
  paths: z.number().int().nonnegative(),
  /** Whether the room's files are clean — and saving unpaused — now. */
  clean: z.boolean(),
});

/** What a repair did. See {@link RoomMainRepairResultSchema}. */
export type RoomMainRepairResult = z.infer<typeof RoomMainRepairResultSchema>;
