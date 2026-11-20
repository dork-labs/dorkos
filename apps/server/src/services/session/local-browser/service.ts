/** Profile-owned browsers with chat-scoped Page sessions. */
import type { LocalBrowserOpen } from '@dorkos/shared/local-browser';
import type { CloudOriginEntry } from '@dorkos/shared/cloud-origin';
import type { EmbeddedBrowserPort } from './desktop-bridge.js';
import type { LocalBrowserAuditWriter } from './action-audit.js';
import { LocalBrowserPageSession } from './leases/page-session.js';
import { BrowserProfileConnections } from './leases/profile-connection.js';
import { BrowserHandoverPool } from './leases/handover-pool.js';
import type { BrowserLeaseAuditWriter } from './leases/lease-journal.js';
import { BrowserPageBroker } from './leases/page-broker.js';
import { browserViewerCapabilities } from '../browser-viewers/viewer-capabilities.js';
import { captureViewerPage } from '../browser-viewers/page-binding.js';
import type { ResolveViewerPage } from '../browser-viewers/viewer-contract.js';
import { productionBackend, type LocalBrowserBackend } from './playwright-backend.js';
import {
  emptyBrowserPersonState,
  localBrowserHostFacts,
  type LocalBrowserHostFacts,
} from './presentation.js';
import { cloudOriginsForThisServer } from '../../core/cloud/cloud-api-origin.js';
import { localBrowserAppOrigins } from './app-origins.js';
import { LocalBrowserError } from './errors.js';
import type { BrowserProfileAccessGate } from './profile-access.js';
import { BrowserProfileRemoval } from './profile-removal/index.js';
import { AgentWindowNames } from './agent-window/index.js';
import { BROWSER_PROFILES_FOLDER } from './profile-folders.js';
import path from 'node:path';
export { LocalBrowserError } from './errors.js';
export type { EmbeddedBrowserPort } from './desktop-bridge.js';

/** The existing person controls select a view; agent tools always use leaseFor. */
export class LocalBrowserService {
  private readonly sessions = new Map<string | null, LocalBrowserPageSession>();
  private readonly openingChats = new Set<string | null>();
  private readonly retired = new Set<LocalBrowserPageSession>();
  private stopping = false;
  private readonly connections: BrowserProfileConnections;
  private profileWiring?: Parameters<BrowserProfileAccessGate['use']>;
  readonly handover: BrowserHandoverPool;
  readonly windowNames = new AgentWindowNames();
  readonly pageBroker = new BrowserPageBroker((id) => {
    const session = this.sessions.get(id);
    if (!session)
      throw new LocalBrowserError(
        'not_opened',
        'This chat’s browser is not open. Ask the person to open it.'
      );
    return session.captureViewerPage();
  });
  /** A watch binds the broker's exact captured Page and authenticated owner ingress. */
  readonly viewerPages: { resolve: ResolveViewerPage } = {
    resolve: (chatId, principal, viewerId) =>
      captureViewerPage(this.pageBroker, chatId, principal, viewerId),
  };
  readonly profileRemoval = new BrowserProfileRemoval({
    dataDirectory: () => this.dataDirectory,
    busy: (id) =>
      this.pageSessions().some((session) => session.holdsProfileReservation(id)) ||
      this.connections.holds(
        path.join(this.dataDirectory, BROWSER_PROFILES_FOLDER, id ?? 'default')
      ),
    forgotten: (id) => this.handover.forgetProfileState(id),
    embedded: () => this.embedded,
  });

  constructor(
    private readonly dataDirectory: string,
    private readonly embedded?: EmbeddedBrowserPort,
    private readonly backend: LocalBrowserBackend = productionBackend,
    private readonly audit?: LocalBrowserAuditWriter,
    private readonly hostFacts: () => LocalBrowserHostFacts = localBrowserHostFacts,
    private readonly cloudOrigins: () => readonly CloudOriginEntry[] = cloudOriginsForThisServer,
    private readonly appOrigins: () => readonly string[] = localBrowserAppOrigins,
    private readonly leaseAudit?: BrowserLeaseAuditWriter,
    private agentForSession: (id: string) => Promise<string | undefined> = async () => undefined
  ) {
    this.connections = new BrowserProfileConnections(backend);
    this.handover = new BrowserHandoverPool(this);
    this.createSession(null);
  }

  /** Startup supplies the same runtime/mesh identity authority used for profile access. */
  useSessionAgentLookup(lookup: (id: string) => Promise<string | undefined>): void {
    this.agentForSession = lookup;
  }

