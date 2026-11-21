import { LocalBrowserError } from '../errors.js';
import { PAGE_READ_RESPONSE_TIMEOUT_MS, responseDeadline } from '../lifecycle.js';

/** One authoritative custody epoch for native controls, agent tools and viewer input. */
export class BrowserPageCustody {
  held = false;
  epoch = 0;
  private transition?: Promise<void>;
  private readonly resets = new Set<() => Promise<void>>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly invalidate: () => void,
    private readonly drain: () => Promise<void>
  ) {}

  /** A controller releases only the input it dispatched to this exact Page. */
  onReset(reset: () => Promise<void>): () => void {
    this.resets.add(reset);
    return () => this.resets.delete(reset);
  }
  /** Custody changes revoke controller admission synchronously. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Admission closes synchronously, before any physical work is awaited. */
  block(): void {
    this.held = true;
    this.epoch++;
    this.invalidate();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Observer failures cannot reopen custody admission. */
      }
    }
  }

  /** Only after the old Page's physical close acknowledged and a new Page was acquired. */
  beginPage(): void {
    this.block();
    this.transition = undefined;
    this.resets.clear();
    this.held = false;
  }

  /** Every takeover shares the same physical drain and held-input cleanup. */
  async hold(): Promise<void> {
    await this.change(false);
  }

  /** Only explicit person hand-back calls this; a failure leaves agents blocked. */
  async release(): Promise<void> {
    await this.change(true);
  }

  /** Renew one held controller through the same drain/reset barrier without granting agents. */
  async resetHeld(epoch: number): Promise<void> {
    if (!this.held || this.epoch !== epoch) throw busy();
    await this.change(false, epoch);
  }

  private async change(release: boolean, retainedEpoch?: number): Promise<void> {
    if (this.transition) throw busy();
    if (retainedEpoch === undefined) this.block();
    else if (!this.held || this.epoch !== retainedEpoch) throw busy();
    const epoch = this.epoch;
    const transition = Promise.resolve().then(async () => {
      await this.drain();
      await Promise.all([...this.resets].map((reset) => reset()));
      await this.drain();
    });
    this.transition = transition;
    let expired = false;
    void transition
      .finally(() => {
        if (this.transition === transition) this.transition = undefined;
      })
      .catch(() => undefined);
    await responseDeadline(transition, PAGE_READ_RESPONSE_TIMEOUT_MS, () => {
      expired = true;
      return busy();
    });
    if (this.epoch !== epoch) throw busy();
    if (release && !expired) this.held = false;
  }
}

function busy(): LocalBrowserError {
  return new LocalBrowserError('busy', 'The page is still finishing. Try taking it again.');
}
