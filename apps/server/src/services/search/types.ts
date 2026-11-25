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
 * The message and file shapes a file-backed source shares with the Codex
 * runtime live in the kernel (`services/core/codex-rollouts/rollout-types.ts`)
 * and are re-exported here, so the index keeps one place to import its shapes.
 *
 * @module server/services/search/types
 */
import type { Db } from '@dorkos/db';
import type {
  FileDiscovery,
  KnownContainer,
  Projection,
} from '../core/codex-rollouts/rollout-types.js';

export type {
  DiscoveryFailure,
  FileContainer,
  FileDiscovery,
  KnownContainer,
  ProjectedMessage,
  Projection,
  SkipReason,
  SkippedFile,
} from '../core/codex-rollouts/rollout-types.js';

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

  /**
   * Read this container from ordinal 1 again, even though it has not shrunk.
   *
   * For a source that only ever APPENDS, this is always absent: the watermark is
   * a complete description of what has been read, and re-reading is waste. It
   * exists for a source whose rows are **mutated in place**, where the ordinal
   * high-water mark is a true statement about how many rows there are and says
   * nothing about whether the ones already indexed still say what they said.
   *
   * OpenCode is that source: it creates a message row at turn start and streams
   * its parts in underneath it for up to a minute, rewriting them as tokens
   * arrive (`opencode-store.ts`). A sweep landing mid-stream indexes a truncated
   * body, and without this flag the count would never change again and the
   * truncation would be served forever.
   *
   * **It takes the rebuild path — rows deleted first, then rewritten** — and an
   * earlier version that merely moved the resume position was wrong. A message
   * that projects to NOTHING writes no row, so it cannot overwrite what sits at
   * its ordinal; a container that lands on the same count with different content
   * would keep serving the old row at that position forever. The delete is what
   * makes "read it again" mean the whole container rather than the rows that
   * happen to produce output.
   *
   * The cost is therefore a delete-and-rewrite per flagged container per sweep,
   * which is why setting it has to be scoped: OpenCode raises it only for
   * conversations touched inside a 15-minute window, never for settled ones.
   */
  rereadWhole?: boolean;
}

/**
 * Whose history a source reads — the DorkOS data directory, or another
 * program's store on the same machine (DOR-1551).
 *
 * `'dorkos'` means the corpus lives inside the `DORK_HOME` this process owns,
 * so it exists only because DorkOS wrote it. `'external'` means the corpus is
 * resolved from the operator's home directory instead — `~/.claude/projects`,
 * `$CODEX_HOME`, OpenCode's store — and is therefore the same corpus no matter
 * which `DORK_HOME` the server was pointed at.
 *
 * **That difference is the whole reason this field exists.** Pointing a server
 * at a throwaway data directory isolates everything DorkOS owns and nothing
 * else: the browser suite gave each Express leg its own `/tmp` home (DOR-1223),
 * and the index went on full-text-copying ~9,250 of the operator's real Claude
 * Code messages into it on every run. {@link SearchSource} carries the answer so
 * a run that must not read anybody's history can drop those sources by property
 * rather than by name.
 *
 * **Required rather than optional, and that is the point.** An optional field
 * defaults to "not external", so a fifth source added years from now would leak
 * silently and go on leaking until somebody re-measured. Required means the
 * compiler asks the question at the moment the row is written.
 */
export type SourceCorpus = 'dorkos' | 'external';

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

  /** Whose history this reads — see {@link SourceCorpus}. */
  readonly corpus: SourceCorpus;

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

  /** Whose history this reads — see {@link SourceCorpus}. */
  readonly corpus: SourceCorpus;

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

  /** Whose history this reads — see {@link SourceCorpus}. */
  readonly corpus: SourceCorpus;

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
   * A per-container failure writes `search_sources.last_error` on that
   * container's own row. A failure that belongs to no container — a discovery
   * that rejected, one root of several that could not be read, a container list
   * that would not read, a snapshot that would not open — is stamped across
   * every row the source ALREADY has, which is what makes it visible to somebody
   * searching (`sourceWarnings` reads that column and nothing else).
   *
   * **Two kinds still live here only**, which is why this array is on the result
   * rather than being left implicit in the table:
   *
   * 1. A failure on a source with no indexed containers yet. There is no row to
   *    stamp, and inventing one is banned: `search_sources` is keyed by
   *    container, so a row for `(discovery)` is a row discovery can never return
   *    and the prune would delete on the first healthy sweep.
   * 2. Two or more files claiming one container id. No row could honestly
   *    describe them: it would have to name one file's size, mtime and offset
   *    while the fault is that there are two.
   *
   * A per-root failure is also not the same as "this source produced nothing":
   * the readable roots indexed normally. The stamp lands on every row of the
   * source that does not already carry a container's own error, healthy roots
   * included, and it is written after the pass rather than before it — a file
   * that indexes clears its own `last_error`, so a stamp made first would
   * survive only on whichever containers happened not to change, and whether a
   * person is warned would depend on who was talking. Being over-broad is the
   * right side to err on: the warning names a source and never a container, and
   * the corpus really is incomplete.
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
