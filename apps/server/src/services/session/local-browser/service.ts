/** A local, visible browser. Personal browsers are attached, never owned or closed. */
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, BrowserContext, Page, JSHandle } from 'playwright-core';
import { localBrowserAuditWriter, type LocalBrowserAuditWriter } from './action-audit.js';
import { LocalBrowserError, assertLocalBrowserUrl } from './errors.js';
import {
  BrowserActionFlight,
  responseDeadline,
  resourceClosure,
  CLOSE_RESPONSE_TIMEOUT_MS,
  PAGE_READ_RESPONSE_TIMEOUT_MS,
  closingError,
} from './lifecycle.js';
import { ExistingPageFocusSelection } from './page-focus.js';
import { performPageAction, auditPageAction } from './page-action.js';
import { observationNodes } from './observation-nodes.js';
import { boundedPageSnapshot, boundedPageScreenshot } from './observation-limits.js';
import { BrowserPreparation } from './preparation.js';
import { LocalBrowserTabMetadata } from './tab-metadata.js';
import { localBrowserCapabilities } from './presentation.js';
import {
  productionBackend,
  assertLocalExistingBrowserVersion,
  type LocalBrowserBackend,
} from './playwright-backend.js';
export { LocalBrowserError } from './errors.js';
import type {
  LocalBrowserAction,
  LocalBrowserCapabilities,
  LocalBrowserMode,
  LocalBrowserObservation,
  LocalBrowserOpen,
  LocalBrowserState,
} from '@dorkos/shared/local-browser';

const ACTION_TIMEOUT_MS = 750;

/** Desktop returns an authenticated connection to one guest page, never its app shell. */
export interface EmbeddedBrowserPort {
  open(
    connectionId: string
  ): Promise<{ endpoint: string; headers: Record<string, string>; close(): Promise<void> }>;
}
/** One selected live tab, with consumed observations and bounded, never-retried actions. */
export class LocalBrowserService {
  private connectionId: string | null = null;
  private sessionId: string | null = null;
  private browserVersion: string | null = null;
  private channel: 'chrome' | 'msedge' | null = null;
  private mode: LocalBrowserMode | null = null;
  private status: LocalBrowserState['status'] = 'disconnected';
  private paused = false;
  private browser?: Browser;
  private ownedContext?: BrowserContext;
  private embeddedClose?: () => Promise<void>;
  private tabs = new Map<string, Page>();
  private selectedTabId: string | null = null;
  private revision = 0;
  private observation?: LocalBrowserObservation;
  private observedNodes?: JSHandle<Set<Element>>;
  private readonly actions = new BrowserActionFlight();
  private acquisition?: Promise<void>;
  private closing?: Promise<void>;
  private closingFailed = false;
  private opening = false;
  private openingAbort?: AbortController;
  private lifecycle = 0;
  private readonly focus = new ExistingPageFocusSelection();
  private readonly preparation = new BrowserPreparation();
  private readonly metadata = new LocalBrowserTabMetadata();

  constructor(
    private readonly dataDirectory: string,
    private readonly embedded?: EmbeddedBrowserPort,
    private readonly backend: LocalBrowserBackend = productionBackend,
    private readonly audit: LocalBrowserAuditWriter = localBrowserAuditWriter(dataDirectory)
  ) {}

  capabilities(): LocalBrowserCapabilities {
    return localBrowserCapabilities(Boolean(this.embedded));
  }

  async state(): Promise<LocalBrowserState> {
    return this.snapshot();
  }

  private snapshot(selectedOnly = false): LocalBrowserState {
    this.syncTabs();
    const selected = this.tabs.get(this.selectedTabId ?? '');
    if (selected) this.metadata.refresh(selected);
    const pages = [...this.tabs].filter(([id]) => !selectedOnly || id === this.selectedTabId);
    const tabs = this.metadata.describe(pages);
    return {
      connectionId: this.connectionId,
      sessionId: this.sessionId,
      browserVersion: this.browserVersion,
      channel: this.channel,
      mode: this.mode,
      status: this.status,
      paused: this.paused,
      tabs,
      selectedTabId: this.selectedTabId,
      revision: this.revision,
      preparation: this.preparation.current,
    };
  }

