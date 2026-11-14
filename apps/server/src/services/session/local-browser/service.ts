/** A shared browser connection with independent, server-owned chat page leases. */
import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import type { CloudOriginEntry } from '@dorkos/shared/cloud-origin';
import type {
  LocalBrowserAction,
  LocalBrowserCapabilities,
  LocalBrowserMode,
  LocalBrowserOpen,
  LocalBrowserState,
} from '@dorkos/shared/local-browser';
import { localBrowserAuditWriter, type LocalBrowserAuditWriter } from './action-audit.js';
import { LocalBrowserError, assertLocalBrowserUrl, browserSetupCancelled } from './errors.js';
import { assertOpenable } from './open-input.js';
import { localBrowserAppOrigins } from './app-origins.js';
import { prepareProfileFolder } from './profile-folders.js';
import { BrowserProfileAccessGate } from './profile-access.js';
import { cloudOriginsForThisServer } from '../../core/cloud/cloud-api-origin.js';
import {
  responseDeadline,
  closeBrowserConnection,
  CLOSE_RESPONSE_TIMEOUT_MS,
  closingError,
} from './lifecycle.js';
import { BrowserPreparation } from './preparation.js';
import {
  localBrowserCapabilities,
  localBrowserHostFacts,
  type LocalBrowserHostFacts,
} from './presentation.js';
import { AgentWindowNames } from './agent-window/index.js';
import { productionBackend, type LocalBrowserBackend } from './playwright-backend.js';
import { EmbeddedBrowserAttachment } from './connection/embedded-attachment.js';
import { BrowserHandover } from './handover.js';
import { SignInWindow } from './sign-in-window.js';
import { BrowserProfileRemoval } from './profile-removal/index.js';
import { BrowserChatSession } from './chat/session.js';
import { BrowserTabRegistry } from './chat/registry.js';
import { ChatTabRequests, type BrowserChatLookup } from './chat/tab-requests.js';
import type { EmbeddedBrowserPort } from './desktop-bridge.js';
export type { EmbeddedBrowserPort } from './desktop-bridge.js';
export { LocalBrowserError } from './errors.js';

/** One physical connection, many chat-local revisions, observations, queues and pause states. */
export class LocalBrowserService {
  private connectionId: string | null = null;
  private selectedSession: string | null = null;
  private profileId: string | null = null;
  private mode: LocalBrowserMode | null = null;
  private status: LocalBrowserState['status'] = 'disconnected';
  private browser?: Browser;
  private ownedContext?: BrowserContext;
  private embeddedAttachment?: EmbeddedBrowserAttachment;
  private embeddedClose?: () => Promise<void>;
  private acquisition?: Promise<void>;
  private closing?: Promise<void>;
  private closingFailed = false;
  private opening = false;
  private openingSession: string | null = null;
  private openingAbort?: AbortController;
  private lifecycle = 0;
  private readonly sessions = new Map<string | null, BrowserChatSession>();
  private readonly retiredSessions = new Set<BrowserChatSession>();
  private readonly closingSessions = new Map<string | null, Promise<void>>();
  private readonly preparation = new BrowserPreparation();
  private readonly profileAuthorization = new BrowserProfileAccessGate();
  private readonly registry: BrowserTabRegistry;
  private readonly tabRequests: ChatTabRequests;
  private agentIdentity: (sessionId: string) => Promise<string | undefined> = (id) =>
    this.windowNames.agentId(id);
  readonly windowNames = new AgentWindowNames();
  readonly handover: BrowserHandover = new BrowserHandover(
    this,
    new SignInWindow(),
    () => this.dataDirectory
  );
  readonly profileRemoval: BrowserProfileRemoval = new BrowserProfileRemoval({
    dataDirectory: () => this.dataDirectory,
    busy: (id): boolean =>
      Boolean(
        this.opening ||
        this.closing ||
        this.acquisition ||
        [...this.sessions.values(), ...this.retiredSessions].some((session) => session.busy) ||
        this.handover.holdsProfile(id) ||
        (this.profileId === id && (this.ownedContext || this.browser || this.embeddedClose))
      ),
    forgotten: (id) => this.handover.forgetProfileState(id),
    embedded: () => this.embedded,
  });

