import type { Page } from 'playwright-core';
import type { LocalBrowserPageSession } from './page-session.js';
import type { BrowserPageState } from './page-state.js';
import type { BrowserPageCustody } from './page-custody.js';
import type { BrowserPageWork } from './page-work.js';
import type { BrowserLeaseJournal } from './lease-journal.js';
import type { BrowserPageBinding, BrowserPageFacts } from './broker-contract.js';
import { LocalBrowserError } from '../errors.js';

/** Trusted adapter inside the host; raw Page identity never crosses the public broker port. */
export interface BrowserBrokerSource {
  readonly binding: BrowserPageBinding;
  readonly page: Page;
  readonly custody: BrowserPageCustody;
  readonly work: BrowserPageWork;
  isCurrent(): boolean;
  facts(): BrowserPageFacts;
  onChange(listener: () => void): () => void;
  authorize(): Promise<void>;
  hold(): Promise<unknown>;
  resume(): Promise<unknown>;
  recordInput(kind: string): Promise<void>;
}

/** Capture exactly once; no target lookup, URL adoption or later chat re-resolution. */
export function captureBrokerSource(
  session: LocalBrowserPageSession,
  state: BrowserPageState,
  custody: BrowserPageCustody,
  work: BrowserPageWork,
  journal: BrowserLeaseJournal,
  identity: () => { sessionId: string | null; connectionId: string | null; lifecycle: number }
): BrowserBrokerSource {
  const captured = identity();
  const tabId = state.selectedTabId;
  const page = state.tabs.get(tabId ?? '');
  const connection = session.pageConnection();
  if (
    !session.hasLivePage() ||
    !page ||
    !tabId ||
    !captured.sessionId ||
    !captured.connectionId ||
    !connection?.generation
  )
    throw new LocalBrowserError(
      'not_opened',
      'This chat’s browser is not open. Ask the person to open it.'
    );
  const binding = Object.freeze({
    sessionId: captured.sessionId,
    connectionId: captured.connectionId,
    profileConnectionGeneration: connection.generation,
    profileId: session.currentProfileId(),
    leaseId: tabId,
    tabId,
  });
  return {
    binding,
    facts: () =>
      Object.freeze({
        revision: state.revision,
        navigationGeneration: state.frameChanges,
        controlEpoch: custody.epoch,
      }),
    page,
    custody,
    work,
    isCurrent: () => {
      try {
        session.assertAuthorityCurrent();
      } catch {
        return false;
      }
      return (
        identity().lifecycle === captured.lifecycle &&
        session.pageConnection() === connection &&
        state.selectedTabId === tabId &&
        state.tabs.get(tabId) === page &&
        !page.isClosed() &&
        session.hasLivePage()
      );
    },
    onChange: (listener) => {
      const offPage = state.onChange(listener);
      const offControl = custody.onChange(listener);
      page.on('close', listener);
      return () => {
        offPage();
        offControl();
        page.off('close', listener);
      };
    },
    authorize: () => session.requireProfileAccess(binding.sessionId),
    hold: () => session.handToPerson(),
    resume: () => session.handover.resume(),
    recordInput: (input) => journal.record({ event: 'person-input', actor: 'person', input }),
  };
}
