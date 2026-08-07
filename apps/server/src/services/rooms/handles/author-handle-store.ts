/**
 * Who owns which handle, and who used to (spec `handles` §3, §8).
 *
 * One table pair — `authors.handle` for live addresses, `handle_tombstones` for
 * released ones — read through ONE predicate shape, so neither can drift into
 * case-sensitivity on its own. A claim is refused when `lower(h)` matches a live
 * handle on another author, or when it matches a tombstone belonging to somebody
 * outside the claimant's own lineage.
 *
 * **Nothing here is reachable by an agent.** Handle changes are
 * human-initiated only: there is no MCP tool, no capability, and no
 * agent-reachable route that calls {@link AuthorHandleStore.set}. That is the
 * instrument chosen over rate limiting — an agent that could rename itself in a
 * loop would grow this table a row at a time forever, and removing the
 * mechanism beats throttling it.
 *
 * @module server/services/rooms/handles/author-handle-store
 */
import { and, authors, eq, handleTombstones, isNotNull, ne, sql, type Db } from '@dorkos/db';
import { normalizeHandle, validateHandle } from '@dorkos/shared/handle';
import type { AuthorKind } from '@dorkos/shared/room-schemas';
import { RoomError } from '../room-errors.js';

/**
 * Who is asking for a handle: their row id, and the identity their row is keyed
 * on.
 *
 * The key travels with the id because a claim is weighed against the claimant's
 * **lineage**, not against their row — see
 * {@link AuthorHandleStore.lineageOf}.
 */
export interface HandleClaimant {
  id: string;
  kind: AuthorKind;
  naturalKey: string;
}

/** Reads and writes over `authors.handle` and its tombstones. */
export class AuthorHandleStore {
  constructor(private readonly db: Db) {}

  /**
   * Every handle a claimant may NOT take, lowercased — live handles on other
   * authors, plus tombstones outside their own lineage.
   *
   * **Tombstones are in here, and that is the half that is easy to leave out.**
   * Most handles on an install are minted rather than chosen, so a `taken` set
   * built from live rows alone would let a newly-minted agent derive straight
   * onto a handle some other author released — defeating the tombstone on the
   * path that produces nearly all of them. A mint is a claim that happens not to
   * have a person behind it.
   *
   * @param claimant - Who is asking, or `null` for "nobody in particular",
   *   which is the widest possible answer and the right one when minting a row
   *   that does not exist yet.
   */
  spokenFor(claimant: HandleClaimant | null): Set<string> {
    const lineage = claimant ? this.lineageOf(claimant) : new Set<string>();
    const taken = new Set<string>();
    for (const row of this.db
      .select({ handle: authors.handle, id: authors.id })
      .from(authors)
      .where(isNotNull(authors.handle))
      .all()) {
      if (row.handle && !lineage.has(row.id)) taken.add(row.handle.toLowerCase());
    }
    for (const row of this.db
      .select({ handle: handleTombstones.handle, authorId: handleTombstones.authorId })
      .from(handleTombstones)
      .all()) {
      if (!lineage.has(row.authorId)) taken.add(row.handle.toLowerCase());
    }
    return taken;
  }

  /**
   * Set an author's handle, or clear it when the input is empty.
   *
   * The one write path, so the three refusals are stated once:
   * `INVALID_HANDLE` for a spelling the grammar rejects, `HANDLE_TAKEN` for a
   * handle live on another author, `HANDLE_RESERVED` for one tombstoned outside
   * the claimant's lineage. Three codes rather than one, because they are three
   * different things a person does about it — fix the spelling, pick another,
   * or ask whoever had it. Collapsing them would make the message do work the
   * code should.
   *
   * The old handle is tombstoned to this author on the way out, so it stays
   * theirs to take back and nobody else's to claim.
   *
   * @param claimant - The author being changed.
   * @param raw - What to set it to. Empty or whitespace clears it.
   * @returns The stored handle, or `null` when it was cleared.
   */
  set(claimant: HandleClaimant, raw: string): string | null {
    const wanted = normalizeHandle(raw);
    if (wanted === undefined) {
      this.release(claimant);
      return null;
    }

    const validation = validateHandle(wanted);
    if (!validation.valid) throw new RoomError('INVALID_HANDLE', validation.error!);

    const current = this.currentHandle(claimant.id);
    if (current === wanted) return current;

    this.assertClaimable(wanted, claimant);
    const lineage = this.lineageOf(claimant);
    const releasedAt = new Date().toISOString();

    this.db.transaction((tx) => {
      if (current !== null) {
        tx.insert(handleTombstones)
          .values({ handle: current, authorId: claimant.id, releasedAt })
          .onConflictDoNothing()
          .run();
      }
      // Reclaiming a tombstone deletes the row: the handle is live again, and a
      // tombstone standing beside a live handle would refuse the next person to
      // ask about it for a reason that is no longer true.
      for (const id of lineage) {
        tx.delete(handleTombstones)
          .where(
            and(
              sql`lower(${handleTombstones.handle}) = ${wanted}`,
              eq(handleTombstones.authorId, id)
            )
          )
          .run();
      }
      tx.update(authors).set({ handle: wanted }).where(eq(authors.id, claimant.id)).run();
    });
    return wanted;
  }

