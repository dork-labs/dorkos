import type { FileChooser } from 'playwright-core';
import type { BrowserViewerChooser } from '@dorkos/shared/browser-viewer-control';
import { ViewerChooserTickets } from '../../../browser-viewers/chooser-tickets.js';
import type { BrowserBrokerSource } from '../broker-source.js';
import { LocalBrowserError } from '../../errors.js';
import type { BrowserPersonFile } from '../broker-contract.js';

/** Captured chooser handles never escape the broker's person-held controller. */
export class BrowserPersonFiles {
  private readonly tickets = new ViewerChooserTickets();
  private readonly listeners = new Set<(ticket: BrowserViewerChooser) => void>();
  private pending?: {
    ticket: BrowserViewerChooser;
    chooser: FileChooser;
    timer: ReturnType<typeof setTimeout>;
  };
  private listening = false;
  private disposed = false;
  private failure?: Error;
  private offChange?: () => void;
  constructor(
    private readonly source: BrowserBrokerSource,
    private readonly admit: () => void,
    private readonly controllerId: string
  ) {}
  private facts() {
    this.admit();
    return {
      ...this.source.facts(),
      controllerId: this.controllerId,
      host: new URL(this.source.page.url()).host,
    };
  }
  admittedInput(): void {
    this.tickets.admittedInput(this.facts());
  }
  listen(listener: (ticket: BrowserViewerChooser) => void): () => void {
    this.admit();
    if (this.disposed) throw Error('viewer_denied');
    this.listeners.add(listener);
    if (!this.listening) {
      this.listening = true;
      this.source.page.on('filechooser', this.open);
      this.offChange = this.source.onChange(() => {
        try {
          this.admit();
        } catch {
          void this.dispose().catch(() => undefined);
        }
      });
    }
    return () => {
      this.listeners.delete(listener);
    };
  }
  private readonly open = (chooser: FileChooser): void => {
    try {
      const facts = this.facts();
      if (this.disposed || this.pending) throw Error('viewer_denied');
      const ticket = this.tickets.open({ ...facts, multiple: chooser.isMultiple() });
      const timer = setTimeout(() => void this.cancel(ticket.id).catch(() => undefined), 60_000);
      timer.unref?.();
      this.pending = { ticket, chooser, timer };
      for (const listener of this.listeners) listener(ticket);
    } catch {
      void this.source.work.track(chooser.setFiles([])).catch(() => {
        this.failure = new LocalBrowserError(
          'file_picker_stuck',
          'The file picker got stuck. Close this page in Chrome to hand back.'
        );
      });
    }
  };
  async choose(
    id: string,
    files: readonly BrowserPersonFile[],
    assertOperation?: () => void
  ): Promise<void> {
    const pending = this.pending;
    try {
      assertOperation?.();
      this.tickets.consume(
        id,
        this.facts(),
        files.map((f) => ({ name: f.name, bytes: f.buffer }))
      );
      if (
        !pending ||
        pending.ticket.id !== id ||
        files.some(
          (f) =>
            Object.keys(f).some((key) => !['name', 'mimeType', 'buffer'].includes(key)) ||
            !Buffer.isBuffer(f.buffer) ||
            typeof f.mimeType !== 'string' ||
            f.mimeType.length > 128
        )
      )
        throw Error('viewer_denied');
      this.pending = undefined;
      clearTimeout(pending.timer);
      await this.source.authorize();
      this.admit();
      assertOperation?.();
      await this.source.work.track(
        pending.chooser.setFiles(
          files.map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer }))
        )
      );
      this.admit();
      assertOperation?.();
    } catch (error) {
      if (pending) {
        if (this.pending === pending) await this.cancel(pending.ticket.id);
        else await this.clearChooser(pending.chooser);
      }
      throw error;
    } finally {
      for (const file of files) file.buffer.fill(0);
    }
  }
  async cancel(id: string): Promise<void> {
    this.tickets.cancel(id);
    const pending = this.pending;
    if (!pending || pending.ticket.id !== id) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    await this.clearChooser(pending.chooser);
  }
  private async clearChooser(chooser: FileChooser): Promise<void> {
    try {
      await this.source.work.track(chooser.setFiles([]));
    } catch {
      // A closed captured Page has no chooser left to cancel; live failures still hold custody.
      if (this.source.page.isClosed()) return;
      this.failure = new LocalBrowserError(
        'file_picker_stuck',
        'The file picker got stuck. Close this page in Chrome to hand back.'
      );
      throw this.failure;
    }
  }
  async dispose(): Promise<void> {
    if (this.disposed) {
      if (this.failure && !this.source.page.isClosed()) throw this.failure;
      return;
    }
    this.disposed = true;
    // Removing the last Playwright listener disables its chooser interception.
    this.source.page.off('filechooser', this.open);
    this.offChange?.();
    this.listeners.clear();
    this.tickets.clear();
    if (this.pending) await this.cancel(this.pending.ticket.id);
    if (this.failure && !this.source.page.isClosed()) throw this.failure;
  }
}
