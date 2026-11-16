import type { Browser } from 'playwright-core';
import type { EmbeddedBrowserPort } from '../desktop-bridge.js';
import type { LocalBrowserBackend } from '../playwright-backend.js';
import { LocalBrowserError } from '../errors.js';
import type { EmbeddedHistoryBridge } from '../history/page-history.js';

/** The guest stays visible while its debugger and the old Playwright connection go away. */
export class EmbeddedBrowserAttachment {
  private detached = false;
  private browser?: Browser;
  constructor(
    private readonly guest: Awaited<ReturnType<EmbeddedBrowserPort['open']>>,
    private readonly backend: LocalBrowserBackend,
    private readonly closed: () => void
  ) {}

  /** A fresh page-only CDP connection, including after a handoff. */
  async connect(): Promise<Browser> {
    const browser = await this.backend.connect(this.guest.endpoint, this.guest.headers);
    this.browser = browser;
    browser.on('disconnected', () => {
      if (this.browser === browser && !this.detached) this.closed();
    });
    return browser;
  }

  /** The host's own history calls (DOR-4449). A Mac app too old to have them says so. */
  history(): EmbeddedHistoryBridge {
    const { history, goToHistory } = this.guest;
    if (!history || !goToHistory)
      throw new LocalBrowserError(
        'connect_failed',
        'Update the desktop app to use Back and Forward.'
      );
    return { history, goToHistory };
  }

  /** The authenticated host acknowledges only after debugger.detach() has returned. */
  async detach(): Promise<void> {
    this.detached = true;
    if (!this.guest.detach)
      throw new LocalBrowserError(
        'connect_failed',
        'Update the desktop app before handing over its browser.'
      );
    await this.guest.detach();
    // Host closure already ends the connection. Browser.close() on a CDP
    // attachment disconnects its client; it does not close the native view.
    await this.browser?.close();
    this.browser = undefined;
  }

  /** Only a person can reopen the bridge; failures leave the view detached. */
  async resume(): Promise<Browser> {
    if (!this.guest.reattach)
      throw new LocalBrowserError(
        'connect_failed',
        'Update the desktop app before handing back its browser.'
      );
    await this.guest.reattach();
    try {
      const browser = await this.connect();
      this.detached = false;
      return browser;
    } catch (error) {
      await this.guest.detach?.();
      throw error;
    }
  }
}
