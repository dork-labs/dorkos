/** One DorkOS-owned visible browser, embedded or in a separate persistent window. */
import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { localBrowserAuditWriter, type LocalBrowserAuditWriter } from '../action-audit.js';
import {
  LocalBrowserError,
  agentPausedRefusal,
  assertAgentMayAct,
  assertLocalBrowserUrl,
  browserClosedRefusal,
  personPausedRefusal,
  protectedPageRefusal,
  browserSetupCancelled,
  stalePageRefusal,
} from '../errors.js';
import { PersonPageMoves } from '../history/person-page-moves.js';
import { assertOpenable } from '../open-input.js';
import { localBrowserAppOrigins } from '../app-origins.js';
import { prepareProfileFolder } from '../profile-folders.js';
import type { BrowserProfileAccessGate } from '../profile-access.js';
import type { CloudOriginEntry } from '@dorkos/shared/cloud-origin';
import { cloudOriginsForThisServer } from '../../../core/cloud/cloud-api-origin.js';
import { BrowserActionFlight, closeConnectionHolders } from '../lifecycle.js';
import { BrowserPreparation } from '../preparation.js';
import {
  localBrowserCapabilities,
  localBrowserHostFacts,
  type LocalBrowserHostFacts,
} from '../presentation.js';
import { AgentWindowNames, FullScreenGuard } from '../agent-window/index.js';
import { productionBackend, type LocalBrowserBackend } from '../playwright-backend.js';
import type { PageSessionBackend, PageConnection } from './profile-connection.js';
import { BrowserPageHandles } from './page-handles.js';
import { BrowserAgentPageActions } from './page-action.js';
import { BrowserPageState } from './page-state.js';
import type { PageSessionHost } from './page-session-host.js';
import { BrowserAgentPageReads } from './agent-page-reads.js';
import { selectPersonPage } from './person-selection.js';
import { BrowserPersonPageControl } from './person-page-control.js';
import { BrowserLeaseAuthority } from './lease-authority.js';
import { BrowserLeaseJournal } from './lease-journal.js';
import { BrowserPageRuntime } from './page-runtime.js';
import { BrowserPageClosing } from './page-closing.js';
import { EmbeddedBrowserAttachment } from '../connection/embedded-attachment.js';
import { BrowserHandover } from '../handover.js';
import { SignInWindow } from '../sign-in-window.js';
import type { BrowserProfileRemoval } from '../profile-removal/index.js';
import { pageSessionProfileRemoval } from '../profile-removal/page-session.js';
import type { EmbeddedBrowserPort } from '../desktop-bridge.js';
import type {
  LocalBrowserAction,
  LocalBrowserCapabilities,
  LocalBrowserHistoryDirection,
  LocalBrowserMode,
  LocalBrowserOpen,
  LocalBrowserState,
} from '@dorkos/shared/local-browser';

/** One selected live tab, with consumed observations and bounded, never-retried actions. */
export class LocalBrowserPageSession {
  readonly profileRemoval: BrowserProfileRemoval;
  private connectionId: string | null = null;
  private sessionId: string | null = null;
  private profileId: string | null = null;
  private readonly authority: BrowserLeaseAuthority;
  private mode: LocalBrowserMode | null = null;
  private status: LocalBrowserState['status'] = 'disconnected';
  private paused = false;
  private browser?: Browser;
  private ownedContext?: PageConnection;
  private embeddedAttachment?: EmbeddedBrowserAttachment;
  private detachedState?: LocalBrowserState;
  private embeddedClose?: () => Promise<void>;
  private readonly actions = new BrowserActionFlight();
  private acquisition?: Promise<void>;
  private readonly closing = new BrowserPageClosing();
  private opening = false;
  private requestedProfile: string | null = null;
  /** Host-only guard before replacing this profile with a debugger-off sign-in window. */
  requireExclusiveProfile: (profileId?: string | null) => void = () => undefined;
  private openingAbort?: AbortController;
  private lifecycle = 0;
  private readonly preparation = new BrowserPreparation();
  private readonly journal: BrowserLeaseJournal;
  private readonly personControl: BrowserPersonPageControl;
  private readonly runtime = new BrowserPageRuntime(
    () => this.invalidate(),
    this.actions,
    () => this.shared?.drainProfile?.() ?? Promise.resolve()
  );
  runAgentOperation<T>(effect: boolean, run: () => Promise<T>): Promise<T> {
    return this.runtime.operations.run(effect, run);
  }
  private readonly fullScreen = new FullScreenGuard(undefined, this.runtime.work.track, () =>
    this.requireAgentPage()
  );
  private readonly pageState = new BrowserPageState(
    this.runtime.work.track,
    (page) => {
      if (this.ownedContext) this.fullScreen.watch(page);
    },
    () => !this.runtime.custody.held && this.status === 'connected' && this.journal.isReady,
    (page) => this.journal.addresses(page)
  );
  private readonly moves = new PersonPageMoves({
    mode: () => this.mode,
    attachment: () => this.embeddedAttachment,
    appOrigins: () => this.appOrigins(),
    agentActing: () => this.actions.active,
  });
  /** The chat's agent name, for the title of the window it drives (DOR-3111). */
  readonly windowNames: AgentWindowNames;
  /** Handing the browser to the person and back, and the plain sign-in window. */
  readonly handover = new BrowserHandover(this, new SignInWindow(), () => this.dataDirectory);

