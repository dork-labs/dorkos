import type { Page } from 'playwright-core';
import type { LocalBrowserHistoryDirection, LocalBrowserState } from '@dorkos/shared/local-browser';
import { assertLocalBrowserUrl } from '../errors.js';
import type { PersonPageMoves } from '../history/person-page-moves.js';
import type { BrowserLeaseJournal } from './lease-journal.js';
import type { BrowserPageCustody } from './page-custody.js';

interface PersonControlHost {
  journal: BrowserLeaseJournal;
  custody: BrowserPageCustody;
  moves: PersonPageMoves;
  assertAvailable(): void;
  invalidate(): void;
  revision(): number;
  stale(): Error;
  setPaused(paused: boolean): void;
  driving(): boolean;
  page(): Page;
  state(): Promise<LocalBrowserState>;
  detach(): Promise<void>;
  reattach(): Promise<void>;
}

/** Person controls use the same Page custody barrier as the viewer broker. */
export class BrowserPersonPageControl {
  constructor(private readonly host: PersonControlHost) {}

  async navigate(url: string, options?: { httpFallback?: boolean }): Promise<LocalBrowserState> {
    const h = this.host;
    assertLocalBrowserUrl(url, 'person');
    h.invalidate();
    const revision = h.revision();
    const page = h.page();
    if (revision !== h.revision()) throw h.stale();
    await h.moves.open(page, url, options);
    return h.state();
  }

  async stepHistory(direction: LocalBrowserHistoryDirection): Promise<LocalBrowserState> {
    const h = this.host;
    const driving = h.driving();
    await h.moves.step(h.page(), direction, () => driving && this.pause());
    return h.state();
  }

  /** Stop admission before persistence; already-dispatched work retains its physical slot. */
  async pause(): Promise<LocalBrowserState> {
    const h = this.host;
    h.setPaused(true);
    h.invalidate();
    await h.journal.record({ event: 'paused', actor: 'person' });
    return h.state();
  }

  async handToPerson(): Promise<LocalBrowserState> {
    const h = this.host;
    h.setPaused(true);
    await h.custody.hold();
    await h.journal.record({ event: 'held', actor: 'person' });
    await h.detach();
    return h.state();
  }

  async resume(): Promise<LocalBrowserState> {
    const h = this.host;
    h.assertAvailable();
    await h.reattach();
    const held = h.custody.held;
    if (held) await h.custody.release();
    await h.journal.record({ event: held ? 'handed-back' : 'resumed', actor: 'person' });
    h.setPaused(false);
    h.invalidate();
    return h.state();
  }
}
