/**
 * The approvals passkeys on this computer (spec `everything-is-a-space` B4c):
 * the ones pinned (`GET /api/session-relay/passkeys`), adding one, removing
 * one, and removing a damaged passkeys file. Adding asks the server for the
 * approve page to open, opens it in the browser, and the passkey comes back to
 * this computer's own loopback page, not to this window; the list refreshes
 * when the window is focused again.
 *
 * The owner's password goes straight into the request. It rides in a
 * mutation's variables only while the request is out: each mutation is reset
 * the moment it settles and kept for no time after (`gcTime: 0`), so the
 * mutation cache drops it, password and all. Read only at this
 * computer and never over Wi-Fi, where the server refuses every passkey route
 * anyway.
 *
 * @module features/web-access/model/use-approval-passkeys
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  SessionRelayPasskey,
  SessionRelayPasskeyList,
} from '@dorkos/shared/session-relay-link';
import { openExternalWindowLater, type PendingExternalWindow } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { WEB_ACCESS_PASSKEYS_KEY as passkeysKey } from './query-keys';

/** What the passkeys panel reads and does. */
export interface ApprovalPasskeys {
  /** The pinned passkeys; empty until loaded. */
  keys: SessionRelayPasskey[];
  /** Whether the passkeys file is damaged and has to be removed first. */
  damaged: boolean;
  /** Whether a change is on its way. */
  busy: boolean;
  /** Whether the approve page was opened and no new passkey has shown up yet. */
  waiting: boolean;
  /** The last change's failure, in a sentence; `null` when none. */
  error: string | null;
  /** Open the approve page to make a passkey called `label`. Call it in the click. */
  add: (label: string, password: string) => void;
  /** Remove a passkey, with the owner's password. */
  remove: (credentialId: string, password: string) => void;
  /** Remove a damaged passkeys file, with the owner's password. */
  removeDamaged: (password: string) => void;
}

/** The server's own sentence for a refusal, or a plain fallback. */
function sentenceOf(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return message && !/^HTTP \d+$/.test(message) ? message : 'Couldn’t change that. Try again.';
}

/**
 * Read and change the approvals passkeys.
 *
 * @param enabled - Whether to read them: linked, at this computer, not over Wi-Fi.
 */
export function useApprovalPasskeys(enabled: boolean): ApprovalPasskeys {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  // How many passkeys there were when the approve page opened; `null` when not waiting.
  const [waitingFrom, setWaitingFrom] = useState<number | null>(null);

  const list = useQuery({
    queryKey: passkeysKey,
    queryFn: () => transport.listSessionRelayPasskeys(),
    enabled,
    retry: false,
    // The passkey arrives through the browser, so look again on coming back.
    refetchOnWindowFocus: true,
  });
  const keys = list.data?.keys ?? [];

  const start = useMutation({
    mutationFn: async (run: {
      send: () => Promise<{ approveUrl: string }>;
      pending: PendingExternalWindow;
    }) => {
      try {
        const started = await run.send();
        if (!run.pending.go(started.approveUrl)) {
          throw new Error('Couldn’t open your browser. Try again.');
        }
      } catch (failure) {
        run.pending.close();
        throw failure;
      }
    },
    onMutate: () => setError(null),
    onSuccess: () => setWaitingFrom(keys.length),
    // Gone from the mutation cache as soon as it is reset, with its variables.
    gcTime: 0,
    onError: (failure) => setError(sentenceOf(failure)),
  });

  const change = useMutation({
    mutationFn: (run: () => Promise<SessionRelayPasskeyList>) => run(),
    onMutate: () => setError(null),
    onSuccess: (next) => queryClient.setQueryData(passkeysKey, next),
    gcTime: 0,
    onError: (failure) => setError(sentenceOf(failure)),
  });

  // The password is in the variables' closure: drop them once the request settles.
  const forgetStart = { onSettled: () => start.reset() };
  const forgetChange = { onSettled: () => change.reset() };

  return {
    keys,
    damaged: list.data?.damaged === true,
    busy: start.isPending || change.isPending,
    // Done waiting once the list shows a passkey it did not have.
    waiting: waitingFrom !== null && keys.length <= waitingFrom,
    error,
    add: (label, password) => {
      // Opened now, in the click: a window opened after the request is blocked.
      const pending = openExternalWindowLater();
      if (!pending) {
        setError('Allow pop-ups for this page, then try again.');
        return;
      }
      start.mutate(
        {
          send: () => transport.startSessionRelayPasskey({ label, password }),
          pending,
        },
        forgetStart
      );
    },
    remove: (credentialId, password) =>
      change.mutate(
        () => transport.removeSessionRelayPasskey(credentialId, password),
        forgetChange
      ),
    removeDamaged: (password) =>
      change.mutate(() => transport.removeDamagedSessionRelayPasskeys(password), forgetChange),
  };
}