  async open(input: LocalBrowserOpen): Promise<LocalBrowserState> {
    this.assertNotClosing();
    if (this.actions.active)
      throw new LocalBrowserError('busy', 'A browser action is finishing. Read the page again.');
    if (this.opening)
      throw new LocalBrowserError('busy', 'The browser is starting. Wait a moment.');
    if (input.mode === 'existing' && input.consent !== true)
      throw new LocalBrowserError('consent_required', 'Allow DorkOS to use your browser first.');
    if (input.mode === 'embedded' && !this.embedded)
      throw new LocalBrowserError('unsupported', 'Use the desktop app for the DorkOS browser.');
    if (input.url) assertLocalBrowserUrl(input.url);
    this.opening = true;
    const setupAbort = new AbortController();
    this.openingAbort = setupAbort;
    try {
      await this.closeConnection(false);
      setupAbort.signal.throwIfAborted();
      const lifecycle = this.lifecycle;
      const connectionId = randomUUID();
      this.connectionId = connectionId;
      this.sessionId = input.sessionId ?? null;
      this.mode = input.mode;
      this.channel = input.mode === 'existing' ? (input.channel ?? 'chrome') : null;
      const acquisition = (async () => {
        if (input.mode === 'new-window') {
          const storage = path.join(this.dataDirectory, 'local-browser', 'saved-logins');
          await mkdir(storage, { recursive: true, mode: 0o700 });
          setupAbort.signal.throwIfAborted();
          this.ownedContext = await this.backend.launch(
            storage,
            setupAbort.signal,
            this.preparation.start()
          );
          this.ownedContext.on('close', () => this.closed(connectionId));
        } else if (input.mode === 'existing') {
          this.browser = await this.backend.connect(input.channel ?? 'chrome');
          this.browserVersion = this.browser.version();
          assertLocalExistingBrowserVersion(this.browserVersion);
        } else {
          const bridge = await this.embedded!.open(connectionId);
          this.embeddedClose = bridge.close;
          setupAbort.signal.throwIfAborted();
          this.browser = await this.backend.connect(bridge.endpoint, bridge.headers);
        }
      })();
      this.acquisition = acquisition;
      try {
        await acquisition;
      } finally {
        if (this.acquisition === acquisition) this.acquisition = undefined;
      }
      if (this.lifecycle !== lifecycle)
        throw new LocalBrowserError(
          'cancelled',
          'The browser connection stopped. Open it again to continue.'
        );
      this.browser?.on('disconnected', () => this.closed(connectionId));
      this.browserVersion ??=
        this.browser?.version() ?? this.ownedContext?.browser()?.version() ?? null;
      this.status = 'connected';
      this.preparation.clear();
      this.paused = false;
      this.syncTabs();
      for (const page of this.tabs.values()) this.metadata.refresh(page);
      // Never create a personal tab without an explicit URL request.
      if (this.tabs.size === 0 && input.mode !== 'existing') {
        const context = this.contexts()[0];
        if (context) this.track(await context.newPage());
      }
      if (input.url) {
        if (input.mode === 'existing') {
          const context = this.contexts()[0];
          if (!context)
            throw new LocalBrowserError('closed', 'Your browser closed. Connect it again.');
          const page = await context.newPage();
          await this.selectTab(this.track(page));
        }
        await this.navigate(input.url);
      }
      return await this.state();
    } catch (error) {
      const cancelled = setupAbort.signal.aborted;
      await this.disconnect();
      if (cancelled)
        throw new LocalBrowserError(
          'cancelled',
          'Browser setup stopped. Open it again to continue.'
        );
      if (error instanceof LocalBrowserError) throw error;
      throw new LocalBrowserError(
        'connect_failed',
        input.mode === 'existing'
          ? 'Couldn’t connect. Check your browser’s setup and allow the connection.'
          : 'Couldn’t open the browser. Try again.'
      );
    } finally {
      this.preparation.clear();
      if (this.openingAbort === setupAbort) this.openingAbort = undefined;
      this.opening = false;
    }
  }

  /** The browser is shared with one live chat, not every agent or external caller. */
  requireSharedSession(sessionId: string): void {
    if (this.sessionId !== sessionId)
      throw new LocalBrowserError(
        'not_shared',
        'Open this chat’s browser to share it with your agent.'
      );
  }

  /** A tool may describe the selected tab only, never other personal tabs. */
  async agentState(): Promise<LocalBrowserState> {
    return this.snapshot(true);
  }

  async selectTab(id: string): Promise<LocalBrowserState> {
    this.assertNotClosing();
    this.syncTabs();
    if (!this.tabs.has(id))
      throw new LocalBrowserError('closed', 'That tab closed. Choose another tab.');
    this.selectedTabId = id;
    this.metadata.refresh(this.page());
    this.invalidate();
    const revision = this.revision;
    await this.focus.select(this.mode === 'existing' && this.sessionId ? this.page() : undefined);
    if (revision !== this.revision) throw this.stale();
    if (this.mode !== 'existing') {
      await responseDeadline(this.page().bringToFront(), PAGE_READ_RESPONSE_TIMEOUT_MS, () => {
        this.invalidate();
        return this.stale();
      });
      if (revision !== this.revision) throw this.stale();
    }
    return this.state();
  }