  constructor(
    private readonly dataDirectory: string,
    private readonly embedded?: EmbeddedBrowserPort,
    private readonly backend: LocalBrowserBackend = productionBackend,
    private readonly audit: LocalBrowserAuditWriter = localBrowserAuditWriter(dataDirectory),
    private readonly hostFacts: () => LocalBrowserHostFacts = localBrowserHostFacts,
    private readonly cloudOrigins: () => readonly CloudOriginEntry[] = cloudOriginsForThisServer,
    private readonly appOrigins: () => readonly string[] = localBrowserAppOrigins
  ) {
    this.registry = new BrowserTabRegistry(dataDirectory);
    this.tabRequests = new ChatTabRequests({
      broker: this.registry.broker,
      canOpen: () => !this.opening && !this.closing && this.status === 'connected',
      open: (input) => this.open(input, true),
      busy: (id) => this.sessions.get(id)?.busy ?? true,
      waitingForPerson: (id) => this.handover.waitingForPerson(id),
      origin: (id) => this.registry.broker.originFor(id),
    });
    this.registry.onClosed = (pageId) => {
      for (const session of this.sessions.values())
        if (session.ownsTab(pageId)) {
          session.closed();
          if (session.sessionId) this.handover.tabClosed(session.sessionId);
        }
      void this.tabRequests.drain();
    };
  }

  capabilities(): LocalBrowserCapabilities {
    return localBrowserCapabilities(Boolean(this.embedded), this.hostFacts());
  }

  /** Lookup is supplied by the runtime/agent registry, never by a browser tool argument. */
  useAgentIdentityLookup(lookup: (sessionId: string) => Promise<string | undefined>): void {
    this.agentIdentity = lookup;
  }

  useProfileAccess(...wiring: Parameters<BrowserProfileAccessGate['use']>): void {
    this.profileAuthorization.use(...wiring);
  }
  readonly profileExists = (id: string): boolean => this.profileAuthorization.exists?.(id) ?? false;
  readonly currentProfileId = (): string | null => this.profileId;
  async requireProfileAccess(sessionId: string): Promise<void> {
    await this.profileAuthorization.require(this.profileId, sessionId);
  }

  /** Capture a scope once per tool call; another chat opening a page cannot change it. */
  leaseFor(sessionId: string): BrowserChatSession {
    this.tabRequests.assertAgent(sessionId);
    if (this.mode === 'embedded' && this.status === 'connected')
      this.profileAuthorization.requireShared(this.selectedSession, sessionId);
    const session = this.sessions.get(sessionId);
    if (!session)
      throw new LocalBrowserError(
        'not_opened',
        'Ask the person to open this chat’s Agent browser.'
      );
    session.requirePage();
    return session;
  }

  async requireNotFullScreen(sessionId?: string): Promise<void> {
    await this.session(sessionId).requireNotFullScreen();
  }
  async agentState(sessionId?: string) {
    return this.session(sessionId).agentState();
  }
  async observe(sessionId?: string) {
    return this.session(sessionId).observe();
  }
  async screenshot(sessionId?: string) {
    return this.session(sessionId).screenshot();
  }
  async action(input: LocalBrowserAction, sessionId?: string) {
    return this.session(sessionId).action(input);
  }

  /** A person's controls choose their chat explicitly; an omitted scope retains the previous API. */
  async state(sessionId?: string): Promise<LocalBrowserState> {
    const session = this.sessions.get(sessionId === undefined ? this.selectedSession : sessionId);
    if (session) return session.state();
    const absent = sessionId !== undefined && this.mode === 'new-window';
    return {
      connectionId: absent ? null : this.connectionId,
      sessionId: sessionId ?? this.selectedSession,
      mode: this.mode,
      status: absent ? 'disconnected' : this.status,
      paused: absent || this.status !== 'connected',
      tabs: [],
      selectedTabId: null,
      revision: this.lifecycle,
      preparation: this.preparation.current,
    };
  }

