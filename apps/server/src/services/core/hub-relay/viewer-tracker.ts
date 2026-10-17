/**
 * How many of the owner's pages have one of a computer's chats open on this
 * hub (B1, DOR-2944), so the computer knows to keep its relay open.
 *
 * A computer closes its relay a few minutes after it hears "no viewers"
 * (`SESSION_RELAY_IDLE_CLOSE_MS`), which lets the hub sleep. So the count is
 * told to the computer's live connection whenever it changes, and again the
 * moment a connection proves itself: a new connection starts at zero, and
 * without that it would close on a page that is still open.
 *
 * @module services/core/hub-relay/viewer-tracker
 */
import type { HubComputerConnection } from './computer-connection.js';

/** The part of a connection the tracker tells. */
export type ViewerCountTarget = Pick<HubComputerConnection, 'setViewers'>;

/** What the tracker reads, injectable for tests. */
export interface HubViewerTrackerDeps {
  /** The computer's live connection, or `null` when it is not connected. */
  lookup: (computerId: string) => ViewerCountTarget | null;
}

/** Counts open chat streams per computer and tells each computer its count. */
export class HubViewerTracker {
  private readonly counts = new Map<string, number>();

  /**
   * Start with no viewers anywhere.
   *
   * @param deps - Where to find a computer's live connection.
   */
  constructor(private readonly deps: HubViewerTrackerDeps) {}

  /**
   * Note one more open stream for a computer.
   *
   * @param computerId - The computer whose chat was opened.
   * @returns Close it again. Calling it twice counts once.
   */
  open(computerId: string): () => void {
    this.change(computerId, 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.change(computerId, -1);
    };
  }

  /**
   * How many streams a computer has open on this hub.
   *
   * @param computerId - The computer to count.
   */
  count(computerId: string): number {
    return this.counts.get(computerId) ?? 0;
  }

  /**
   * Tell a connection that just proved itself how many viewers it has.
   *
   * @param connection - The newly live connection.
   */
  connected(connection: ViewerCountTarget & { computerId: string }): void {
    connection.setViewers(this.count(connection.computerId));
  }

  private change(computerId: string, by: 1 | -1): void {
    const next = Math.max(0, this.count(computerId) + by);
    if (next === 0) this.counts.delete(computerId);
    else this.counts.set(computerId, next);
    this.deps.lookup(computerId)?.setViewers(next);
  }
}