  async observe(): Promise<LocalBrowserObservation> {
    const page = this.page();
    this.invalidate();
    const revision = this.revision;
    await this.focus.ready();
    if (revision !== this.revision) throw this.stale();
    // One remote handle records node identity at observation time, including open shadow roots.
    // The function is fixed internal bookkeeping, never supplied by an agent or HTTP caller.
    let expired = false;
    const reading = observationNodes(page);
    void reading
      .then((nodes) => {
        if (expired) void nodes.dispose().catch(() => undefined);
      })
      .catch(() => undefined);
    const nodes = await responseDeadline(reading, PAGE_READ_RESPONSE_TIMEOUT_MS, () => {
      expired = true;
      return this.stale();
    });
    try {
      if (revision !== this.revision) throw this.stale();
      const snapshot = await boundedPageSnapshot(page, ACTION_TIMEOUT_MS);
      if (revision !== this.revision) throw this.stale();
      this.observedNodes = nodes;
      this.observation = { revision, snapshot, url: page.url(), tabId: this.selectedTabId! };
      return this.observation;
    } catch (error) {
      void nodes.dispose().catch(() => undefined);
      throw error;
    }
  }

  /** Capture pixels from the same selected page; this grants no new action observation. */
  async screenshot(): Promise<{ data: string; mimeType: string; revision: number; tabId: string }> {
    const page = this.page();
    const revision = this.revision;
    const tabId = this.selectedTabId!;
    await this.focus.ready();
    if (revision !== this.revision) throw this.stale();
    const bytes = await boundedPageScreenshot(page, ACTION_TIMEOUT_MS);
    if (revision !== this.revision || tabId !== this.selectedTabId) throw this.stale();
    return { data: bytes.toString('base64'), mimeType: 'image/png', revision, tabId };
  }

  async action(input: LocalBrowserAction): Promise<LocalBrowserState> {
    return auditPageAction(
      this.tabs.get(this.selectedTabId ?? ''),
      {
        sessionId: this.sessionId,
        mode: this.mode,
        connectionId: this.connectionId,
        tabId: this.selectedTabId,
      },
      input,
      this.audit,
      (dispatch) => this.performAction(input, dispatch)
    );
  }

  private async performAction(
    input: LocalBrowserAction,
    dispatch: () => void
  ): Promise<LocalBrowserState> {
    if (this.paused)
      throw new LocalBrowserError('paused', 'Your agent is paused. Resume it to continue.');
    if (this.actions.active)
      throw new LocalBrowserError('busy', 'A browser action is finishing. Read the page again.');
    const observed = this.observation;
    const observedNodes = this.observedNodes;
    if (
      !observed ||
      !observedNodes ||
      input.revision !== this.revision ||
      observed.revision !== input.revision
    )
      throw this.stale();
    const page = this.page();
    if (input.kind === 'navigate') assertLocalBrowserUrl(input.url);
    const lifecycle = this.lifecycle;
    const operation = async (admit: () => void, dispatched: () => void) => {
      await this.focus.ready();
      admit();
      await performPageAction(page, observed, observedNodes, input, admit, dispatched, () =>
        this.stale()
      );
    };
    try {
      await this.actions.run(
        operation,
        () => this.admit(input.revision),
        dispatch,
        () => {
          if (this.lifecycle === lifecycle) this.invalidate();
        }
      );
    } catch (error) {
      if (error instanceof LocalBrowserError) throw error;
      throw new LocalBrowserError(
        'uncertain',
        'The page changed. Check what happened before continuing.'
      );
    }
    return this.agentState();
  }

  /** Human navigation remains available while the agent is paused. */
  async navigate(url: string): Promise<LocalBrowserState> {
    assertLocalBrowserUrl(url);
    this.invalidate();
    const revision = this.revision;
    const page = this.page();
    await this.focus.ready();
    if (revision !== this.revision) throw this.stale();
    try {
      await page.goto(url, { waitUntil: 'commit', timeout: 15_000 });
    } catch {
      throw new LocalBrowserError(
        'navigation_uncertain',
        'Couldn’t finish opening the page. Check the browser.'
      );
    }
    return this.state();
  }

  /** Stop admission immediately; bounded in-flight effects may already have happened. */
  async pause(): Promise<LocalBrowserState> {
    this.paused = true;
    this.invalidate();
    return this.state();
  }
  async resume(): Promise<LocalBrowserState> {
    this.assertNotClosing();
    this.paused = false;
    this.invalidate();
    return this.state();
  }

