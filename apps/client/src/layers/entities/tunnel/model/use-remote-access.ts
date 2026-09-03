/**
 * What remote access is doing, for any surface that needs to know.
 *
 * The read half of the shared model (DOR-1743), in two grades:
 *
 * - {@link useRemoteAccess} — reads the shared `useConfig` query, feeds the
 *   server's report into the store, and hands back the whole picture. This is
 *   the one to use in anything that draws remote access.
 * - {@link useRemoteAccessSnapshot} — reads the STORE alone, with no query and
 *   so no transport. For a caller that has to answer "is a tunnel up?" without
 *   taking a data dependency on it: ⌘K's corpus, which is assembled on every
 *   keystroke and mounted in shells that have no tunnel at all.
 *
 * Call either from as many places as you like. The server's report arrives
 * through one shared query and the reduction behind it is change-gated inside
 * {@link useRemoteAccessStore}, so a second caller costs a subscription and
 * nothing else — no second poll, and no second opinion about what is running.
 *
 * @module entities/tunnel/model/use-remote-access
 */

import { useEffect } from 'react';
import { useConfig } from '@/layers/entities/config';
import { tunnelHost } from '../lib/tunnel-host';
import { readTunnelReport, type TunnelReport } from './tunnel-report';
import { useRemoteAccessStore, type TunnelState } from './remote-access-store';

/** Remote access as the shared store holds it — no server read involved. */
export interface RemoteAccessSnapshot {
  /** Where the tunnel is, as the app understands it right now. */
  state: TunnelState;
  /** The public URL, or `null` when there is not one to show. */
  url: string | null;
  /** The same address without its scheme — what a person reads in passing. */
  host: string | null;
  /** Why the last start or stop failed, or `null`. */
  error: string | null;
  /** Whether an ngrok auth token is saved on the server — the one-time setup. */
  tokenConfigured: boolean;
  /**
   * Whether the server has actually told us anything yet.
   *
   * Before it has, every field above is a PLACEHOLDER and not a fact: `off` is
   * what "we have not asked yet" looks like, and a reader that cannot tell the
   * two apart mistakes the first real answer for a change. That mistake has
   * been made twice here — a toast announcing "Remote access is on" about a
   * tunnel that had been on all along, and a beacon rippling at page load for
   * the same reason.
   */
  hasServerReport: boolean;
  /**
   * True while a start or stop the person asked for is still in flight.
   *
   * `reconnecting` is deliberately NOT one of these: it would disable the very
   * switch a person needs in order to turn remote access off while ngrok keeps
   * retrying.
   */
  isTransitioning: boolean;
  /** Whether a switch bound to remote access should read ON. */
  isChecked: boolean;
  /**
   * Whether remote access is doing anything worth putting in the app chrome —
   * the beacon's whole visibility rule. Off and failed both draw nothing: a
   * feature nobody is using earns no permanent pixels.
   *
   * `stopping` counts, and that is not a technicality. Without it the beacon —
   * and the flyout the person is standing in — would vanish the instant they
   * pressed its off switch, before the request settled, and would flicker back
   * if the stop was refused. It stays until the answer arrives.
   */
  isLive: boolean;
}

/** The snapshot, plus what only the server read can answer. */
export interface RemoteAccess extends RemoteAccessSnapshot {
  /** The server's tunnel block, or `undefined` while the config read is in flight. */
  tunnel: TunnelReport | undefined;
}

/**
 * Subscribe to the shared picture of remote access, without asking the server
 * for it.
 *
 * The store is kept current by {@link useTunnelSync}, which the app shell mounts
 * once, and by every surface that calls {@link useRemoteAccess}. A shell that
 * mounts neither — the Obsidian embed — leaves this at its initial state, which
 * reads as "not set up, nothing running": the honest answer there, since the
 * embed has no tunnel.
 *
 * @returns What the store holds right now.
 */
export function useRemoteAccessSnapshot(): RemoteAccessSnapshot {
  const state = useRemoteAccessStore((s) => s.state);
  const url = useRemoteAccessStore((s) => s.url);
  const error = useRemoteAccessStore((s) => s.error);
  const tokenConfigured = useRemoteAccessStore((s) => s.tokenConfigured);
  const hasServerReport = useRemoteAccessStore((s) => s.lastReport !== null);

  const isTransitioning = state === 'starting' || state === 'stopping';

  return {
    state,
    url,
    host: tunnelHost(url),
    error,
    tokenConfigured,
    hasServerReport,
    isTransitioning,
    // Reconnecting counts as ON — the listener is open and the person did not
    // turn anything off.
    isChecked: isTransitioning || state === 'connected' || state === 'reconnecting',
    isLive: isTransitioning || state === 'connected' || state === 'reconnecting',
  };
}

/**
 * Feed the server's latest report into the shared store.
 *
 * Idempotent: the change gate lives in the store, so however many callers run
 * this, one report is reduced once. Exported within the slice so the app
 * shell's own sync hook can guarantee the store is current even on a route
 * where nothing draws remote access.
 *
 * **Nothing is reduced until the config read has actually ANSWERED.** An
 * unanswered query reads as `off`, and applying that would put a placeholder in
 * the store dressed as a fact — which is precisely what makes the next, real
 * answer look like a change. The store already starts at `off`, so waiting
 * costs nothing and buys `hasServerReport` its meaning.
 *
 * @returns The raw server block.
 * @internal
 */
export function useRemoteAccessReducer(): { tunnel: TunnelReport | undefined } {
  // The shared config read, not a second one of its own. An observer that
  // spells this query by hand also picks its own `staleTime`, and observers on
  // one key do not average theirs — the tightest wins and the rest describe a
  // behaviour nobody gets.
  const { data: serverConfig } = useConfig();
  const tunnel = serverConfig?.tunnel;

  // Read once, at render, into primitives. The effects below depend on THESE
  // rather than on `tunnel` — an object identity that changes on every refetch
  // — so each re-runs exactly when its answer changed and not when the query
  // merely spoke again.
  const { status: reportedStatus, url: reportedUrl } = readTunnelReport(tunnel);
  const tokenConfigured = !!tunnel?.tokenConfigured;
  const answered = serverConfig !== undefined;

  const applyServerReport = useRemoteAccessStore((s) => s.applyServerReport);
  const noteTokenConfigured = useRemoteAccessStore((s) => s.noteTokenConfigured);

  useEffect(() => {
    if (!answered) return;
    applyServerReport(reportedStatus, reportedUrl);
  }, [answered, applyServerReport, reportedStatus, reportedUrl]);

  useEffect(() => {
    if (!answered) return;
    noteTokenConfigured(tokenConfigured);
  }, [answered, noteTokenConfigured, tokenConfigured]);

  return { tunnel };
}

/**
 * Subscribe to remote access, and keep the shared picture current from the
 * server's own report.
 *
 * @returns The reduced state, ready to render.
 */
export function useRemoteAccess(): RemoteAccess {
  const { tunnel } = useRemoteAccessReducer();
  const snapshot = useRemoteAccessSnapshot();
  return { ...snapshot, tunnel };
}