  /** Resolve once from the authenticated capability context, never from tool input. */
  leaseFor(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session)
      throw new LocalBrowserError(
        'not_opened',
        'This chat’s browser is not open. Ask the person to open it.'
      );
    session.handover.refuseStopped(sessionId);
    this.handover.refuseWhileSigningIn(sessionId);
    return session.captureAgentLease(sessionId);
  }

  /** Checks never create a page session or journal for an arbitrary chat id. */
  findSession(sessionId: string | null): LocalBrowserPageSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Explicit owner UI selector for controls on an existing session. */
  personSession(sessionId: string | null): LocalBrowserPageSession {
    const session = this.findSession(sessionId);
    if (!session)
      throw new LocalBrowserError('not_opened', 'This browser is not open. Open it first.');
    return session;
  }
  async personState(sessionId: string | null) {
    return this.findSession(sessionId)?.handover.state() ?? emptyBrowserPersonState();
  }

  private createSession(sessionId: string | null): LocalBrowserPageSession {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = new LocalBrowserPageSession(
        this.dataDirectory,
        this.embedded,
        this.connections.forChat(
          (folder) => {
            const profile = path.basename(folder);
            const id = profile === 'default' ? null : profile;
            return (
              session!.handover.signInHoldsProfile(id) ||
              this.pageSessions().some(
                (other) => other !== session && other.handover.holdsProfile(id)
              )
            );
          },
          (page) => session!.restorePersonFocus(page)
        ),
        this.audit,
        this.hostFacts,
        this.cloudOrigins,
        this.appOrigins,
        {
          removal: this.profileRemoval,
          names: this.windowNames,
          leaseAudit: this.leaseAudit,
          closed: () => this.retired.delete(session!),
          assertAgentAction: () => {
            this.handover.refuseWhileSigningIn(sessionId);
            if (this.profileSiblings(session!).some((other) => other.personHeld()))
              throw new LocalBrowserError(
                'profile_held',
                'A person is using this browser. Wait until they hand it back.'
              );
          },
          drainProfile: async () => {
            await Promise.all(this.profileSiblings(session!).map((other) => other.drainPageWork()));
          },
          agentId: () =>
            sessionId === null ? Promise.resolve(undefined) : this.agentForSession(sessionId),
        }
      );
      session.requireExclusiveProfile = (requested) => {
        const id = requested === undefined ? session!.currentProfileId() : requested;
        if (
          this.pageSessions().some((other) => other !== session && other.handover.holdsProfile(id))
        )
          throw new LocalBrowserError(
            'profile_busy',
            'This browser is busy. Ask the person to finish using it.'
          );
        this.connections.assertAvailable(
          path.join(this.dataDirectory, BROWSER_PROFILES_FOLDER, id ?? 'default'),
          session!.pageConnection()
        );
      };
      if (this.profileWiring) session.useProfileAccess(...this.profileWiring);
      this.sessions.set(sessionId, session);
      this.handover?.configure(session.handover);
    }
    return session;
  }

  /** Host-only entries for global lifecycle and single-handoff arbitration, without page reads. */
  pageSessions(): readonly LocalBrowserPageSession[] {
    return [...this.sessions.values(), ...this.retired];
  }
  private profileSiblings(session: LocalBrowserPageSession): LocalBrowserPageSession[] {
    return this.pageSessions().filter(
      (other) => other !== session && other.currentProfileId() === session.currentProfileId()
    );
  }

  /** Reserve before delegating, including awaits inside handoff preparation. */
  private async opening(input: LocalBrowserOpen, person: boolean) {
    if (this.stopping)
      throw new LocalBrowserError('closing', 'The browser is closing. Wait a moment.');
    const id = input.sessionId ?? null;
    if (this.openingChats.has(id))
      throw new LocalBrowserError('busy', 'The browser is starting. Wait a moment.');
    const session = this.findSession(id);
    const live = this.pageSessions().filter(
      (entry) => entry !== this.findSession(null) && entry.hasPageReservation()
    ).length;
    const pending = [...this.openingChats].filter(
      (chat) => chat !== null && !this.findSession(chat)?.hasPageReservation()
    ).length;
    if (id !== null && !session?.hasPageReservation() && live + pending >= 6)
      throw new LocalBrowserError(
        'tab_limit',
        'This browser is busy. Try again after a page closes.'
      );
    this.openingChats.add(id);
    try {
      const target = session ?? this.createSession(id);
      return await (person ? target.handover.open(input) : target.open(input));
    } finally {
      this.openingChats.delete(id);
    }
  }

  open(input: LocalBrowserOpen) {
    return this.opening(input, false);
  }
  openForPerson(input: LocalBrowserOpen) {
    return this.opening(input, true);
  }

  useProfileAccess(...wiring: Parameters<BrowserProfileAccessGate['use']>): void {
    this.profileWiring = wiring;
    for (const session of this.sessions.values()) session.useProfileAccess(...wiring);
  }
  capabilities() {
    return browserViewerCapabilities(Boolean(this.embedded), this.hostFacts());
  }
  /** Called synchronously by the authoritative binding mutation, before it returns. */
  async revokeProfileAccess(profileId: string, agentId?: string): Promise<void> {
    await Promise.all(
      this.pageSessions()
        .filter((session) => session.matchesProfileGrant(profileId, agentId))
        .map((session) => session.revoke())
    );
  }
  /** Runtime removal is distinct from a turn ending or an in-memory eviction. */
  async sessionRemoved(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.retired.add(session);
    try {
      await session.revoke();
    } finally {
      if (!session.hasPageReservation()) this.retired.delete(session);
    }
  }

  /** Host shutdown revokes every lease and attempts every physical profile, including unowned pages. */
  async closeAll(): Promise<void> {
    this.stopping = true;
    const results = await Promise.allSettled([
      ...this.pageSessions().map((session) => session.disconnect()),
      this.connections.closeAll(),
    ]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
