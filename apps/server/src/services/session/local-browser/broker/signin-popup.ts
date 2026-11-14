import { randomUUID } from 'node:crypto';
import type { Frame, Page } from 'playwright-core';
import type { TabAuditEvent } from './types.js';

/** A handoff child is never registered with the broker or given any lease. */
export class HeldSignInPopup {
  private page?: Page;
  private consumed = false;
  private closing?: Promise<void>;
  private timeout?: ReturnType<typeof setTimeout>;
  private unwatch = () => undefined;
  constructor(
    readonly openerId: string,
    private readonly ownerId: string,
    private readonly audit: (row: TabAuditEvent) => void,
    private readonly now: () => number
  ) {}

  accept(page: Page): void {
    if (this.consumed) {
      void page.close().catch(() => undefined);
      return;
    }
    this.consumed = true;
    this.page = page;
    this.timeout = setTimeout(() => {
      void this.close().catch(() => undefined);
    }, 10 * 60_000);
    this.timeout.unref?.();
    const pageId = randomUUID();
    let origin: string | undefined;
    const readOrigin = (url: string) => {
      try {
        const parsed = new URL(url);
        if (/^https?:$/.test(parsed.protocol)) origin = parsed.origin;
      } catch {
        /* Blank pages have no origin. */
      }
    };
    readOrigin(page.url());
    const emit = (kind: TabAuditEvent['kind']) =>
      this.audit({
        kind,
        at: this.now(),
        pageId,
        ownerId: this.ownerId,
        agentId: null,
        held: true,
        ...(origin ? { origin } : {}),
      });
    emit('popup_open');
    const navigate = (frame: Frame) => {
      readOrigin(frame.url());
      emit('origin');
    };
    const nested = (popup: Page) => {
      void popup.close().catch(() => undefined);
    };
    const close = () => {
      clearTimeout(this.timeout);
      this.unwatch();
      this.page = undefined;
      emit('popup_close');
    };
    this.unwatch = () => {
      page.off('framenavigated', navigate);
      page.off('popup', nested);
      page.off('close', close);
    };
    page.on('framenavigated', navigate);
    page.on('popup', nested);
    page.on('close', close);
  }
  /** Only a person-facing Show action calls this; creation and polling never focus it. */
  async show(): Promise<boolean> {
    if (!this.page || this.page.isClosed()) return false;
    await this.page.bringToFront();
    return true;
  }
  async close(): Promise<void> {
    this.consumed = true;
    if (!this.closing && this.page && !this.page.isClosed()) this.closing = this.page.close();
    await this.closing;
  }
}
