import type { JSHandle, Page } from 'playwright-core';
import type { CloudOriginEntry } from '@dorkos/shared/cloud-origin';
import type {
  LocalBrowserAction,
  LocalBrowserMode,
  LocalBrowserObservation,
  LocalBrowserState,
} from '@dorkos/shared/local-browser';
import { TabBroker } from '../broker/tab-broker.js';
import type { TabLease, TabPrincipal, TabTakeover } from '../broker/types.js';
import { TabUrlPolicy } from '../broker/url-policy.js';
import { TabBrokerError } from '../broker/errors.js';
import { LocalBrowserError, assertLocalBrowserUrl, protectedPageRefusal } from '../errors.js';
import {
  BrowserActionFlight,
  PAGE_READ_RESPONSE_TIMEOUT_MS,
  responseDeadline,
} from '../lifecycle.js';
import { actionFence, auditPageAction, performPageAction } from '../page-action.js';
import type { LocalBrowserAuditWriter } from '../action-audit.js';
import type { ObservedPageNodes } from '../observation-nodes.js';
import { observeSelectedPage, screenshotSelectedPage } from '../connection/observe-page.js';
import { LocalBrowserTabMetadata } from '../tab-metadata.js';
import { FullScreenGuard } from '../agent-window/index.js';

/** Connection facts shared by leases; page admission remains inside the broker. */
export interface ChatBrowserHost {
  broker: TabBroker;
  pages: ReadonlyMap<string, Page>;
  connectionId: string;
  mode: LocalBrowserMode;
  audit: LocalBrowserAuditWriter;
  cloudOrigins(): readonly CloudOriginEntry[];
  appOrigins(): readonly string[];
  assertAvailable(): void;
  assertMayAct(): void;
  windowPolicy(pageId: string, held: boolean): Promise<void>;
}

/** One chat's revision, node handles, pause, action flight and selected owned page. */
export class BrowserChatSession {
  private selectedTabId: string | null = null;
  private revision = 0;
  private frameChanges = 0;
  private observation?: LocalBrowserObservation;
  private observedNodes?: JSHandle<ObservedPageNodes>;
  private readonly actions = new BrowserActionFlight();
  private readonly metadata = new LocalBrowserTabMetadata();
  private readonly fullScreen = new FullScreenGuard();
  private readonly tabs = new Map<string, Page>();
  private paused = false;
  private status: LocalBrowserState['status'] = 'connected';
  private takeover?: TabTakeover;
  private heldState?: LocalBrowserState;
  readonly policy: TabUrlPolicy;

  constructor(
    readonly sessionId: string | null,
    readonly principal: TabPrincipal,
    private readonly host: ChatBrowserHost
  ) {
    // The existing Agent browser can visit local websites. Keep that explicit host choice;
    // the reusable policy defaults to public addresses only.
    this.policy = new TabUrlPolicy({
      allowPrivateNetworks: true,
      check: (url) =>
        assertLocalBrowserUrl(url.href, 'agent', host.cloudOrigins(), host.appOrigins()),
    });
  }

  get busy(): boolean {
    return this.actions.active;
  }

  get held(): boolean {
    return !!this.heldState;
  }
  ownsTab(id: string): boolean {
    return this.selectedTabId === id || this.heldState?.selectedTabId === id;
  }
  hasPage(): boolean {
    if (this.heldState) return !this.tabs.get(this.heldState.selectedTabId ?? '')?.isClosed();
    return this.host.broker.list(this.principal).length > 0;
  }

  /** Refuse a missing or revoked page before a tool can obtain this session handle. */
  requirePage(): void {
    this.host.assertAvailable();
    // This is a scope handle, never a raw Page. Hand-off tools may still name it;
    // every read/effect goes through selected(), which refuses the person-held page.
    if (this.heldState) return;
    this.syncTabs();
    this.selected();
  }

