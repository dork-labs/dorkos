import type { CDPSession, Frame, Page } from 'playwright-core';
import { LocalBrowserError } from './errors.js';

const ACTION_FOCUS_TIMEOUT_MS = 750;
const SELECTION_FOCUS_TIMEOUT_MS = 5_000;
const FOCUS_CLEANUP_TIMEOUT_MS = 750;

/** Temporary focus emulation for one explicitly shared existing-browser page. */
export class ExistingPageFocus {
  private released = false;
  private session?: CDPSession;
  private tail: Promise<void>;
  private cleanup?: Promise<void>;
  private readonly navigation = (frame: Frame) => {
    if (frame !== this.page.mainFrame() || this.released) return;
    this.tail = this.tail.then(() => this.reset());
    // Protocol failures are reported to the next operation that waits for readiness.
    void this.tail.catch(() => undefined);
  };
  private readonly close = () => {
    void this.release();
  };

  constructor(
    private readonly page: Page,
    previousRelease?: Promise<void>
  ) {
    this.tail = previousRelease ? previousRelease.then(() => this.attach()) : this.attach();
    void this.tail.catch(() => undefined);
    page.on('framenavigated', this.navigation);
    page.on('close', this.close);
  }

  /** Wait for attachment and every navigation reset already queued for this page. */
  async ready(): Promise<void> {
    let pending: Promise<void>;
    do {
      pending = this.tail;
      await pending;
    } while (pending !== this.tail);
  }

  /** Fence late attachment synchronously, then restore and detach without closing the tab. */
  release(): Promise<void> {
    if (this.cleanup) return this.cleanup;
    this.released = true;
    this.page.off('framenavigated', this.navigation);
    this.page.off('close', this.close);
    this.cleanup = this.tail
      .catch(() => undefined)
      .then(async () => {
        if (!this.session) return;
        await this.session
          .send('Emulation.setFocusEmulationEnabled', { enabled: false })
          .catch(() => undefined);
        await this.session.detach().catch(() => undefined);
      });
    return this.cleanup;
  }

  private async attach(): Promise<void> {
    if (this.released) return;
    this.session = await this.page.context().newCDPSession(this.page);
    await this.reset();
  }

  private async reset(): Promise<void> {
    if (this.released || !this.session) return;
    // Chromium can retain a stale hidden renderer after navigation. Reset before enabling.
    await this.session.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    if (!this.released)
      await this.session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  }
}

/** Human-owned selection; observing an old page can never acquire focus for it. */
export class ExistingPageFocusSelection {
  private current?: ExistingPageFocus;
  private failure?: LocalBrowserError;

  /** Replace the selected page immediately, fencing any older asynchronous attachment. */
  async select(page?: Page): Promise<void> {
    this.failure = undefined;
    const previousRelease = this.current?.release();
    const current = page ? new ExistingPageFocus(page, previousRelease) : undefined;
    this.current = current;
    if (current) await this.wait(current, SELECTION_FOCUS_TIMEOUT_MS);
  }

  /** Wait for the current selection without creating or changing one. */
  async ready(): Promise<void> {
    if (this.failure) throw this.failure;
    const current = this.current;
    if (current) await this.wait(current, ACTION_FOCUS_TIMEOUT_MS);
  }

  private async wait(current: ExistingPageFocus, timeout: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        current.ready(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const failure = new LocalBrowserError(
              'focus_unavailable',
              'This tab stopped responding. Choose it again.'
            );
            if (this.current === current) this.failure = failure;
            void current.release();
            reject(failure);
          }, timeout);
        }),
      ]);
    } catch (error) {
      const failure =
        error instanceof LocalBrowserError
          ? error
          : new LocalBrowserError(
              'focus_unavailable',
              'This tab stopped responding. Choose it again.'
            );
      if (this.current === current) this.failure = failure;
      void current.release();
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Release the selection synchronously before waiting for protocol cleanup. */
  release(): Promise<void> {
    this.failure = undefined;
    const current = this.current;
    this.current = undefined;
    return current ? this.settleCleanup(current.release()) : Promise.resolve();
  }

  private async settleCleanup(cleanup: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        cleanup,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, FOCUS_CLEANUP_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
