/**
 * Which view the Remote Access dialog shows.
 *
 * Pure types/functions — no React, no side effects. What remote access is
 * DOING now lives in `@/layers/entities/tunnel`, shared with the Control Center
 * row and the beacon (DOR-1743); what is left here is the dialog's own
 * question, which no other surface asks.
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

import type { TunnelState } from '@/layers/entities/tunnel';

/** UI view selected by the dialog based on tunnel + setup state. */
export type ViewState = 'landing' | 'setup' | 'ready' | 'connecting' | 'connected' | 'error';

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
 * @param tunnelState - Where remote access currently is
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