  /**
   * Give up a handle, tombstoning it to its author.
   *
   * A no-op for an author that has none, so a caller does not have to check
   * first.
   *
   * @param claimant - The author giving it up.
   */
  release(claimant: HandleClaimant): void {
    const current = this.currentHandle(claimant.id);
    if (current === null) return;
    const releasedAt = new Date().toISOString();
    this.db.transaction((tx) => {
      tx.insert(handleTombstones)
        .values({ handle: current, authorId: claimant.id, releasedAt })
        .onConflictDoNothing()
        .run();
      tx.update(authors).set({ handle: null }).where(eq(authors.id, claimant.id)).run();
    });
  }

  /**
   * Write a tombstone for a handle nobody holds — the seeded broadcast
   * reservations (`everyone`, `here`, `channel`).
   *
   * Idempotent, and the same table and the same index as a released handle, so
   * the refusal that protects them is the one that already exists rather than a
   * list something has to consult.
   *
   * @param handle - The word to reserve, normalized.
   * @param authorId - Who holds the reservation — the system author.
   */
  reserve(handle: string, authorId: string): void {
    this.db
      .insert(handleTombstones)
      .values({ handle, authorId, releasedAt: new Date().toISOString() })
      .onConflictDoNothing()
      .run();
  }

  /** The handle an author holds right now, or `null`. */
  private currentHandle(authorId: string): string | null {
    return (
      this.db.select({ handle: authors.handle }).from(authors).where(eq(authors.id, authorId)).get()
        ?.handle ?? null
    );
  }

  /**
   * Refuse a claim that would take somebody else's address, live or released.
   *
   * @param wanted - The normalized handle being claimed.
   * @param claimant - Who is claiming it.
   */
  private assertClaimable(wanted: string, claimant: HandleClaimant): void {
    const live = this.db
      .select({ id: authors.id })
      .from(authors)
      .where(and(sql`lower(${authors.handle}) = ${wanted}`, ne(authors.id, claimant.id)))
      .get();
    if (live) {
      throw new RoomError('HANDLE_TAKEN', `@${wanted} is already somebody else's handle.`);
    }

    const lineage = this.lineageOf(claimant);
    const tombstoned = this.db
      .select({ authorId: handleTombstones.authorId })
      .from(handleTombstones)
      .where(sql`lower(${handleTombstones.handle}) = ${wanted}`)
      .all();
    if (tombstoned.some((row) => !lineage.has(row.authorId))) {
      throw new RoomError(
        'HANDLE_RESERVED',
        `@${wanted} belonged to somebody else and stays reserved to them.`
      );
    }
  }

  /**
   * Every author row that is the SAME entity as the claimant: their own row,
   * plus every retired row for the same `(kind, natural_key)`.
   *
   * **Why lineage and not just the row id.** A directory that changes hands
   * retires its author and mints a fresh one (ADR 260801-003051), and retiring
   * releases the handle. Weighing a claim against the row id alone would mean
   * re-initializing your own agent in place burns its handle forever, with no
   * reclaim path — the fresh row is a different author id, so it could never
   * take back the name its predecessor held. That is the "infuriating" case the
   * tombstone's `author_id` exists to answer, and the honest reading of the
   * answer is that the same directory under the same operator is the same
   * lineage. It stays narrow: nothing outside that one `(kind, natural_key)`
   * can reach a tombstone, which is the whole protection.
   *
   * @param claimant - Who is claiming.
   */
  private lineageOf(claimant: HandleClaimant): Set<string> {
    const rows = this.db
      .select({ id: authors.id })
      .from(authors)
      .where(and(eq(authors.kind, claimant.kind), eq(authors.naturalKey, claimant.naturalKey)))
      .all();
    return new Set([claimant.id, ...rows.map((row) => row.id)]);
  }
}
