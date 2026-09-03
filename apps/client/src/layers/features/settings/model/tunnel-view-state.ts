/**
 * State machine types and view-state derivation for the Remote Access tunnel dialog.
 *
 * Pure types/functions — no React, no side effects. The actual state machine
 * lives in `model/use-tunnel-machine.ts`.
 *
 * ## Two timeouts used to live here, and both are gone (DOR-1739)
 *
 * `START_TIMEOUT_MS` (15s) and `STUCK_STATE_TIMEOUT_MS` (30s) each raced the
 * transport's own 30s request timeout, and a race between two clocks over one
 * request is decided by the shorter one — which is not the one holding the
 * answer. The 15s timer showed "Tunnel timed out after 15 seconds" over a start
 * that was still in flight, then flipped the very same dialog to connected when
 * it succeeded at 20s. The 30s one was simply unreachable behind it.
 *
 * Neither came back, because there is nothing left for them to recover: every
 * path into `starting` and `stopping` is an awaited transport call, and every
 * settlement of that call — resolve or reject — sets the next state itself.
 * `HttpTransport` guarantees the settlement, arming `AbortSignal.timeout` on
 * every request. A replacement net could only ever fire while the request it
 * was netting was still running, which is the defect, not the fix.
 *
 * @module features/settings/model/tunnel-view-state
 */

import type { ServerConfig } from '@dorkos/shared/types';

/**
 * Tunnel lifecycle state, as the dialog currently understands it.
 *
 * Not "server-reported", which is what this used to say and is the mistake the
 * whole machine was built on: `starting`, `stopping` and `error` exist only
 * locally and have no server counterpart at all. The server reports connected
 * or not; everything else here is the dialog's own account of what the person
 * just did (`use-tunnel-machine.ts`).
 */
export type TunnelState = 'off' | 'starting' | 'connected' | 'reconnecting' | 'stopping' | 'error';

/** UI view selected by the dialog based on tunnel + setup state. */
export type ViewState = 'landing' | 'setup' | 'ready' | 'connecting' | 'connected' | 'error';

/**
 * What the server says about the tunnel, plus the field DOR-1738 is adding.
 *
 * `isRunning` answers "is the listener still open", which is a different
 * question from `connected` ("is it reachable right now"). While ngrok
 * re-establishes a dropped session the first is true and the second is false,
 * and a client that only knows `connected` has to call that OFF.
 *
 * It is declared here rather than on the shared DTO because `schemas.ts` belongs
 * to DOR-1738; this widening disappears when that lands.
 */
export type TunnelReport = NonNullable<ServerConfig['tunnel']> & { isRunning?: boolean };

/** The three states the server's report can put the tunnel in. */
export type ReportedStatus = 'on' | 'reconnecting' | 'off';

/**
 * Read the server's tunnel block into the three states the dialog distinguishes.
 *
 * `reconnecting` needs `isRunning` to be present AND true, so a server that has
 * not shipped the field cannot produce it and every reading against one is
 * exactly what it was before. That is a property of `undefined` being falsy
 * rather than of any fallback written here — an earlier version spelled the
 * default `?? connected`, which reads like it is doing that work but cannot,
 * since `running` is only consulted on the branch where `connected` is already
 * false.
 *
 * @param tunnel - The `tunnel` block of `GET /api/config`, or `undefined` while
 *   the config read is still in flight.
 */
export function readTunnelReport(tunnel: TunnelReport | undefined): {
  status: ReportedStatus;
  url: string | null;
} {
  const connected = tunnel?.connected ?? false;
  const running = tunnel?.isRunning ?? false;
  return {
    status: connected ? 'on' : running ? 'reconnecting' : 'off',
    url: tunnel?.url ?? null,
  };
}

/** Interval between latency probes when the tunnel is connected and dialog is open. */
export const LATENCY_INTERVAL_MS = 30_000;

/**
 * How long a single latency probe may run before it is abandoned.
 *
 * Shorter than {@link LATENCY_INTERVAL_MS} on purpose: a probe that outlived
 * the gap to the next one would let requests to an unreachable tunnel pile up
 * one deep every 30 seconds for as long as the dialog stayed open.
 */
export const LATENCY_PROBE_TIMEOUT_MS = 10_000;

/**
 * Derive which view to show based on tunnel config, state, and user navigation.
 *
 * `reconnecting` deliberately shares the `connected` view. The tunnel is still
 * open — ngrok is re-establishing it — so showing `ready`, with the switch
 * snapped off and the URL gone, would tell the person their remote access had
 * been turned off when it had not (DOR-1738/DOR-1739).
 *
 * @param tokenConfigured - Whether ngrok auth token is saved on the server
 * @param showSetup - Whether the user has explicitly entered the setup view
 * @param tunnelState - Where the dialog currently believes the tunnel is
 * @param hasUrl - Whether a public URL is known. The connected view is built
 *   around that URL and renders nothing without one, so a state that claims to
 *   be up but cannot say where falls back to the connecting view rather than to
 *   an empty dialog.
 */
export function deriveViewState(
  tokenConfigured: boolean,
  showSetup: boolean,
  tunnelState: TunnelState,
  hasUrl: boolean
): ViewState {
  if (!tokenConfigured && !showSetup) return 'landing';
  if (!tokenConfigured && showSetup) return 'setup';
  if (showSetup) return 'setup';
  if (tunnelState === 'error') return 'error';
  if (tunnelState === 'starting') return 'connecting';
  if (tunnelState === 'connected' || tunnelState === 'stopping' || tunnelState === 'reconnecting') {
    return hasUrl ? 'connected' : 'connecting';
  }
  return 'ready';
}
