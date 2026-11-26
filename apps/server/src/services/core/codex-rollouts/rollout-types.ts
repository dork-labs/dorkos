/**
 * The shapes a file-backed message source reads into (message-search spec §3
 * and §5, ADR 260728-214214): one message as a projection returns it, one
 * append-only file as discovery finds it, and what discovery decided against.
 *
 * Kernel: the search index (space side) sweeps these files, and the Codex
 * runtime (computer side) lists and reads its own rollouts through the same
 * discovery and projection, so the shapes sit where both may import them. The
 * search index's own shapes (sources, row containers, readers) stay in
 * `services/search/types.ts`, which re-exports these.
 *
 * @module services/core/codex-rollouts/rollout-types
 */

/**
 * One thing someone said, as a projection returns it.
 *
 * It deliberately carries no `sourceId`: the sweep stamps that from the
 * registry row, so a projection cannot get its own source's name wrong and a
 * projection is testable without one.
 *
 * `originKey` is **composed by the projection and never parsed by the index**
 * (spec §4). The room projection sets it to `roomId` today and to
 * `` `${communityRef}:${roomId}` `` once community scoping lands, with no
 * schema change, no query change and no migration.
 */
export interface ProjectedMessage {
  /** Opaque container id. Composed here; never split anywhere else. */
  originKey: string;

  /** Monotonic position within the container. `room_entries.seq` for a room. */
  ordinal: number;

  /**
   * The message's own id in the store that owns it, or `null` when that store
   * gives it none (DOR-1579).
   *
   * **Read, never invented.** A projection copies whatever id the record on
   * disk carries — a JSONL `uuid`, a Codex `response_item`'s `item.id`, an
   * OpenCode `message.id` — and answers `null` for a record with none. Minting
   * one here would produce a different id on every read of the same message, so
   * it would address nothing while looking exactly like an id that works.
   *
   * It is for LANDING and nothing else: the row's identity stays
   * `(source, container, ordinal)`.
   */
  messageId: string | null;

  /** Who said it. */
  role: 'user' | 'assistant';

  /** ISO-8601, or `null` for a source that records no timestamp. */
  createdAt: string | null;

  /** The searchable text. */
  body: string;
}

/**
 * What one projection pass produced, and what it could not use.
 *
 * The second number is why this is a record rather than a bare array. A
 * projection that THROWS is loud — the sweep records it and stops that
 * container. A projection handed a record whose shape has drifted underneath it
 * does not throw; it returns fewer rows, and fewer rows is exactly what a source
 * with nothing to say returns. `skipped` is the difference between the two, and
 * it is the ADR's sharpest recorded negative made countable.
 */
export interface Projection {
  /** The messages, in ordinal order. */
  messages: ProjectedMessage[];

  /**
   * Rows the projection recognised as its own and could not make a message out
   * of. Never an error: one drifted row must not stop a container.
   */
  skipped: number;
}

/**
 * One append-only file discovery found, with the two signals that say whether
 * it has changed since the last sweep (spec §5).
 *
 * `sizeBytes` and `mtimeMs` are the whole change-signal taxonomy this design
 * carries: a file grew, or a file appeared. Everything else is a rebuild.
 */
export interface FileContainer {
  /** The opaque container id — the session id, for a transcript. */
  originKey: string;

  /** Absolute path to the file. */
  filePath: string;

  /**
   * The working directory a hit opens in, or `null` when the file never named
   * one. Read from the file's own head record, never from its directory name:
   * the slug is a lossy `cwd.replace(/[^a-zA-Z0-9-]/g, '-')` and cannot be
   * inverted (spec §2.1).
   */
  containerPath: string | null;

  /** Size right now. Below the recorded size means the file was replaced. */
  sizeBytes: number;

  /** Modification time right now, in epoch milliseconds. */
  mtimeMs: number;
}

/**
 * Why discovery walked past a file instead of indexing it.
 *
 * One union across every file-backed source rather than one per source: the
 * reasons are read together — logged, counted, eyeballed in a bench run — and a
 * per-source union would make "everything that was skipped" a type-level join
 * for no gain. Each member names which source can produce it.
 */
