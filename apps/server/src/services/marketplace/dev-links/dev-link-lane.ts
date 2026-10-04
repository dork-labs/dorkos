/**
 * A lane of follow-up work the dev link watcher asks for after an edit (a
 * project's projection, the global plugin refresh): at most one run at a time
 * and one more owed, however many are asked for meanwhile. A projection can
 * wait hours on a hook card, and a plugin refresh round-trips every live
 * session, so neither may pile up or overlap.
 *
 * @module services/marketplace/dev-links/dev-link-lane
 */
import { logger } from '../../../lib/logger.js';

/** What a {@link DevLinkLane} runs. */
export interface DevLinkLaneOptions {
  /** The work. A rejection is logged, never thrown. */
  job: () => Promise<void>;
  /** Checked before every run, the first included; `false` ends the lane. */
  mayRun: () => boolean;
  /** Log line for a failed run. */
  failure: string;
  /** Called each time the lane goes idle. */
  onIdle?: () => void;
}

/** One lane: at most one run in flight and one more owed. */
export class DevLinkLane {
  /** The run in progress, if any. */
  inFlight?: Promise<void>;
  private again = false;

  /**
   * Build an idle lane.
   *
   * @param opts - See {@link DevLinkLaneOptions}.
   */
  constructor(private readonly opts: DevLinkLaneOptions) {}

  /** Run now when idle, otherwise owe one more run after the current one. */
  request(): void {
    if (this.inFlight) {
      this.again = true;
      return;
    }
    // Started on the next tick, never inside the caller: the lane is marked
    // busy before any of it runs, and `mayRun` is read as late as possible.
    this.inFlight = Promise.resolve().then(async () => {
      try {
        do {
          this.again = false;
          if (!this.opts.mayRun()) break;
          try {
            await this.opts.job();
          } catch (err) {
            logger.warn(`[Marketplace] ${this.opts.failure}`, { err });
          }
        } while (this.again);
      } finally {
        this.inFlight = undefined;
        this.again = false;
        this.opts.onIdle?.();
      }
    });
  }
}