  /** Person-facing state uses a frozen, trimmed snapshot throughout takeover. */
  async state(selectedOnly = false): Promise<LocalBrowserState> {
    if (this.heldState) return { ...this.heldState, revision: this.revision, paused: true };
    this.syncTabs();
    const selected = this.tabs.get(this.selectedTabId ?? '');
    if (selected) this.metadata.refresh(selected);
    return {
      connectionId: this.host.connectionId,
      sessionId: this.sessionId,
      mode: this.host.mode,
      status: this.status,
      paused: this.paused,
      selectedTabId: this.selectedTabId,
      revision: this.revision,
      preparation: null,
      tabs: this.metadata.describe(
        [...this.tabs].filter(([id]) => !selectedOnly || id === this.selectedTabId)
      ),
    };
  }

  /** Every agent read uses only the selected owned page and the same queue as its effects. */
  async agentState(): Promise<LocalBrowserState> {
    return this.read(async () => this.state(true));
  }

  async requireNotFullScreen(): Promise<void> {
    this.requirePage();
    await this.fullScreen.requireNone();
    this.requirePage();
  }

  async observe(): Promise<LocalBrowserObservation> {
    return this.read(async (page) => {
      this.invalidate();
      const observed = await observeSelectedPage(page, this.selectedTabId!, {
        revision: () => this.revision,
        frames: () => this.frameChanges,
        refuse: () => this.refuseProtectedPage(page),
        stale: () => this.stale(),
      });
      this.observedNodes = observed.nodes;
      this.observation = observed.observation;
      return observed.observation;
    });
  }

  async screenshot(): Promise<{ data: string; mimeType: string; revision: number; tabId: string }> {
    return this.read(async (page) =>
      screenshotSelectedPage(
        page,
        () => ({ revision: this.revision, tabId: this.selectedTabId!, frames: this.frameChanges }),
        () => this.refuseProtectedPage(page)
      )
    );
  }

  async action(input: LocalBrowserAction): Promise<LocalBrowserState> {
    this.requirePage();
    this.host.assertMayAct();
    return auditPageAction(
      this.tabs.get(this.selectedTabId!),
      {
        sessionId: this.sessionId,
        mode: this.host.mode,
        connectionId: this.host.connectionId,
        tabId: this.selectedTabId,
      },
      input,
      this.host.audit,
      (dispatch) => this.performAction(input, dispatch)
    );
  }

  private async performAction(
    input: LocalBrowserAction,
    dispatch: () => void
  ): Promise<LocalBrowserState> {
    const lease = this.selected();
    const page = this.tabs.get(lease.pageId)!;
    this.refuseProtectedPage(page);
    if (this.paused)
      throw new LocalBrowserError('paused', 'Your agent is paused. Resume it to continue.');
    if (this.actions.active)
      throw new LocalBrowserError('busy', 'A browser action is finishing. Read the page again.');
    const observed = this.observation;
    const nodes = this.observedNodes;
    const fence = actionFence(input, observed, Boolean(nodes), this.revision, () => this.stale());
    if (input.kind === 'navigate') {
      try {
        assertLocalBrowserUrl(input.url, 'agent', this.host.cloudOrigins(), this.host.appOrigins());
        await this.policy.assert(input.url);
      } catch (error) {
        // A refused destination stops only this lease. Normalize broker errors before
        // the action journal handles them, so a refusal cannot become an uncertain effect.
        this.paused = true;
        this.invalidate();
        if (error instanceof TabBrokerError) throw new LocalBrowserError(error.code, error.message);
        throw error;
      }
    }
    try {
      // BrowserActionFlight's deadline is outside this queue: a timed-out effect still owns its slot.
      await this.actions.run(
        (admit, dispatched) =>
          this.host.broker.run(lease, async (_page, current) => {
            const readmit = () => {
              current();
              admit();
            };
            await performPageAction(page, observed, nodes, input, readmit, dispatched, () =>
              this.stale()
            );
          }),
        () => this.admit(fence),
        dispatch,
        () => this.invalidate()
      );
    } catch (error) {
      this.refuseProtectedPage(page);
      if (error instanceof LocalBrowserError) throw error;
      if (error instanceof TabBrokerError) throw new LocalBrowserError(error.code, error.message);
      throw new LocalBrowserError(
        'uncertain',
        'The page changed. Check what happened before continuing.'
      );
    }
    this.refuseProtectedPage(page);
    this.host.broker.requireNoBlockedPopup(lease.pageId);
    return this.agentState();
  }