  async disconnect(): Promise<LocalBrowserState> {
    return this.closeConnection(true);
  }

  private async closeConnection(abortSetup: boolean): Promise<LocalBrowserState> {
    if (abortSetup) this.openingAbort?.abort();
    if (!this.closing) {
      this.metadata.clear();
      this.preparation.clear();
      this.lifecycle += 1;
      this.paused = true;
      this.invalidate();
      const release = this.focus.release();
      const acquisition = this.acquisition;
      const closing = Promise.resolve().then(async () => {
        await release;
        await acquisition?.catch(() => undefined);
        const context = this.ownedContext;
        const browser = this.browser;
        const embeddedClose = this.embeddedClose;
        await Promise.all([
          browser &&
            resourceClosure(
              () => browser.close(),
              (closed) => {
                browser.once('disconnected', closed);
                return () => browser.off('disconnected', closed);
              }
            ),
          // Persistent Chromium's protocol-close event can precede process exit and
          // cookie flushing. Keep this profile owned until the original close request
          // settles; unlike personal-browser detach, its event cannot release the lease.
          context?.close(),
          embeddedClose?.(),
        ]);
        this.ownedContext = undefined;
        this.browser = undefined;
        this.embeddedClose = undefined;
        this.connectionId = this.sessionId = this.browserVersion = this.channel = this.mode = null;
        this.status = 'disconnected';
        this.tabs.clear();
        this.selectedTabId = null;
      });
      this.closing = closing;
      void closing
        .then(() => {
          if (this.closing === closing) this.closing = undefined;
        })
        // A failed bridge close retains this tombstone until app restart; it never grants another writer.
        .catch(() => {
          this.closingFailed = true;
        });
    }
    await responseDeadline(this.closing, CLOSE_RESPONSE_TIMEOUT_MS, () =>
      closingError(this.closingFailed)
    ).catch(() => {
      throw closingError(this.closingFailed);
    });
    return this.state();
  }

  private assertNotClosing(): void {
    if (this.closing) throw closingError(this.closingFailed);
  }

  private contexts(): BrowserContext[] {
    return this.ownedContext ? [this.ownedContext] : (this.browser?.contexts() ?? []);
  }
  private syncTabs(): void {
    if (this.closing || this.status !== 'connected') return;
    for (const context of this.contexts()) for (const page of context.pages()) this.track(page);
    for (const [id, page] of this.tabs) if (page.isClosed()) this.tabs.delete(id);
    if (this.selectedTabId && !this.tabs.has(this.selectedTabId)) {
      this.selectedTabId = null;
      void this.focus.release();
      this.invalidate();
    }
    // Existing browsers require the person to choose their exact tab.
    if (!this.selectedTabId && this.mode !== 'existing')
      this.selectedTabId = this.tabs.keys().next().value ?? null;
  }
  private track(page: Page): string {
    for (const [id, known] of this.tabs) if (known === page) return id;
    const id = randomUUID();
    this.tabs.set(id, page);
    this.metadata.track(page, {
      active: () => [...this.tabs.values()].includes(page),
      selected: () => this.tabs.get(this.selectedTabId ?? '') === page,
      invalidate: () => this.invalidate(),
      closed: () => {
        this.selectedTabId = null;
        void this.focus.release();
        this.invalidate();
      },
    });
    return id;
  }
  private page(): Page {
    this.assertNotClosing();
    this.syncTabs();
    const page = this.tabs.get(this.selectedTabId ?? '');
    if (this.status !== 'connected')
      throw new LocalBrowserError('closed', 'The browser closed. Connect it again.');
    if (!page || page.isClosed())
      throw new LocalBrowserError('no_tab', 'Choose the tab your agent should use.');
    return page;
  }
  private closed(id: string): void {
    if (this.connectionId !== id) return;
    void this.focus.release();
    this.metadata.clear();
    this.status = 'closed';
    this.paused = true;
    this.tabs.clear();
    this.selectedTabId = null;
    this.invalidate();
  }
  private invalidate(): void {
    this.revision += 1;
    this.observation = undefined;
    const nodes = this.observedNodes;
    this.observedNodes = undefined;
    // Invalidation is synchronous so navigation/pause fences admission immediately.
    // Disposal is asynchronous protocol cleanup and cannot delay that fence.
    void nodes?.dispose().catch(() => undefined);
  }
  private admit(revision: number): void {
    this.assertNotClosing();
    if (this.paused)
      throw new LocalBrowserError('paused', 'Your agent is paused. Resume it to continue.');
    if (revision !== this.revision) throw this.stale();
  }
  private stale(): LocalBrowserError {
    return new LocalBrowserError('stale_page', 'The page changed. Read it again before acting.');
  }
}
