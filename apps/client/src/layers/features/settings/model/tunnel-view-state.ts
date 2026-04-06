/**
 * State machine types and view-state derivation for the Remote Access tunnel dialog.
 *
 * Pure types/functions — no React, no side effects. The actual state machine
 * lives in `model/use-tunnel-machine.ts`.
 *
 * @module features/settings/model/tunnel-view-state
 */

/** Server-reported tunnel lifecycle state. */
export type TunnelState = 'off' | 'starting' | 'connected' | 'stopping' | 'error';

/** UI view selected by the dialog based on tunnel + setup state. */
export type ViewState = 'landing' | 'setup' | 'ready' | 'connecting' | 'connected' | 'error';

/** Hard timeout for the start-tunnel action before forcing the error view. */
export const START_TIMEOUT_MS = 15_000;

/** Recovery timeout for transitional states stuck in starting/stopping. */
export const STUCK_STATE_TIMEOUT_MS = 30_000;

/** Interval between latency probes when the tunnel is connected and dialog is open. */
export const LATENCY_INTERVAL_MS = 30_000;

/**
 * Derive which view to show based on tunnel config, state, and user navigation.
 *
 * @param tokenConfigured - Whether ngrok auth token is saved on the server
 * @param showSetup - Whether the user has explicitly entered the setup view
 * @param tunnelState - Current server-reported tunnel state
 */
export function deriveViewState(
  tokenConfigured: boolean,
  showSetup: boolean,
  tunnelState: TunnelState
): ViewState {
  if (!tokenConfigured && !showSetup) return 'landing';
  if (!tokenConfigured && showSetup) return 'setup';
  if (showSetup) return 'setup';
  if (tunnelState === 'error') return 'error';
  if (tunnelState === 'starting') return 'connecting';
  if (tunnelState === 'connected' || tunnelState === 'stopping') return 'connected';
  return 'ready';
}