  /** A person's address bar is intentionally separate from agent URL admission. */
  async navigate(url: string): Promise<LocalBrowserState> {
    assertLocalBrowserUrl(url, 'person');
    this.invalidate();
    const page = this.tabs.get(this.selectedTabId ?? '');
    if (!page || page.isClosed())
      throw new LocalBrowserError('tab_gone', 'That tab closed. Open the browser again.');
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

  async selectTab(id: string): Promise<LocalBrowserState> {
    if (this.heldState?.selectedTabId === id && (await this.host.broker.showSignIn(id)))
      return this.state();
    this.syncTabs();
    const page = this.tabs.get(id);
    if (!page || page.isClosed())
      throw new LocalBrowserError('tab_gone', 'That tab closed. Choose another tab.');
    this.selectedTabId = id;
    this.invalidate();
    const revision = this.revision;
    await responseDeadline(page.bringToFront(), PAGE_READ_RESPONSE_TIMEOUT_MS, () => this.stale());
    if (revision !== this.revision) throw this.stale();
    if (this.heldState?.selectedTabId === id && this.takeover) {
      const takeover = this.takeover;
      try {
        await this.host.windowPolicy(id, true);
        if (revision !== this.revision || takeover !== this.takeover) throw this.stale();
        takeover.take();
      } catch (error) {
        await this.host.windowPolicy(id, false).catch(() => undefined);
        throw error;
      }
    }
    return this.state();
  }

  async pause(): Promise<LocalBrowserState> {
    this.paused = true;
    this.invalidate();
    return this.state();
  }

  /** No metadata refresh or agent read survives the person's takeover. */
  async handToPerson(): Promise<LocalBrowserState> {
    if (this.heldState) return this.state();
    const before = await this.state();
    await this.pause();
    this.takeover = this.host.broker.hold(this.selected());
    try {
      await this.host.windowPolicy(this.selectedTabId!, false);
    } catch (error) {
      await this.host.windowPolicy(this.selectedTabId!, false).catch(() => undefined);
      try {
        this.takeover.handBack();
      } catch {
        /* A page that closed stays revoked. */
      }
      this.takeover = undefined;
      throw error;
    }
    this.heldState = {
      ...before,
      paused: true,
      tabs: before.tabs.map((tab) => ({
        ...tab,
        url: new URL(tab.url).origin,
        title: '',
      })),
    };
    this.metadata.clear();
    return this.state();
  }

  async resume(): Promise<LocalBrowserState> {
    this.host.assertAvailable();
    if (this.heldState?.selectedTabId) {
      await this.host.windowPolicy(this.heldState.selectedTabId, false);
      await this.host.broker.closeSignIn(this.heldState.selectedTabId);
    }
    if (this.takeover) {
      try {
        this.takeover.handBack();
      } catch (error) {
        if (!(error instanceof TabBrokerError) || error.code !== 'tab_locked') throw error;
        this.rebindPersonPage();
      }
    } else if (this.heldState) this.rebindPersonPage();
    this.takeover = undefined;
    this.heldState = undefined;
    this.paused = false;
    this.invalidate();
    return this.state();
  }

  /** An explicit person Resume can re-share only this session's former page. */
  private rebindPersonPage(): void {
    const page = this.tabs.get(this.heldState?.selectedTabId ?? '');
    if (!page || page.isClosed())
      throw new LocalBrowserError('tab_gone', 'That tab closed. Open the browser again.');
    this.host.broker.personResume(page, this.principal);
  }

  async closeSignIn(): Promise<void> {
    if (this.heldState?.selectedTabId) {
      await this.host.windowPolicy(this.heldState.selectedTabId, false);
      await this.host.broker.closeSignIn(this.heldState.selectedTabId);
    }
  }

  /** Stop or disconnect leaves a handed-off page unowned for the person. */
  abandon(): void {
    try {
      this.takeover?.abandon();
    } catch (error) {
      if (!(error instanceof TabBrokerError) || !['tab_gone', 'tab_locked'].includes(error.code))
        throw error;
    }
    this.takeover = undefined;
    this.paused = true;
    this.invalidate();
    this.host.broker.disconnect(this.principal);
  }

  /** Invalidate a closing connection without acquiring another chat's surviving tab. */
  closed(): void {
    this.status = 'closed';
    this.paused = true;
    this.invalidate();
    this.tabs.clear();
    this.selectedTabId = null;
    this.heldState = undefined;
    this.takeover = undefined;
    this.metadata.clear();
  }

  private async read<T>(operation: (page: Page) => Promise<T>): Promise<T> {
    const lease = this.selected();
    if (this.actions.active)
      throw new LocalBrowserError('busy', 'A browser action is finishing. Read the page again.');
    let expired = false;
    const reading = this.host.broker.run(lease, async (page, current) => {
      const admit = () => {
        this.host.assertAvailable();
        current();
        if (expired || this.selectedTabId !== lease.pageId) throw this.stale();
        this.refuseProtectedPage(page);
      };
      admit();
      const answer = await operation(page);
      admit();
      return answer;
    });
    return responseDeadline(reading, PAGE_READ_RESPONSE_TIMEOUT_MS, () => {
      expired = true;
      return this.stale();
    });
  }

  private syncTabs(): void {
    if (this.heldState || this.status !== 'connected') return;
    const owned = this.host.broker.list(this.principal);
    const ids = new Set(owned.map((lease) => lease.pageId));
    for (const id of this.tabs.keys()) if (!ids.has(id)) this.tabs.delete(id);
    for (const lease of owned) {
      const page = this.host.pages.get(lease.pageId);
      if (!page || this.tabs.has(lease.pageId)) continue;
      this.tabs.set(lease.pageId, page);
      if (this.host.mode === 'new-window') this.fullScreen.watch(page);
      this.metadata.track(page, {
        active: () =>
          !this.heldState &&
          this.host.broker.list(this.principal).some((tab) => tab.pageId === lease.pageId),
        selected: () => this.selectedTabId === lease.pageId,
        invalidate: () => this.invalidate(),
        framesChanged: () => {
          this.frameChanges++;
        },
        closed: () => {
          this.selectedTabId = null;
          this.invalidate();
        },
      });
    }
    if (!this.selectedTabId || !this.tabs.has(this.selectedTabId))
      this.selectedTabId = this.tabs.keys().next().value ?? null;
  }

  private selected(): TabLease {
    this.host.assertAvailable();
    this.syncTabs();
    if (!this.selectedTabId)
      throw new LocalBrowserError('tab_gone', 'That tab closed. Open the browser again.');
    return this.host.broker.leaseFor(this.principal, this.selectedTabId);
  }

  private admit(revision: number): void {
    this.selected();
    this.host.assertMayAct();
    if (this.paused)
      throw new LocalBrowserError('paused', 'Your agent is paused. Resume it to continue.');
    if (revision !== this.revision) throw this.stale();
    this.refuseProtectedPage(this.tabs.get(this.selectedTabId!)!);
  }

  private refuseProtectedPage(page: Page): void {
    const refusal = protectedPageRefusal(
      [page.url(), ...page.frames().map((frame) => frame.url())],
      this.host.cloudOrigins(),
      this.host.appOrigins()
    );
    if (!refusal) return;
    this.paused = true;
    this.invalidate();
    throw refusal;
  }

  private invalidate(): void {
    this.revision++;
    this.observation = undefined;
    const nodes = this.observedNodes;
    this.observedNodes = undefined;
    void nodes?.dispose().catch(() => undefined);
  }

  private stale(): LocalBrowserError {
    return new LocalBrowserError('stale_page', 'The page changed. Read it again before acting.');
  }
}
