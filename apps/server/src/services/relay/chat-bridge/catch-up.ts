/**
 * The catch-up scan (chats-as-channels spec §6.1): the AUTHORITY for outbound
 * delivery, as against the inline fast path which is only an optimization.
 *
 * `publishEntry` → `RoomBroadcaster` drops events for absent subscribers, so a
 * bridge that drove delivery off the live stream would silently lose every entry
 * committed while its adapter was down. This scan instead walks the durable log:
 * for a bridged room it lists entries above `lastDeliveredSeq` that carry no
 * external ref, in `seq` order, and hands each to {@link ChatBridgeDelivery.deliverEntry},
 * which applies the full eligibility test — INCLUDING criterion 2's notice
 * clause, so a `turn_failed` committed while the adapter was down catches up too
 * (scoping the scan to `kind: 'post'` would strand exactly the one notice a
 * bridged DM exists to deliver).
 *
 * **Three triggers** (spec §6.1). The spec names them but the codebase has no
 * single "adapter reconnected" / "failure resolved" event, so they are wired to
 * what exists:
 *
 * 1. **start** — {@link BridgeCatchUp.scanAll}, run once when delivery comes up;
 * 2. **adapter reconnect** — {@link BridgeCatchUp.scanAdapter}, wired to
 *    `AdapterManager`'s `connected` lifecycle (a reconnect ends in a fresh
 *    `connected` emit); and
 * 3. **a delivery failure resolves** — {@link BridgeCatchUp.scanRoom}, wired as
 *    {@link ChatBridgeDelivery.setRecoveryHook}, so a send that recovers from a
 *    transient failure flushes whatever queued behind it.
 *
 * Exactly-once is the ref table's job (spec §6.3), not the scan's: an entry the
 * inline path already delivered carries an `outbound` ref and never appears in
 * {@link BridgeStore.listUndeliveredAboveSeq}, and `deliverEntry` no-ops on any
 * entry that already has a ref. The `lastDeliveredSeq` cursor is a bound on the
 * walk, not the correctness mechanism — it only advances past entries this scan
 * has SETTLED (delivered, blocked, or permanently skipped), and never past one a
 * transient failure left undelivered, so the next reconnect re-attempts it.
 *
 * @module server/services/relay/chat-bridge/catch-up
 */
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { logger } from '../../../lib/logger.js';
import type { Bridge, BridgeStore } from './bridge-store.js';
import type { DeliverEntryReader, DeliverOutcome } from './deliver.js';

/** The one thing {@link BridgeCatchUp} needs from the delivery engine. */
export interface CatchUpDelivery {
  /**
   * Deliver one entry, serialized per chat and idempotent on the entry —
   * {@link ChatBridgeDelivery.deliverEntry}.
   *
   * @param entry - The candidate entry.
   * @param bridge - The room's bridge row, already resolved by the scan.
   */
  deliverEntry(entry: RoomEntry, bridge: Bridge): Promise<DeliverOutcome>;
}

/** Everything {@link BridgeCatchUp} is constructed from. */
export interface BridgeCatchUpDeps {
  /** The bridge identity and external-ref store (spec §3.1, §6.1). */
  bridges: BridgeStore;
  /** Hydrate a candidate id into a full entry — {@link RoomStore.getEntryById}. */
  entries: DeliverEntryReader;
  /** The delivery engine each candidate is handed to. */
  delivery: CatchUpDelivery;
}

/**
 * An outcome that STOPS the scan of a room: a transient failure must not let the
 * cursor advance past the undelivered entry (the next reconnect re-attempts it),
 * a terminal failure archived the room, and a vanished bridge has nothing left
 * to scan.
 */
const STOP_OUTCOMES: ReadonlySet<DeliverOutcome> = new Set<DeliverOutcome>([
  'undelivered',
  'terminal',
  'no_bridge',
]);

/**
 * The catch-up scan. Holds no state of its own; every call reads the current
 * bridge rows and log, so two scans never disagree about a snapshot one captured.
 */
export class BridgeCatchUp {
  private readonly deps: BridgeCatchUpDeps;

  constructor(deps: BridgeCatchUpDeps) {
    this.deps = deps;
  }

  /**
   * Scan every live bridge — the start trigger (spec §6.1). Rooms are scanned
   * sequentially; one room's failure never stops the next, because each
   * {@link BridgeCatchUp.scanRoom} is independent and swallows its own errors.
   */
  async scanAll(): Promise<void> {
    for (const bridge of this.deps.bridges.listLiveBridges()) {
      await this.scanRoom(bridge.roomId);
    }
  }

  /**
   * Scan every live bridge on one adapter — the reconnect trigger (spec §6.1).
   *
   * @param adapterId - The adapter that just reconnected.
   */
  async scanAdapter(adapterId: string): Promise<void> {
    for (const bridge of this.deps.bridges.listLiveBridgesByAdapter(adapterId)) {
      await this.scanRoom(bridge.roomId);
    }
  }

  /**
   * Scan one bridged room: deliver every undelivered, eligible entry above the
   * cursor in `seq` order, then advance the cursor to the highest `seq` this pass
   * SETTLED — stopping (and leaving the cursor) at the first entry a transient or
   * terminal failure could not clear, so the next trigger re-attempts from there.
   *
   * @param roomId - The bridged room to scan.
   */
  async scanRoom(roomId: string): Promise<void> {
    const bridge = this.deps.bridges.findBridgeByRoom(roomId);
    if (!bridge || bridge.archivedAt !== null) return;

    const candidates = this.deps.bridges.listUndeliveredAboveSeq(roomId, bridge.lastDeliveredSeq);
    let settled = bridge.lastDeliveredSeq;

    for (const candidate of candidates) {
      const entry = this.deps.entries.getEntryById(roomId, candidate.id);
      if (!entry) {
        // The candidate list is a snapshot; an entry it named could be gone by
        // the time we read it (it cannot, on an append-only log, but the reader
        // is defensive). Advancing past a phantom is safe — there is nothing to
        // deliver — so settle it and move on.
        settled = candidate.seq;
        continue;
      }
      let outcome: DeliverOutcome;
      try {
        outcome = await this.deps.delivery.deliverEntry(entry, bridge);
      } catch (err) {
        // A delivery that threw is not a settled entry — leave the cursor where
        // it is so the next trigger retries this entry, and stop the walk so a
        // later entry never delivers ahead of an earlier one still owed.
        logger.warn('[chat-bridge] catch-up delivery threw; stopping this room', {
          roomId,
          entryId: entry.id,
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }
      // A transient/terminal/vanished outcome stops the walk WITHOUT advancing
      // past this entry: the ref was rolled back (undelivered) or the room was
      // archived (terminal), and either way the cursor must not skip it.
      if (STOP_OUTCOMES.has(outcome)) break;
      // Everything else — delivered, blocked, echo, noop, skipped, damped,
      // refused_author — is settled: it will not become deliverable on a later
      // pass, so the cursor may move past it. `damped` belongs on this side and
      // not with the stoppers: a repeat of a state the chat already heard never
      // becomes news again (DOR-1359), so parking the cursor on it would stall
      // the room and strand every entry behind it.
      settled = candidate.seq;
    }

    if (settled > bridge.lastDeliveredSeq) {
      // Monotonic in the store, so a stale scan racing a faster one cannot move
      // the cursor backward (spec §6.1).
      this.deps.bridges.setLastDeliveredSeq(roomId, settled);
    }
  }
}
