/**
 * How a person moves the Agent browser's page: an address they typed, and Back
 * and Forward through the page's own history (DOR-4449). Kept beside the browser
 * service rather than in it.
 */
import type { Page } from 'playwright-core';
import type {
  LocalBrowserHistoryDirection,
  LocalBrowserMode,
  LocalBrowserState,
} from '@dorkos/shared/local-browser';
import type { EmbeddedBrowserAttachment } from '../connection/embedded-attachment.js';
import { LocalBrowserError, historyAddressAllowed, navigationRefusal } from '../errors.js';
import {
  cdpPageHistory,
  embeddedPageHistory,
  historyAvailability,
  stepPageHistory,
  type PageHistoryPort,
} from './page-history.js';

/** What a person's page moves need from the browser service, read fresh on every call. */
export interface PersonPageMovesHost {
  mode(): LocalBrowserMode | null;
  attachment(): EmbeddedBrowserAttachment | undefined;
  appOrigins(): readonly string[];
  /** Whether an agent's action it already started is still running. */
  agentActing(): boolean;
}

/** Moves the selected tab for a person, through whichever browser is open. */
export class PersonPageMoves {
  private readonly cdp = cdpPageHistory();
  private readonly embedded: PageHistoryPort;
  private stepping = false;

  constructor(private readonly host: PersonPageMovesHost) {
    this.embedded = embeddedPageHistory(() => {
      const attachment = host.attachment();
      if (!attachment)
        throw new LocalBrowserError('closed', 'The browser closed. Connect it again.');
      return attachment.history();
    }, host.appOrigins);
  }

  /**
   * Open an address the person typed, already checked by the address rules.
   *
   * @param page - The selected tab.
   * @param url - Where to go.
   */
  async open(page: Page, url: string): Promise<void> {
    try {
      await page.goto(url, { waitUntil: 'commit', timeout: 15_000 });
    } catch (error) {
      throw navigationRefusal(error);
    }
  }

  /** The address rule every step, load and landing must pass. */
  private readonly allowed = (url: string): boolean =>
    historyAddressAllowed(url, this.host.appOrigins());

  private port(): PageHistoryPort {
    return this.host.mode() === 'embedded' ? this.embedded : this.cdp;
  }

  /**
   * The state with whether Back and Forward have a page to go to, on the selected tab.
   *
   * @param state - The browser's state.
   * @param page - The selected tab, when there is one to read.
   */
  async describe(state: LocalBrowserState, page: Page | undefined): Promise<LocalBrowserState> {
    if (!page || page.isClosed()) return state;
    const history = await historyAvailability(page, this.port(), this.allowed);
    const tabs = state.tabs.map((tab) =>
      tab.id === state.selectedTabId ? { ...tab, ...history } : tab
    );
    return { ...state, tabs };
  }

  /**
   * One step back or forward, one at a time. `takeOver` runs first, so a driving
   * agent is fenced out before the page moves; an action it already started is
   * left to finish, and the step is refused as busy until it has.
   *
   * @param page - The selected tab.
   * @param direction - Back or Forward.
   * @param takeOver - Pauses a driving agent.
   */
  async step(
    page: Page,
    direction: LocalBrowserHistoryDirection,
    takeOver: () => unknown
  ): Promise<void> {
    if (this.stepping) throw new LocalBrowserError('busy', 'Browser is busy. Wait a moment.');
    this.stepping = true;
    try {
      await takeOver();
      // Paused now, but an action it already started could move the page mid-step.
      if (this.host.agentActing())
        throw new LocalBrowserError('busy', 'Browser is busy. Wait a moment.');
      await stepPageHistory(page, this.port(), direction, this.allowed);
    } finally {
      this.stepping = false;
    }
  }
}
