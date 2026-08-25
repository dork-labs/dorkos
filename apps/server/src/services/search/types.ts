/**
 * The shapes the message-search index is built out of (message-search spec §3
 * and §4, ADR 260728-214214).
 *
 * Three of them, and the split between them is the design: a **projection** is
 * pure and knows one source's format, a **container** is the unit the frontier
 * remembers, and a **source** is a record in the registry array rather than a
 * class. A port abstracting two mechanisms and three functions would be a class
 * hierarchy standing where a record does (spec §3, D12).
 *
 * @module server/services/search/types
 */
import type { Db } from '@dorkos/db';

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
 * One container of a row-backed source, as discovery returns it.
 *
 * `maxOrdinal` is the change signal, and it rides along with discovery on
 * purpose: M2's discovery ("the container list") and its change detection
 * ("`max(seq)` above the frontier") are one `GROUP BY` rather than one query
 * per container per sweep.
 */
export interface RowContainer {
  /** The opaque container id, same composition as {@link ProjectedMessage.originKey}. */
  originKey: string;

  /**
   * The working directory a hit opens in, or `null` when the source has none.
   * A room is not a directory, so the room source always sets `null`.
   */
  containerPath: string | null;

  /** The container's highest ordinal right now. `0` when it holds nothing. */
  maxOrdinal: number;
}

/**
 * **M2** — a source whose containers are rows above a monotonic watermark
 * (spec §3). The room log uses it, and any future DorkOS-owned table would.
 *
 * Two functions, because change detection folds into discovery. Both take the
 * database rather than closing over one, so a source is a plain value that a
 * test can point at any database it likes.
 */
export interface RowSource {
  /** `'rooms'`. Stamped onto every row this source contributes. */
  readonly id: string;

  /**
   * Which mechanism sweeps this source. The registry row names it rather than
   * the indexer guessing from the shape of the record (spec §3).
   */
  readonly mechanism: 'rows';

  /** Every container that exists right now, with its current high-water ordinal. */
  listContainers(db: Db): RowContainer[];

  /**
   * The container's rows strictly above `afterOrdinal`, already projected and
   * ordered by ordinal.
   *
   * @param db - The database to read.
   * @param originKey - Which container.
   * @param afterOrdinal - Read rows above this. `0` reads the whole container.
   */
  readSince(db: Db, originKey: string, afterOrdinal: number): Projection;
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

/** Why discovery walked past a file instead of indexing it. */
export type SkipReason =
  /** `<slug>/<sessionId>/subagents/**` — a conversation the human never had. */
  | 'subagent-transcript'
  /** A main session whose head-record `cwd` is an eval-harness sandbox. */
  | 'eval-sandbox'
  /** `<slug>/vercel-plugin/skill-injections.jsonl` — harness plumbing. */
  | 'plugin-artifact'
  /** Nested deeper than `<slug>/<sessionId>.jsonl` and matching no known kind. */
  | 'not-a-main-session';

/** One file discovery decided against, and the decision it made. */
export interface SkippedFile {
  /** Absolute path to the file that was not indexed. */
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
 * reports having visited the nested paths. A count-only assertion passes for
 * both.
 *
 * {@link FileDiscovery.failures} is the same argument applied to whole roots.
 */
export interface FileDiscovery {
  /** Files to index, across every root, in walk order. */
  files: FileContainer[];

  /** Files visited and deliberately not indexed. */
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

/**
 * **M1** — a source whose containers are append-only files tailed at a byte
 * offset (spec §3). Claude Code uses it, and Codex will.
 *
 * Discovery reaches the filesystem; the projection never does. That split is
 * what keeps the projection a pure function over lines, and it is why this
 * interface has no `read`: reading is the mechanism's, written once in
 * `jsonl-frontier.ts`.
 */
export interface FileSource {
  /** `'claude-code'`. Stamped onto every row this source contributes. */
  readonly id: string;

  /**
   * Which mechanism sweeps this source. The registry row names it rather than
   * the indexer guessing from the shape of the record (spec §3).
   */
  readonly mechanism: 'jsonl';

  /**
   * Every file that should be indexed right now, across every root this source
   * reads, and every one that should not.
   *
   * **Resolves rather than rejects when one root fails.** A source spanning
   * several roots that threw on the first unreadable one would contribute zero
   * rows from the roots that ARE readable — the opposite of the per-root
   * degradation G3 asks for. Unreachable roots come back in
   * {@link FileDiscovery.failures}; a rejection is reserved for a discovery that
   * enumerated nothing at all.
   *
   * @param known - What the frontier already holds, keyed by container id. A
   *   file whose `(size, mtime)` match an entry here has not changed since the
   *   last sweep, so discovery may answer from it rather than re-reading the
   *   file to classify it.
   */
  discover(known: ReadonlyMap<string, KnownContainer>): Promise<FileDiscovery>;

  /**
   * Project raw JSONL lines into messages. **Pure** — no filesystem, no
   * database, no clock.
   *
   * Called once per batch of lines rather than once per file, so a large first
   * read never holds a whole transcript's raw text in memory. Ordinals are
   * therefore handed in rather than started from zero.
   *
   * @param lines - Complete lines, in file order, blank lines already dropped.
   * @param context - Which container these belong to, and the ordinal to give
   *   the first message produced.
   */
  project(
    lines: readonly string[],
    context: { originKey: string; firstOrdinal: number }
  ): Projection;
}

/**
 * Where a watermark pass gets its containers.
 *
 * The one thing M2 and M3 do differently, isolated. M2's containers are rows in
 * DorkOS's own database; M3's are rows in a read-only copy of somebody else's.
 * Everything after that — the resume rule, the shrink rebuild, the watermark
 * write, the prune — is identical, which is why `row-frontier.ts` has one
 * implementation of it and not two.
 */
export interface ContainerReader {
  /** Every container that exists right now, with its current high-water ordinal. */
  listContainers(): RowContainer[];

