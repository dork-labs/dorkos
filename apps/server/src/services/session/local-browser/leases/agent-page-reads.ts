import type { Page } from 'playwright-core';
import type { LocalBrowserState } from '@dorkos/shared/local-browser';
import type { BrowserPageState } from './page-state.js';
import type { BrowserLeaseJournal } from './lease-journal.js';
import { LocalBrowserError } from '../errors.js';

interface AgentReadDeps {
  state: BrowserPageState;
  journal(): BrowserLeaseJournal;
  admit(): void;
  sync(): void;
  selected(): Page;
  refuse(page: Page): void;
  describe(): LocalBrowserState;
}

/** Capture page and revision synchronously; persistence waits cannot change that selection. */
export class BrowserAgentPageReads {
  constructor(private readonly deps: AgentReadDeps) {}
  async state(): Promise<LocalBrowserState> {
    const d = this.deps;
    d.admit();
    d.sync();
    const selected = d.state.tabs.get(d.state.selectedTabId ?? '');
    if (selected && !selected.isClosed()) d.refuse(selected);
    const state = d.describe();
    await d.journal().ready();
    return state;
  }
  async observe() {
    const page = this.page();
    const revision = this.deps.state.revision;
    if (!this.deps.journal().isReady) await this.deps.journal().ready();
    this.revision(revision);
    return this.deps.state.observe(page, () => this.refuse(page));
  }
  async screenshot() {
    const page = this.page();
    const revision = this.deps.state.revision;
    if (!this.deps.journal().isReady) await this.deps.journal().ready();
    this.revision(revision);
    return this.deps.state.screenshot(page, () => this.refuse(page));
  }
  private page(): Page {
    this.deps.admit();
    const page = this.deps.selected();
    this.refuse(page);
    return page;
  }
  private refuse(page: Page): void {
    this.deps.admit();
    this.deps.refuse(page);
  }
  private revision(revision: number): void {
    if (revision !== this.deps.state.revision)
      throw new LocalBrowserError('stale_page', 'The page changed. Read it again before acting.');
  }
}