export type SkipReason =
  /** Claude Code: `<slug>/<sessionId>/subagents/**` — a conversation the human never had. */
  | 'subagent-transcript'
  /** Claude Code: a main session whose head-record `cwd` is an eval-harness sandbox. */
  | 'eval-sandbox'
  /** Claude Code: `<slug>/vercel-plugin/skill-injections.jsonl` — harness plumbing. */
  | 'plugin-artifact'
  /** Claude Code: nested deeper than `<slug>/<sessionId>.jsonl` and matching no known kind. */
  | 'not-a-main-session'
  /**
   * Codex: a `.jsonl` under a rollout root whose name is not
   * `rollout-<ISO>-<sessionId>.jsonl`, so it carries no session id to index it
   * under.
   *
   * No such file exists on any corpus measured — `$CODEX_HOME` does hold other
   * newline-delimited files, `session_index.jsonl` among them, but they sit
   * beside the rollout roots rather than inside one and are never walked. This
   * is here so a kind of file nobody has seen yet shows up in the skipped set
   * instead of in the index under an id invented from its filename.
   */
  | 'not-a-rollout';

/** One file discovery decided against, and the decision it made. */
export interface SkippedFile {
  /**
   * Absolute path to the file that was not indexed, or to a whole directory
   * decided against without listing it (a Claude Code `subagents/` folder).
   */
  path: string;

  /** The decision. */
  reason: SkipReason;
}

/**
 * One root a discovery pass could not enumerate.
 *
 * A file-backed source reads SEVERAL roots — Claude Code has one per account on
 * this machine, Codex has one per day plus its archive — and the whole point of
 * reading several is that a person's history is spread across them. So one
 * unreadable root must be reported rather than either failing the source or
 * quietly narrowing the corpus, which is the same "a short list looks exactly
 * like a complete one" failure the feature exists to refuse (spec Amendment 2,
 * G3).
 *
 * A root that simply is not there is NOT a failure and never appears here:
 * Claude Code may never have run under that account.
 */
export interface DiscoveryFailure {
  /** The root that could not be read, absolute, as an operator would recognise it. */
  root: string;

  /** Why it could not be read. */
  message: string;
}

/**
 * What one discovery pass found — and, just as load-bearing, what it decided
 * against and what it could not reach.
 *
 * The skipped set is not diagnostics. Discovery **walks** the tree rather than
 * globbing one level down, so that subagent transcripts are excluded by a
 * predicate someone can flip rather than by an accident of depth (spec §2.1) —
 * and the only way to tell those two implementations apart is that one of them
 * reports the decision. A count-only assertion passes for both. A Claude Code
 * `subagents/` folder is decided against whole, without listing it, and
 * reported once as the folder (DOR-2904).
 *
 * {@link FileDiscovery.failures} is the same argument applied to whole roots.
 */
export interface FileDiscovery {
  /** Files to index, across every root, in walk order. */
  files: FileContainer[];

  /** Files, or whole folders, reached and deliberately not indexed. */
  skipped: SkippedFile[];

  /**
   * Roots that exist and could not be enumerated.
   *
   * Non-empty means `files` is INCOMPLETE, which is why the sweep stops pruning
   * on it: a container missing because its root was unreadable is not a
   * container that is gone.
   */
  failures: DiscoveryFailure[];
}

/**
 * What the frontier already knows about one file, as discovery needs it.
 *
 * Handed to discovery so an unchanged file can be classified from what the last
 * sweep decided instead of from its bytes. Reading the head of every transcript
 * on every tick is the difference between a sweep that costs one `stat` per file
 * and one that costs ~11 MB of reads per five minutes on this corpus, growing
 * with it.
 */
export interface KnownContainer {
  /**
   * Size at the last read.
   *
   * Accepted limitation of the `(sizeBytes, mtimeMs)` pair, stated once: a
   * replacement that lands on the SAME size and the SAME mtime is
   * indistinguishable from no change at all, and is treated as unchanged. It
   * takes a rewrite inside one millisecond that preserves the byte count
   * exactly; the answer if it ever happens is `DELETE FROM messages` and a
   * rebuild, which is a supported recovery rather than a repair.
   */
  sizeBytes: number;

  /** Mtime at the last read, in epoch milliseconds. */
  mtimeMs: number;

  /** The working directory the last sweep recorded for it. */
  containerPath: string | null;
}
