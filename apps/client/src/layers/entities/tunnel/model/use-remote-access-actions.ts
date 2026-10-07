/**
 * Turning remote access on and off — the ONE implementation.
 *
 * Three surfaces flip this switch (the Remote Access dialog, the Control Center
 * row, the ⌘K palette) and all three call these functions. Anything else would
 * be a second copy of the 409 handling, the exposure guard and the toast
 * suppression, and two copies of a rule are two rules.
 *
 * @module entities/tunnel/model/use-remote-access-actions
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { RemoteAccessMode } from '@dorkos/shared/config-schema';
import type { RemoteAccessReport } from '@dorkos/shared/types';
import { useTransport } from '@/layers/shared/model';
import { requestOwnerSetup } from '@/layers/shared/lib';
import { configKeys } from '@/layers/entities/config';
import { broadcastTunnelChange } from './use-tunnel-sync';
import { useRemoteAccessStore } from './remote-access-store';
import { isManagedReport, remoteAccessKeys } from './remote-access-report';

/**
 * Which mode a switch turned ON should use.
 *
 * Managed when it is already selected, or when nothing is selected and this
 * computer is approved for it: approval was the person's explicit choice. In
 * every other case, the person's own ngrok tunnel, exactly as before. Never
 * BYO merely because managed access has no ngrok token.
 */
function startTarget(report: RemoteAccessReport | null): 'byo' | 'managed' {
  if (!report) return 'byo';
  if (report.mode === 'managed') return 'managed';
  if (report.mode === 'off' && report.enrolment.status === 'enrolled') return 'managed';
  return 'byo';
}

/** The sentence a refusal carries, or a fallback when it carries none. */
function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Stable handlers returned by {@link useRemoteAccessActions}. */
export interface RemoteAccessActionHandlers {
  /** Open the tunnel. Resolves once the attempt has settled, however it settled. */
  start: () => Promise<void>;
  /** Close the tunnel. */
  stop: () => Promise<void>;
  /** Flip it, the shape a `<Switch>` hands you. */
  toggle: (on: boolean) => Promise<void>;
  /** Forget a failure that something else has answered. */
  clearError: () => void;
  /**
   * Select how this computer is reachable (DOR-2086). Rejects with the
   * server's sentence, for the caller to show beside the choice.
   */
  chooseMode: (mode: RemoteAccessMode) => Promise<void>;
  /** Start managed setup: get a code to approve on the person's DorkOS account. Rejects on refusal. */
  enrol: () => Promise<void>;
  /** Close the managed tunnel now; the address reopens it when used. Rejects on refusal. */
  closeNow: () => Promise<void>;
  /** Remove managed access from this computer, or cancel a pending setup. Rejects on refusal. */
  withdraw: () => Promise<void>;
}

/**
 * The start/stop handlers for remote access.
 *
 * @returns Stable {@link RemoteAccessActionHandlers}.
 */
