import type { Page } from 'playwright-core';
import { captureAgentPage } from './agent-page-handle.js';
import { captureBrokerSource } from './broker-source.js';
import type { LocalBrowserPageSession } from './page-session.js';
import type { BrowserPageState } from './page-state.js';
import type { BrowserPageRuntime } from './page-runtime.js';
import type { BrowserLeaseJournal } from './lease-journal.js';

interface PageIdentity {
  lifecycle: number;
  status: string;
  sessionId: string | null;
  connectionId: string | null;
}

/** Agent and owner handles capture this exact Page without resolving another session. */
export class BrowserPageHandles {
  constructor(
    private readonly session: LocalBrowserPageSession,
    private readonly state: BrowserPageState,
    private readonly runtime: BrowserPageRuntime,
    private readonly journal: () => BrowserLeaseJournal,
    private readonly identity: () => PageIdentity,
    private readonly assertAvailable: () => void
  ) {}

  /** Only this connection’s exact held Page may be brought back to the person. */
  restorePersonFocus(page: Page): void {
    if (
      this.identity().status !== 'connected' ||
      !this.session.personHeld() ||
      page.isClosed() ||
      this.state.tabs.get(this.state.selectedTabId ?? '') !== page
    )
      return;
    try {
      this.assertAvailable();
    } catch {
      // A close in progress keeps its reservation without starting new protocol work.
      return;
    }
    void this.runtime.work.track(page.bringToFront()).catch(() => undefined);
  }

  recordOpen(agentId: string | null, profileId: string | null, page: Page): Promise<void> {
    const identity = this.identity();
    return this.journal().open(
      {
        sessionId: identity.sessionId,
        connectionId: identity.connectionId!,
        agentId,
        profileId,
        leaseId: this.state.selectedTabId!,
      },
      page
    );
  }

  agent(sessionId: string | null) {
    return captureAgentPage(this.session, () => ({
      ...this.identity(),
      sessionId,
      epoch: this.runtime.custody.epoch,
      page: this.state.tabs.get(this.state.selectedTabId ?? ''),
    }));
  }

  viewer() {
    this.assertAvailable();
    return captureBrokerSource(
      this.session,
      this.state,
      this.runtime.custody,
      this.runtime.work,
      this.journal(),
      this.identity
    );
  }
}