  /**
   * The container's rows strictly above `afterOrdinal`, already projected and
   * ordered by ordinal.
   *
   * @param originKey - Which container.
   * @param afterOrdinal - Read rows above this. `0` reads the whole container.
   */
  readSince(originKey: string, afterOrdinal: number): Projection;
}

/**
 * **M3** — a source whose containers live in another program's SQLite file,
 * read through a throwaway snapshot copy (ADR 260825-110420).
 *
 * OpenCode uses it, and it is the third mechanism the design said would promote
 * this shape to a port. **The promotion was refused, with evidence rather than
 * taste**: M3 reuses M2's entire frontier implementation through
 * {@link ContainerReader} and contributes one function of its own. The ADR
 * carries the re-trigger condition.
 *
 * The snapshot has a lifetime, which is the only structural difference from a
 * row source: {@link SnapshotSource.open} produces a reader that must be closed,
 * and closing deletes the copy. That is why this is `open()` rather than two
 * standalone functions — a `listContainers` that opened its own snapshot and a
 * `readSince` that opened another would copy the store once per container.
 */
export interface SnapshotSource {
  /** `'opencode'`. Stamped onto every row this source contributes. */
  readonly id: string;

  /**
   * Which mechanism sweeps this source. The registry row names it rather than
   * the indexer guessing from the shape of the record (spec §3).
   */
  readonly mechanism: 'sqlite-snapshot';

  /**
   * Copy the store, open the copy read-only, and hand back a reader.
   *
   * @returns A reader the caller must `close()`, or `null` when there is no
   *   store to read — the runtime may never have run on this machine, which is
   *   not a failure. The distinction is load-bearing: `null` means the sweep
   *   prunes nothing, because "no store" is not "every session was deleted".
   */
  open(): Promise<(ContainerReader & { close(): void }) | null>;
}

/**
 * One source the indexer sweeps — a record in the registry array, never a port.
 *
 * A port abstracting three mechanisms and four functions is still a class
 * hierarchy standing where a record does. The design named the day a third
 * mechanism arrived as the trigger that would change that (spec §3, D12); the
 * day came with OpenCode, and ADR 260825-110420 refused the promotion and
 * recorded the next trigger — a FOURTH mechanism, or a source that lives outside
 * `apps/server`.
 */
export type SearchSource = RowSource | FileSource | SnapshotSource;

/** What one pass over one source did, whichever mechanism swept it. */
export interface SourceSweep {
  /** Which source. */
  sourceId: string;

  /** Containers that exist right now. */
  containers: number;

  /**
   * Message rows written this pass.
   *
   * The number a no-op sweep has to report as `0`. Asserting an unchanged
   * `count(*)` instead would pass for a sweep that correctly did nothing AND for
   * a broken one that re-read and re-upserted every row.
   */
  indexed: number;

  /**
   * Rows the projection read, recognised as its own, and could not make a
   * message out of.
   *
   * The quiet half of the format-change problem. A projection that THROWS is
   * loud — it writes `last_error` and stops the container. A projection handed a
   * record whose shape has drifted underneath it does not throw; it returns fewer
   * rows, which is indistinguishable from a source with nothing to say. This is
   * the count that tells the two apart, and it is deliberately not an error: one
   * drifted row must not stop a whole container from indexing.
   */
  skipped: number;

  /** Containers that no longer exist and were dropped from the index. */
  pruned: number;

  /**
   * Containers re-read whole because the index no longer matches them —
   * renumbered ordinals under M2, a file that shrank under M1.
   */
  rebuilt: number;

  /**
   * Everything that should have been indexed and was not, and why.
   *
   * Most entries also wrote `search_sources.last_error`. **Three kinds cannot**,
   * and they live here only — which is why this array is on the result rather
   * than being left implicit in the table:
   *
   * 1. A discovery that failed before any container was enumerated. There is no
   *    row to write to.
   * 2. Two or more files claiming one container id. No row could honestly
   *    describe them: it would have to name one file's size, mtime and offset
   *    while the fault is that there are two.
   * 3. **One root of several that could not be read.** A root is not a
   *    container, so it has no row either — and unlike the first two, the source
   *    still CONTRIBUTED: the readable roots indexed normally. A failure here is
   *    therefore not the same as "this source produced nothing".
   */
  failures: SourceFailure[];
}

/**
 * One container whose indexing failed, and why.
 *
 * This is what `search_sources.last_error` exists to make visible: a projection
 * an upstream format change has quietly broken produces no rows, and a source
 * with nothing new also produces no rows. Without a recorded failure the two
 * are indistinguishable — the sharpest negative recorded in ADR 260728-214214.
 */
export interface SourceFailure {
  /** Which source. */
  sourceId: string;

  /**
   * Which container within it, or the source's discovery-failure key when the
   * failure happened before any container was enumerated.
   */
  originKey: string;

  /**
   * What went wrong. Usually the text written to `search_sources.last_error`
   * as well — but not always, since some failures have no single row to own
   * them (see {@link SourceSweep.failures}).
   */
  message: string;
}