  useChatLookup(lookup: BrowserChatLookup): void {
    this.tabRequests.useLookup(lookup);
  }
  async personTabs(sessionId?: string) {
    await this.tabRequests.drain();
    return this.tabRequests.personState(sessionId);
  }
  async closeIdleTab(target: string, requester: string): Promise<void> {
    await this.tabRequests.requireIdle(target, requester);
    await this.disconnect(target);
    await this.tabRequests.drain();
  }

  async open(input: LocalBrowserOpen, background = false): Promise<LocalBrowserState> {
    this.profileRemoval.assertAvailable();
    this.assertAvailable();
    for (const session of this.retiredSessions)
      if (!session.busy) this.retiredSessions.delete(session);
    if (this.retiredSessions.size)
      throw new LocalBrowserError(
        'busy',
        'A browser action is finishing. Wait before opening it again.'
      );
    if (this.opening)
      throw new LocalBrowserError('busy', 'The browser is starting. Wait a moment.');
    if (this.closingSessions.has(input.sessionId ?? null)) throw closingError(false);
    assertOpenable(
      input,
      Boolean(this.embedded),
      this.capabilities(),
      this.profileAuthorization.exists
    );
    if (input.url) assertLocalBrowserUrl(input.url, 'person');
    const sharedWindow =
      input.mode === 'new-window' && this.mode === 'new-window' && this.status === 'connected';
    if (sharedWindow && this.profileId !== (input.profileId ?? null) && this.sessions.size > 1)
      throw new LocalBrowserError(
        'profile_busy',
        'Close the Agent browser before changing its saved sign-ins.'
      );
    if (
      sharedWindow &&
      input.sessionId &&
      !this.sessions.get(input.sessionId)?.hasPage() &&
      !this.registry.broker.hasCapacity()
    ) {
      this.tabRequests.enqueue(input);
      return this.state(input.sessionId);
    }
    this.opening = true;
    this.openingSession = input.sessionId ?? null;
    const abort = new AbortController();
    this.openingAbort = abort;
    let added: BrowserChatSession | undefined;
    let createdPage: Page | undefined;
    const reuse = sharedWindow && this.profileId === (input.profileId ?? null);
    try {
      if (!reuse) await this.acquire(input, abort);
      abort.signal.throwIfAborted();
      const id = input.sessionId ?? null;
      let session = this.sessions.get(id);
      if (session) {
        try {
          session.requirePage();
        } catch {
          session = undefined;
        }
      }
      if (!session) {
        const context = this.contexts()[0];
        if (!context) throw browserSetupCancelled();
        let page: Page;
        const existing = input.mode === 'embedded' ? context.pages() : [];
        if (!reuse && input.mode === 'embedded' && existing[0]) page = existing[0];
        else {
          const parentId = background ? this.registry.broker.chatRecords()[0]?.pageId : undefined;
          const parent = parentId ? this.registry.pages.get(parentId) : undefined;
          page = this.backend.newPage
            ? await this.backend.newPage(context, background, parent)
            : await context.newPage();
          createdPage = page;
        }
        const pageId = this.registry.track(page);
        abort.signal.throwIfAborted();
        const principal = {
          ownerId: id ?? 'person',
          agentId: id ? ((await this.agentIdentity(id)) ?? 'unidentified') : 'unidentified',
        };
        abort.signal.throwIfAborted();
        this.registry.broker.bind(page, principal);
        if (input.mode === 'new-window') await this.registry.prepare(page, pageId);
        this.assertAvailable();
        session = this.createSession(id, principal, input.mode);
        this.sessions.set(id, session);
        added = session;
        await session.state();
        if (!background) await session.selectTab(pageId);
      }
      if (!background) this.selectedSession = id;
      if (input.url) await session.navigate(input.url);
      abort.signal.throwIfAborted();
      return session.state();
    } catch (error) {
      if (!reuse) await this.closeConnection(false);
      else {
        if (added) {
          added.abandon();
          this.sessions.delete(added.sessionId);
        }
        if (createdPage) {
          const id = input.sessionId ?? null;
          const closing = createdPage.close().then(() => {
            this.closingSessions.delete(id);
          });
          this.closingSessions.set(id, closing);
          void closing.catch(() => undefined);
          await responseDeadline(closing, CLOSE_RESPONSE_TIMEOUT_MS, () => closingError(false));
        }
      }
      if (abort.signal.aborted) throw browserSetupCancelled();
      if (error instanceof LocalBrowserError || (error instanceof Error && 'code' in error))
        throw error;
      throw new LocalBrowserError('connect_failed', 'Couldn’t open the browser. Try again.');
    } finally {
      this.preparation.clear();
      if (this.openingAbort === abort) this.openingAbort = undefined;
      this.opening = false;
      this.openingSession = null;
    }
  }

