import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { LocalBrowserPersonState, LocalBrowserState } from '@dorkos/shared/local-browser';
import { toSession } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import {
  HANDED_BACK_MS,
  browserPillState,
  type BrowserPillState,
  type BrowserStatusPillActions,
} from './browser-pill-state';

/** Options for {@link useBrowserPill}. */
export interface UseBrowserPillOptions {
  /** The person's view of the browser, once read. */
  state: LocalBrowserPersonState | undefined;
  /** The chat showing the pill, or null outside a direct chat. */
  sessionId: string | null;
  /** Run a browser action through the panel, which owns busy and error. */
  action: (run: () => Promise<LocalBrowserState>) => Promise<boolean>;
}

/**
 * The status pill's state and what its buttons do. Hand back shows "Handed back"
 * for a few seconds before the pill says the agent has the page again.
 *
 * @param options - The browser state, the chat, and the panel's action runner.
 */
export function useBrowserPill({ state, sessionId, action }: UseBrowserPillOptions): {
  pill: BrowserPillState | null;
  actions: BrowserStatusPillActions;
} {
  const transport = useTransport();
  const navigate = useNavigate();
  const [handedBackAt, setHandedBackAt] = useState<number | null>(null);
  useEffect(() => {
    if (handedBackAt === null) return;
    const timer = setTimeout(() => setHandedBackAt(null), HANDED_BACK_MS);
    return () => clearTimeout(timer);
  }, [handedBackAt]);
  const pill = state ? browserPillState(state, sessionId, handedBackAt !== null) : null;
  const handBack = (run: () => Promise<LocalBrowserState>) =>
    void action(run).then((ok) => {
      if (ok) setHandedBackAt(Date.now());
    });

  const actions: BrowserStatusPillActions = {
    onTakeOver: () => void action(() => transport.takeOverLocalBrowser()),
    onPause: () => void action(() => transport.pauseLocalBrowser()),
    onResume: () => void action(() => transport.resumeLocalBrowser()),
  };
  if (pill?.kind === 'your-turn') {
    const { handoffId } = pill;
    actions.onHandBack = () => handBack(() => transport.handBackLocalBrowser(handoffId));
    actions.onSeeRequest = () => {
      // The request is the handoff card in this chat's timeline.
      const card = document.querySelector<HTMLElement>('[data-slot="browser-handoff-card"]');
      card?.scrollIntoView({ block: 'nearest' });
      card?.querySelector<HTMLElement>('button')?.focus();
    };
  }
  if (pill?.kind === 'you')
    actions.onHandBack = () => handBack(() => transport.resumeLocalBrowser());
  if (pill?.kind === 'paused-sign-in') {
    const waiting = pill.sessionId;
    actions.onShowSignIn = () => void navigate(toSession({ session: waiting }));
  }
  return { pill, actions };
}
