import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LocalBrowserPersonState } from '@dorkos/shared/local-browser';
import {
  LOCAL_BROWSER_STATE_KEY,
  useLocalBrowserPersonState,
} from '@/layers/entities/local-browser';
import { useTransport } from '@/layers/shared/model';
import { handoffErrorMessage, handoffStep } from '../lib/handoff-step';

/**
 * The open handoff for one chat, and what its card's buttons do. With no chat
 * named, it follows whichever handoff is open. Once one this window showed ends,
 * `ended` says how, for the card's one-line receipt (DOR-3112).
 *
 * @param sessionId - The chat showing the card.
 */
export function useBrowserHandoff(sessionId?: string | null) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const { data: state } = useLocalBrowserPersonState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The handoff this card showed open. Only that one gets a receipt, so a chat opened
  // later never shows one for a handoff that ended before it was looked at.
  const [shownId, setShownId] = useState<string | null>(null);

  const record = state?.handoff ?? null;
  const ours = record && (sessionId == null || record.sessionId === sessionId) ? record : null;
  const handoff = ours?.outcome === null ? ours : null;
  const ended = ours && ours.outcome !== null && ours.id === shownId ? ours : null;
  const openId = handoff?.id ?? null;
  useEffect(() => {
    if (openId) setShownId(openId);
  }, [openId]);

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
    ended,
    step: handoff
      ? handoffStep(
          handoff,
          state?.signIn,
          state?.status === 'connected',
          state?.mode === 'embedded'
        )
      : null,
    canShowWindow: state?.mode === 'new-window' && state.status === 'connected' && !!selectedTabId,
    sharedProfile: handoff?.profileId === null,
    busy,
    error,
    // The server wakes the agent once the handoff ends, whichever way the person hands
    // it back, so Continue only hands it back (DOR-3112).
    continueAgent: () =>
      handoff ? run(() => transport.handBackLocalBrowser(handoff.id)) : Promise.resolve(false),
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