  private async acquire(input: LocalBrowserOpen, abort: AbortController): Promise<void> {
    const previous = this.status === 'connected' ? this.selectedSession : null;
    await this.closeConnection(false);
    abort.signal.throwIfAborted();
    const lifecycle = this.lifecycle;
    const id = randomUUID();
    this.connectionId = id;
    this.selectedSession = input.sessionId ?? null;
    this.mode = input.mode;
    this.profileId = input.profileId ?? null;
    await this.profileAuthorization.rememberHolder(this.selectedSession, previous);
    const acquisition = (async () => {
      if (input.mode === 'new-window') {
        const storage = await prepareProfileFolder(this.dataDirectory, this.profileId);
        abort.signal.throwIfAborted();
        this.ownedContext = await this.backend.launch(
          storage,
          abort.signal,
          this.preparation.start(),
          await this.windowNames.of(input.sessionId)
        );
        this.ownedContext.on('close', () => this.closed(id));
      } else {
        const bridge = await this.embedded!.open(id);
        this.embeddedClose = bridge.close;
        abort.signal.throwIfAborted();
        this.embeddedAttachment = new EmbeddedBrowserAttachment(bridge, this.backend, () =>
          this.closed(id)
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
    this.status = 'connected';
    // Restored and person-created pages are never registered or read.
  }

  /** Handoff can keep a new-window page while other chats continue on the same context. */
  usesPageLeases(sessionId?: string): boolean {
    return this.mode === 'new-window' && this.sessions.has(sessionId ?? this.selectedSession);
  }
  async selectTab(id: string, sessionId?: string) {
    return this.session(sessionId).selectTab(id);
  }
  async navigate(url: string, sessionId?: string) {
    return this.session(sessionId).navigate(url);
  }
  async pause(sessionId?: string) {
    return this.session(sessionId).pause();
  }
  async handToPerson(sessionId?: string): Promise<LocalBrowserState> {
    const session = this.session(sessionId);
    await session.handToPerson();
    if (this.mode === 'embedded') {
      await this.embeddedAttachment!.detach();
      this.browser = undefined;
      this.registry.close();
    }
    return session.state();
  }
  async resume(sessionId?: string): Promise<LocalBrowserState> {
    if (this.mode === 'embedded' && !this.browser && this.embeddedAttachment) {
      this.browser = await this.embeddedAttachment.resume();
      const id = sessionId ?? this.selectedSession;
      const prior = this.sessions.get(id)!;
      const page = this.contexts()[0]?.pages()[0];
      if (!page)
        throw new LocalBrowserError('tab_gone', 'That tab closed. Open the browser again.');
      this.registry.track(page);
      this.registry.broker.bind(page, prior.principal);
      const session = this.createSession(id, prior.principal, 'embedded');
      this.sessions.set(id, session);
      return session.state();
    }
    return this.session(sessionId).resume();
  }

  /** Stop a handed-off page without returning it to any agent. */
  async abandon(sessionId: string): Promise<void> {
    await this.sessions.get(sessionId)?.closeSignIn();
    this.sessions.get(sessionId)?.abandon();
  }

  /** A scoped Disconnect ends only that chat; an omitted scope closes the physical connection. */
  async disconnect(sessionId?: string): Promise<LocalBrowserState> {
    this.tabRequests.cancel(sessionId);
    if (sessionId === undefined || this.mode === 'embedded') return this.closeConnection(true);
    if (this.opening && this.openingSession === sessionId) this.openingAbort?.abort();
    const session = this.sessions.get(sessionId);
    if (!session) return this.state(sessionId);
    if (session.held) await session.closeSignIn();
    if (!this.closingSessions.has(sessionId)) {
      const pages = this.registry.broker
        .chatRecords()
        .filter((record) => record.ownerId === session.principal.ownerId)
        .map((record) => this.registry.pages.get(record.pageId)!);
      session.abandon();
      session.closed();
      const operation = Promise.all(pages.map((page) => page.close())).then(() => {
        this.closingSessions.delete(sessionId);
      });
      this.closingSessions.set(sessionId, operation);
      void operation.catch(() => undefined);
    }
    await responseDeadline(this.closingSessions.get(sessionId)!, CLOSE_RESPONSE_TIMEOUT_MS, () =>
      closingError(false)
    );
    return this.state(sessionId);
  }

  private async closeConnection(abortSetup: boolean, closed = false): Promise<LocalBrowserState> {
    if (abortSetup) this.openingAbort?.abort();
    if (!this.closing) {
      this.tabRequests.cancel();
      this.preparation.clear();
      this.lifecycle++;
      for (const session of this.sessions.values()) {
        if (session.busy) this.retiredSessions.add(session);
        session.closed();
      }
      const acquisition = this.acquisition;
      const closing = Promise.resolve().then(async () => {
        await acquisition?.catch(() => undefined);
        await Promise.all([
          this.browser && closeBrowserConnection(this.browser),
          this.ownedContext?.close(),
          this.embeddedClose?.(),
        ]);
        this.ownedContext = undefined;
        this.browser = undefined;
        this.embeddedClose = undefined;
        this.embeddedAttachment = undefined;
        this.registry.close();
        if (!closed) {
          this.connectionId = this.selectedSession = this.mode = null;
          this.status = 'disconnected';
          this.sessions.clear();
        }
      });
      this.closing = closing;
      void closing
        .then(() => {
          if (this.closing === closing) this.closing = undefined;
        })
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

  private closed(id: string): void {
    if (this.connectionId !== id) return;
    this.status = 'closed';
    for (const session of this.sessions.values()) session.closed();
    this.registry.close();
    this.handover.windowClosed();
    if (!this.closing) void this.closeConnection(false, true).catch(() => undefined);
  }
  private createSession(
    id: string | null,
    principal: BrowserChatSession['principal'],
    mode: LocalBrowserMode
  ): BrowserChatSession {
    return new BrowserChatSession(id, principal, {
      broker: this.registry.broker,
      pages: this.registry.pages,
      connectionId: this.connectionId!,
      mode,
      windowPolicy: async (id, held) => this.registry.windows.get(id)?.setHeld(held),
      audit: this.audit,
      cloudOrigins: this.cloudOrigins,
      appOrigins: this.appOrigins,
      assertAvailable: () => this.assertAvailable(),
      assertMayAct: () => this.handover.requireAgentMayAct(),
    });
  }
  private contexts(): BrowserContext[] {
    return this.ownedContext ? [this.ownedContext] : (this.browser?.contexts() ?? []);
  }
  private session(sessionId?: string): BrowserChatSession {
    this.assertAvailable();
    const key = sessionId === undefined ? this.selectedSession : sessionId;
    if (key) this.tabRequests.assertAgent(key);
    const session = this.sessions.get(key);
    if (!session)
      throw new LocalBrowserError(
        'not_opened',
        'Ask the person to open this chat’s Agent browser.'
      );
    return session;
  }
  private assertAvailable(): void {
    if (this.closing) throw closingError(this.closingFailed);
    this.registry.assertAvailable();
  }
}
