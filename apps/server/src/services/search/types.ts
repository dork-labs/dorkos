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

  /** Which container within it. */
  originKey: string;

  /** What went wrong, as it was written to `search_sources.last_error`. */
  message: string;
}
