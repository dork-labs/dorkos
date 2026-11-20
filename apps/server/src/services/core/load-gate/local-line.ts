/**
 * The load gate's fallback when the shared folder cannot be used (DOR-4209):
 * a line kept in this server's memory, so a full disk or a broken folder does
 * not let every waiting job through at once. One heavy job at a time per server
 * process, first come first served. It never refuses; the gate still applies
 * the load limit and the hard cap around it.
 *
 * @module services/core/load-gate/local-line
 */

/** A place in the in-memory line. */
export type LocalPlace = symbol;

/** One server process's own first-come line, one job running at a time. */
export class LocalLine {
  private readonly waiting: LocalPlace[] = [];
  private runningJobs = 0;

  /** Join the back of the line. */
  join(): LocalPlace {
    const place: LocalPlace = Symbol('local-load-gate-place');
    this.waiting.push(place);
    return place;
  }

  /**
   * A place in line, counting from 1, or 0 once it has left.
   *
   * @param place - The place to find.
   */
  position(place: LocalPlace): number {
    return this.waiting.indexOf(place) + 1;
  }

  /**
   * Start the job at the head of the line, when nothing else is running and the
   * machine is quiet enough.
   *
   * @param place - The caller's place.
   * @param quietEnough - Whether the load is under the limit.
   * @returns Whether it started.
   */
  tryStart(place: LocalPlace, quietEnough: boolean): boolean {
    if (this.waiting[0] !== place || this.runningJobs > 0 || !quietEnough) return false;
    this.waiting.shift();
    this.runningJobs += 1;
    return true;
  }

  /**
   * Start the job regardless: it reached the hard cap.
   *
   * @param place - The caller's place.
   */
  forceStart(place: LocalPlace): void {
    this.leave(place);
    this.runningJobs += 1;
  }

  /**
   * Leave the line without starting. Does nothing for a place already gone.
   *
   * @param place - The caller's place.
   */
  leave(place: LocalPlace): void {
    const index = this.waiting.indexOf(place);
    if (index !== -1) this.waiting.splice(index, 1);
  }

  /** A started job finished. */
  finish(): void {
    this.runningJobs = Math.max(0, this.runningJobs - 1);
  }
}