  constructor(
    private readonly dataDirectory: string,
    private readonly embedded?: EmbeddedBrowserPort,
    private readonly backend: PageSessionBackend | LocalBrowserBackend = productionBackend,
    private readonly audit: LocalBrowserAuditWriter = localBrowserAuditWriter(dataDirectory),
    private readonly hostFacts: () => LocalBrowserHostFacts = localBrowserHostFacts,
    private readonly cloudOrigins: () => readonly CloudOriginEntry[] = cloudOriginsForThisServer,
    private readonly appOrigins: () => readonly string[] = localBrowserAppOrigins,
    private readonly shared?: PageSessionHost
  ) {
    this.journal = new BrowserLeaseJournal(
      dataDirectory,
      this.runtime.work.track,
      shared?.leaseAudit,
      () => (this.runtime.custody.held ? 'person' : 'server')
    );
    this.authority = new BrowserLeaseAuthority(shared?.agentId ?? (async () => undefined), () => {
      this.openingAbort?.abort();
      this.lifecycle++;
      this.paused = true;
      this.runtime.custody.block();
    });
    this.personControl = new BrowserPersonPageControl({
      journal: this.journal,
      custody: this.runtime.custody,
      moves: this.moves,
      assertAvailable: () => {
        this.authority.assertCurrent('person');
        this.assertNotClosing();
      },
      invalidate: () => this.invalidate(),
      revision: () => this.pageState.revision,
      stale: stalePageRefusal,
      setPaused: (paused) => {
        this.paused = paused;
      },
      driving: () => this.sessionId !== null && !this.paused,
      page: () => this.page(),
      state: () => this.state(),
      detach: async () => {
        if (this.mode !== 'embedded') return;
        // Retain the detached reservation if the native acknowledgment is lost.
        this.detachedState ??= this.snapshot();
        await this.embeddedAttachment!.detach();
        this.browser = undefined;
        this.pageState.tabs.clear();
        this.pageState.metadata.clear();
      },
      reattach: async () => {
        if (!this.detachedState) return;
        this.browser = await this.embeddedAttachment!.resume();
        this.detachedState = undefined;
        this.pageState.selectedTabId = null;
      },
    });
    this.windowNames = shared?.names ?? new AgentWindowNames();
    this.profileRemoval =
      shared?.removal ?? pageSessionProfileRemoval(dataDirectory, this, embedded);
  }

  capabilities(): LocalBrowserCapabilities {
    return localBrowserCapabilities(Boolean(this.embedded), this.hostFacts());
  }

  /** The person's view, with whether Back and Forward have a page to go to (DOR-4449). */
  async state(): Promise<LocalBrowserState> {
    const page = this.detachedState
      ? undefined
      : this.pageState.tabs.get(this.pageState.selectedTabId ?? '');
    return this.moves.describe(this.snapshot(), page);
  }

  private snapshot(selectedOnly = false): LocalBrowserState {
    if (this.detachedState)
      return { ...this.detachedState, paused: true, revision: this.pageState.revision };
    this.syncTabs();
    return this.pageState.describe(
      {
        connectionId: this.connectionId,
        sessionId: this.sessionId,
        mode: this.mode,
        status: this.status,
        paused: this.paused,
        preparation: this.preparation.current,
      },
      selectedOnly
    );
  }

