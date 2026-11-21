import type { Page } from 'playwright-core';
import { LocalBrowserError } from '../errors.js';
import type { LocalBrowserPageSession } from './page-session.js';
import type { LocalBrowserAction } from '@dorkos/shared/local-browser';

/** Narrow server-only handle; no browser launch, page selection or person control escapes. */
export function agentPageHandle(session: LocalBrowserPageSession, assertCurrent: () => void) {
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertCurrent();
    const result = await operation();
    assertCurrent();
    return result;
  };
  assertCurrent();
  return {
    assertCurrent,
    runOperation: <T>(effect: boolean, operation: () => Promise<T>) =>
      session.runAgentOperation(effect, () => run(operation)),
    handover: session.handover,
    requireProfileAccess: (id: string) => run(() => session.requireProfileAccess(id)),
    requireNotFullScreen: () => run(() => session.requireNotFullScreen()),
    agentState: () => run(() => session.agentState()),
    observe: () => run(() => session.observe()),
    screenshot: () => run(() => session.screenshot()),
    action: (input: LocalBrowserAction) => run(() => session.action(input)),
  };
}

/** Captured identity never follows a chat onto its replacement Page. */
export function captureAgentPage(
  session: LocalBrowserPageSession,
  identity: () => {
    lifecycle: number;
    epoch: number;
    page?: Page;
    status: string;
    sessionId: string | null;
  }
) {
  const captured = identity();
  return agentPageHandle(session, () => {
    session.assertAuthorityCurrent();
    const current = identity();
    if (captured.sessionId && session.handover.isOpenFor(captured.sessionId)) return;
    if (current.status === 'closed' || captured.page?.isClosed())
      throw new LocalBrowserError('tab_gone', 'This chat’s browser tab closed. Open it again.');
    if (
      captured.lifecycle !== current.lifecycle ||
      captured.epoch !== current.epoch ||
      captured.page !== current.page
    )
      throw new LocalBrowserError('stale_page', 'The page changed. Read it again before acting.');
    if (!captured.page || current.status !== 'connected')
      throw new LocalBrowserError(
        'not_opened',
        'This chat’s browser is not open. Ask the person to open it.'
      );
  });
}