export function useRemoteAccessActions(): RemoteAccessActionHandlers {
  const transport = useTransport();
  const queryClient = useQueryClient();

  // Ref so the exposure-guard retry (`onComplete`) can re-invoke the latest
  // start closure without making the callback depend on itself.
  const startRef = useRef<() => Promise<void>>(undefined);

  /**
   * Take a report a write answered with, and tell every other reader.
   *
   * A transport that resolves no report (the Dev Playground's) is not news:
   * the refetch below asks again.
   */
  const settleReport = useCallback(
    (report: RemoteAccessReport | null | undefined) => {
      if (report && typeof report === 'object') {
        useRemoteAccessStore.getState().applyRemoteReport(report, Date.now());
        queryClient.setQueryData(remoteAccessKeys.report(), report);
      }
      queryClient.invalidateQueries({ queryKey: remoteAccessKeys.all });
      queryClient.invalidateQueries({ queryKey: configKeys.all });
      broadcastTunnelChange();
    },
    [queryClient]
  );

  // One clock, and it belongs to the request. An earlier version armed a 15s
  // timer of its own over a call the transport already times out at 30s, so a
  // start that took longer than 15s showed "Tunnel timed out after 15 seconds"
  // while the request was still in flight — and then flipped the very same
  // dialog to connected when it succeeded at, say, 20s (DOR-1739). The
  // transport's timeout is the honest answer, so it is the only one anything
  // here hears.
  const start = useCallback(async () => {
    const managed = startTarget(useRemoteAccessStore.getState().report) === 'managed';
    useRemoteAccessStore.getState().beginStart();
    try {
      if (managed) {
        // Selecting managed access opens nothing here: DorkOS opens the tunnel
        // when the address is used. The report says where it stands.
        settleReport(await transport.setRemoteAccessMode('managed'));
        return;
      }
      const result = await transport.startTunnel();
      useRemoteAccessStore.getState().settleStart(result.url);
      queryClient.invalidateQueries({ queryKey: configKeys.all });
      broadcastTunnelChange();
    } catch (err) {
      const refusal = err as { code?: string; status?: number; body?: { url?: string | null } };

      // Exposing an unprotected instance is blocked (409). Route the person
      // into owner-account creation, then retry the start once login is on.
      if (refusal.code === 'AUTH_REQUIRED_FOR_EXPOSURE') {
        useRemoteAccessStore.getState().abandonStart();
        requestOwnerSetup({
          reason: 'exposure',
          message: 'Remote access needs a login.',
          onComplete: () => void startRef.current?.(),
        });
        return;
      }

      // The route's OTHER 409 is "Tunnel is already running", and it is not a
      // failure — it is the answer converging on a tunnel that is up. Painting
      // an error over a live tunnel is how a person ends up turning off working
      // remote access to fix it. Reachable for real now that ngrok reconnects
      // are reported (DOR-1738): a start pressed during one is a no-op.
      // Managed access has no such refusal; a 409 there is an ordinary failure.
      if (!managed && refusal.status === 409) {
        useRemoteAccessStore.getState().convergeStart(refusal.body?.url ?? null);
        queryClient.invalidateQueries({ queryKey: configKeys.all });
        broadcastTunnelChange();
        return;
      }

      useRemoteAccessStore
        .getState()
        .failStart(err instanceof Error ? err.message : 'Couldn’t open your link. Try again.');
    }
  }, [transport, queryClient, settleReport]);

  // Keep the retry ref pointing at the latest closure (the exposure retry fires
  // long after render, once owner setup completes).
  useEffect(() => {
    startRef.current = start;
  }, [start]);

  const stop = useCallback(async () => {
    const managed = isManagedReport(useRemoteAccessStore.getState().report);
    useRemoteAccessStore.getState().beginStop();
    try {
      if (managed) {
        // Off means off: the address stops reaching this computer, not just
        // the tunnel closing until the next visit.
        settleReport(await transport.setRemoteAccessMode('off'));
        return;
      }
      await transport.stopTunnel();
      useRemoteAccessStore.getState().settleStop();
      queryClient.invalidateQueries({ queryKey: configKeys.all });
      broadcastTunnelChange();
    } catch (err) {
      useRemoteAccessStore
        .getState()
        .failStop(
          err instanceof Error
            ? err.message
            : 'Couldn’t close your link. DorkOS can’t tell if it’s still on.'
        );
    }
  }, [transport, queryClient, settleReport]);

  const toggle = useCallback(
    async (on: boolean) => {
      if (on) await start();
      else await stop();
    },
    [start, stop]
  );

  const clearError = useCallback(() => {
    useRemoteAccessStore.getState().clearError();
  }, []);

  // The managed-only writes. Each rejects with the server's sentence so the
  // Settings control that asked can say it in place; none of them touches the
  // shared `error`, which belongs to the switch.
  const chooseMode = useCallback(
    async (mode: RemoteAccessMode) => {
      try {
        settleReport(await transport.setRemoteAccessMode(mode));
      } catch (err) {
        throw new Error(messageOf(err, 'Couldn’t change remote access. Try again.'), {
          cause: err,
        });
      }
    },
    [transport, settleReport]
  );

  const enrol = useCallback(async () => {
    try {
      settleReport(await transport.startRemoteEnrolment());
    } catch (err) {
      throw new Error(messageOf(err, 'Couldn’t start setup. Try again.'), { cause: err });
    }
  }, [transport, settleReport]);

  const closeNow = useCallback(async () => {
    try {
      settleReport(await transport.closeRemoteAccess());
    } catch (err) {
      throw new Error(messageOf(err, 'Couldn’t close the tunnel. Try again.'), { cause: err });
    }
  }, [transport, settleReport]);

  const withdraw = useCallback(async () => {
    try {
      settleReport(await transport.withdrawRemoteAccess());
    } catch (err) {
      throw new Error(messageOf(err, 'Couldn’t remove access. Try again.'), { cause: err });
    }
  }, [transport, settleReport]);

  // The OBJECT is memoized, not just the callbacks in it. Two consumers put this
  // straight into a dependency array — `useTunnelActions` and the palette's
  // dispatcher — and a fresh literal every render would defeat their `useCallback`s
  // as surely as an unstable callback would.
  return useMemo(
    () => ({ start, stop, toggle, clearError, chooseMode, enrol, closeNow, withdraw }),
    [start, stop, toggle, clearError, chooseMode, enrol, closeNow, withdraw]
  );
}