  async open(input: LocalBrowserOpen): Promise<LocalBrowserState> {
    this.profileRemoval.assertAvailable();
    this.assertNotClosing();
    if (this.actions.active)
      throw new LocalBrowserError('busy', 'A browser action is finishing. Read the page again.');
    if (this.opening)
      throw new LocalBrowserError('busy', 'The browser is starting. Wait a moment.');
    if (
      this.journal.healthy &&
      !this.authority.isRevoked &&
      this.hasLivePage() &&
      this.sessionId === (input.sessionId ?? null) &&
      this.mode === input.mode &&
      this.profileId === (input.profileId ?? null)
    ) {
      await this.resume();
      if (input.url) await this.navigate(input.url);
      return this.state();
    }
    assertOpenable(
      input,
      Boolean(this.embedded),
      this.capabilities(),
      this.authority.profiles.exists
    );
    if (input.url) assertLocalBrowserUrl(input.url, 'person');
    this.requestedProfile = input.profileId ?? null;
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
      this.profileId = input.profileId ?? null;
      await this.authority.begin(this.sessionId, this.profileId);
      this.mode = input.mode;
      const acquisition = (async () => {
        if (input.mode === 'new-window') {
          const storage = await prepareProfileFolder(this.dataDirectory, input.profileId ?? null);
          setupAbort.signal.throwIfAborted();
          this.ownedContext = await this.backend.launch(
            storage,
            setupAbort.signal,
            this.preparation.start(),
            await this.windowNames.of(input.sessionId)
          );
          this.ownedContext.on('close', () => this.closed(connectionId));
        } else {
          const bridge = await this.embedded!.open(connectionId);
          this.embeddedClose = bridge.close;
          setupAbort.signal.throwIfAborted();
          this.embeddedAttachment = new EmbeddedBrowserAttachment(bridge, this.backend, () =>
            this.closed(connectionId)
          );
          this.browser = await this.embeddedAttachment.connect();
        }
      })();
      this.acquisition = acquisition;
      try {
        await acquisition;
      } finally {
        if (this.acquisition === acquisition) this.acquisition = undefined;
      }
      if (this.lifecycle !== lifecycle) throw browserSetupCancelled();
      this.runtime.beginPage(this.actions);
      this.status = 'connected';
      this.preparation.clear();
      this.paused = false;
      this.syncTabs();
      for (const page of this.pageState.tabs.values()) this.pageState.metadata.refresh(page);
      if (this.pageState.tabs.size === 0) {
        const context = this.contexts()[0];
        if (context) this.pageState.track(await context.newPage());
      }
      this.authority.assertCurrent();
      await this.handles.recordOpen(this.authority.agentId ?? null, this.profileId, this.page());
      if (input.url) await this.navigate(input.url);
      return await this.state();
    } catch (error) {
      const failure = setupAbort.signal.aborted ? browserSetupCancelled() : error;
      await this.disconnect();
      if (failure instanceof LocalBrowserError) throw failure;
      throw new LocalBrowserError('connect_failed', 'Couldn’t open the browser. Try again.');
    } finally {
      this.preparation.clear();
      if (this.openingAbort === setupAbort) this.openingAbort = undefined;
      this.opening = false;
    }
  }

  /** Whether this exact Page can still be resolved, without reading its document. */
  hasLivePage(): boolean {
    const page = this.pageState.tabs.get(this.pageState.selectedTabId ?? '');
    return this.status === 'connected' && !!page && !page.isClosed();
  }

  /** Pending acquisitions and unresolved closure retain their resource slot. */
  hasPageReservation(): boolean {
    return (
      this.opening ||
      this.closing.active ||
      this.hasLivePage() ||
      Boolean(this.detachedState) ||
      this.handover.hasActiveHandoff()
    );
  }
  personHeld(): boolean {
    return (
      (this.hasPageReservation() && this.runtime.custody.held) || this.handover.hasActiveHandoff()
    );
  }
  drainPageWork(): Promise<void> {
    return this.runtime.work.drainWith(this.actions);
  }
  /** Profile cleanup sees every page and pending acquisition, including a held page. */
  holdsProfileReservation(id: string | null): boolean {
    return (
      this.handover.holdsProfile(id) ||
      ((id ?? 'default') ===
        ((this.opening ? this.requestedProfile : this.profileId) ?? 'default') &&
        this.hasPageReservation())
    );
  }

  matchesProfileGrant(profileId: string, agentId?: string): boolean {
    return this.authority.matches(profileId, agentId);
  }
  assertAuthorityCurrent(): void {
    this.authority.assertCurrent();
  }

  /** Revoke before awaiting cleanup; person custody never becomes an agent grant again. */
  async revoke(): Promise<void> {
    const personHeld = this.runtime.custody.held || this.handover.hasActiveHandoff();
    this.authority.revoke();
    if (!personHeld) await this.disconnect();
  }

  /** The owned page connection, for host profile reservations only. */
  pageConnection(): PageConnection | undefined {
    return this.ownedContext;
  }

  private readonly handles = new BrowserPageHandles(
    this,
    this.pageState,
    this.runtime,
    () => this.journal,
    () => ({
      lifecycle: this.lifecycle,
      status: this.status,
      sessionId: this.sessionId,
      connectionId: this.connectionId,
    }),
    () => this.assertNotClosing()
  );
  /** Capture identity once; a replacement under the same chat id cannot inherit this call. */
  captureAgentLease(sessionId = this.sessionId) {
    return this.handles.agent(sessionId);
  }
  /** Host-only source for the typed owner viewer, never a tool argument. */
  captureViewerPage() {
    return this.handles.viewer();
  }

  /** The profile the browser opened last, or null for the default one. */
  readonly currentProfileId = (): string | null => this.profileId;

  /** The host of the page last read, when that reading was a refusal; cleared by any change. */
  readonly lastRefusalHost = (): string | null => this.pageState.observation?.refusal?.host ?? null;

  /** Whether a named profile exists. False until startup wires the profile list, as for open. */
  readonly profileExists = (id: string): boolean => this.authority.profiles.exists?.(id) ?? false;

  /**
   * Set once at startup; a named browser remains unavailable until access is wired.
   */
  useProfileAccess(...wiring: Parameters<BrowserProfileAccessGate['use']>): void {
    this.authority.profiles.use(...wiring);
  }

  /** On a named profile, the chat's agent must be one a person added, on every call. */
  async requireProfileAccess(sessionId: string): Promise<void> {
    await this.authority.require(sessionId);
    await this.journal.ready();
  }

  /** Refuse an agent while any page, including a new popup, is in full screen. */
  async requireNotFullScreen(): Promise<void> {
    this.syncTabs();
    await this.fullScreen.requireNone();
  }

  private readonly reads = new BrowserAgentPageReads({
    state: this.pageState,
    journal: () => this.journal,
    admit: () => this.requireAgentPage(),
    sync: () => this.syncTabs(),
    selected: () => this.page(true),
    refuse: (page) => this.refuseProtectedPage(page),
    describe: () => this.snapshot(true),
  });
  agentState = () => this.reads.state();

  /** Custody check after handover-specific refusals, before any Page read. */
  requireAgentPage(): void {
    this.authority.assertCurrent();
    if (this.runtime.custody.held) throw agentPausedRefusal();
    this.journal.assertHealthy();
  }

  async selectTab(id: string): Promise<LocalBrowserState> {
    this.assertNotClosing();
    this.syncTabs();
    return selectPersonPage(this.pageState, id, () => this.state());
  }

  observe = () => this.reads.observe();
  screenshot = () => this.reads.screenshot();

  private readonly agentActions = new BrowserAgentPageActions({
    pageState: this.pageState,
    actions: this.actions,
    audit: () => this.audit,
    identity: () => ({
      sessionId: this.sessionId,
      mode: this.mode,
      connectionId: this.connectionId,
      tabId: this.pageState.selectedTabId,
    }),
    lifecycle: () => this.lifecycle,
    page: () => this.page(true),
    assertAvailable: () => {
      this.shared?.assertAgentAction?.();
      this.assertNotClosing();
      assertAgentMayAct(this.status, this.paused);
    },
    assertDestination: (url) =>
      assertLocalBrowserUrl(url, 'agent', this.cloudOrigins(), this.appOrigins()),
    refuse: (page) => this.refuseProtectedPage(page),
    stale: stalePageRefusal,
    admit: (revision) => this.admit(revision),
    invalidate: () => this.invalidate(),
    state: () => this.agentState(),
  });
  action = (input: LocalBrowserAction) => this.agentActions.action(input);

  /** Human controls remain page-scoped while the agent is paused. */
  navigate = (url: string, options?: { httpFallback?: boolean }) =>
    this.personControl.navigate(url, options);
  stepHistory = (direction: LocalBrowserHistoryDirection) =>
    this.personControl.stepHistory(direction);
  pause = () => this.personControl.pause();
  handToPerson = () =>
    this.closing.active ? this.closeConnection(false) : this.personControl.handToPerson();
  resume = () => this.personControl.resume();

  async disconnect(): Promise<LocalBrowserState> {
    return this.closeConnection(true);
  }

  /**
   * Close the connection and release what it holds. `closed` is the person closing
   * the window: the same release, but the panel keeps saying it closed.
   */
  private async closeConnection(abortSetup: boolean, closed = false): Promise<LocalBrowserState> {
    if (abortSetup) this.openingAbort?.abort();
    const acquisition = this.acquisition;
    await this.closing.run(
      () => {
        this.pageState.metadata.clear();
        this.preparation.clear();
        this.lifecycle++;
        this.paused = true;
        this.invalidate();
      },
      async () => {
        await acquisition?.catch(() => undefined);
        await closeConnectionHolders(this.browser, this.ownedContext, this.embeddedClose);
        this.ownedContext = undefined;
        this.browser = undefined;
        this.embeddedClose = undefined;
        this.embeddedAttachment = this.detachedState = undefined;
        if (!closed) this.connectionId = this.sessionId = this.mode = null;
        if (!closed) this.status = 'disconnected';
        this.pageState.tabs.clear();
        this.pageState.selectedTabId = null;
      }
    );
    await this.journal.close();
    this.shared?.closed?.();
    return this.state();
  }

  private assertNotClosing(): void {
    this.closing.assertAvailable();
  }

  private contexts(): Pick<BrowserContext, 'pages' | 'newPage'>[] {
    return this.ownedContext ? [this.ownedContext] : (this.browser?.contexts() ?? []);
  }
  private syncTabs(): void {
    if (this.detachedState || this.closing.active || this.status !== 'connected') return;
    this.pageState.sync(this.contexts().flatMap((context) => context.pages()));
  }
  /** The selected tab; `forAgent` picks the agent's words for a handoff's pause (DOR-4678). */
  private page(forAgent = false): Page {
    this.assertNotClosing();
    this.syncTabs();
    const page = this.pageState.tabs.get(this.pageState.selectedTabId ?? '');
    if (this.detachedState) throw forAgent ? agentPausedRefusal() : personPausedRefusal();
    if (this.status !== 'connected') throw browserClosedRefusal();
    if (!page || page.isClosed())
      throw new LocalBrowserError('no_tab', 'Choose the tab your agent should use.');
    return page;
  }
  private closed(id: string): void {
    if (this.connectionId !== id) return;
    this.pageState.metadata.clear();
    this.status = 'closed';
    this.paused = true;
    this.pageState.tabs.clear();
    this.pageState.selectedTabId = null;
    this.invalidate();
    this.handover.windowClosed();
    // Release the profile as Disconnect does, once the close settles (DOR-4181). Its own errors
    // keep it held, as a failed Disconnect does.
    void this.closeConnection(false, true).catch(() => undefined);
  }
  private invalidate(): void {
    this.pageState.invalidate();
  }
  private admit(revision: number): void {
    this.shared?.assertAgentAction?.();
    this.authority.assertCurrent();
    this.assertNotClosing();
    assertAgentMayAct(this.status, this.paused);
    if (revision !== this.pageState.revision) throw stalePageRefusal();
    this.refuseProtectedPage(this.page(true));
  }
  /**
   * An agent never reads or acts on a page showing DorkOS or Cloud, in the
   * tab or in any of its frames (DOR-3196): agent control pauses until the
   * person resumes it, and the agent is refused.
   */
  private refuseProtectedPage(page: Page): void {
    const urls = [page.url(), ...page.frames().map((frame) => frame.url())];
    const refusal = protectedPageRefusal(urls, this.cloudOrigins(), this.appOrigins());
    if (!refusal) return;
    this.paused = true;
    this.invalidate();
    throw refusal;
  }
}
