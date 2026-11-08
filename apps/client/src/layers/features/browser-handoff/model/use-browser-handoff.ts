import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LocalBrowserPersonState } from '@dorkos/shared/local-browser';
import {
  LOCAL_BROWSER_STATE_KEY,
  useLocalBrowserPersonState,
} from '@/layers/entities/local-browser';
import { useTransport } from '@/layers/shared/model';
import { handoffErrorMessage, handoffStep } from '../lib/handoff-step';

/** The one message the agent gets after Hand back. The server's tool told it to wait for this. */
export const HANDED_BACK_MESSAGE = 'I’m done in the browser. Please continue.';

/**
 * The open handoff for one chat, and what its card's buttons do. With no chat
 * named, it follows whichever handoff is open.
 *
 * @param sessionId - The chat showing the card.
 */
export function useBrowserHandoff(sessionId?: string | null) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const { data: state } = useLocalBrowserPersonState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = state?.handoff?.outcome === null ? state.handoff : null;
  const handoff = open && (sessionId == null || open.sessionId === sessionId) ? open : null;

  const run = async (call: () => Promise<LocalBrowserPersonState | void>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await call();
      // An older read must not put back a handoff that has just ended.
      await queryClient.cancelQueries({ queryKey: LOCAL_BROWSER_STATE_KEY });
      if (next) queryClient.setQueryData(LOCAL_BROWSER_STATE_KEY, next);
      return true;
    } catch (cause) {
      setError(handoffErrorMessage(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const selectedTabId = state?.selectedTabId ?? null;
  return {
    handoff,
    step: handoff ? handoffStep(handoff, state?.signIn, state?.status === 'connected') : null,
    canShowWindow: state?.mode === 'new-window' && state.status === 'connected' && !!selectedTabId,
    movesToOwnWindow: state?.mode === 'embedded',
    sharedProfile: handoff?.profileId === null,
    busy,
    error,
    continueAgent: async () => {
      if (!handoff) return;
      if (!(await run(() => transport.handBackLocalBrowser(handoff.id)))) return;
      // The agent ended its turn to wait, so nothing wakes it but a message.
      await transport.postMessage(handoff.sessionId, HANDED_BACK_MESSAGE).catch(() => {
        setError('It has the browser back, but missed the message. Tell it in the chat.');
      });
    },
    signIn: () => {
      if (handoff) void run(() => transport.signInLocalBrowser({ handoffId: handoff.id }));
    },
    openWindow: () => {
      // The server puts it back on the page saved when the agent asked, never one named here.
      if (handoff)
        void run(() =>
          transport.openLocalBrowser({
            mode: 'new-window',
            sessionId: handoff.sessionId,
            ...(handoff.profileId ? { profileId: handoff.profileId } : {}),
          })
        );
    },
    showWindow: () => {
      // A plain browser answer says nothing about the handoff, so nothing is cached from it.
      if (selectedTabId)
        void run(async () => {
          await transport.selectLocalBrowserTab(selectedTabId);
        });
    },
    stopTask: async () => {
      if (!handoff) return;
      if (!(await run(() => transport.stopLocalBrowserHandoff(handoff.id)))) return;
      // The agent should already be waiting. If it isn't, this ends the turn.
      await transport.interruptSession(handoff.sessionId).catch(() => undefined);
    },
  };
}
