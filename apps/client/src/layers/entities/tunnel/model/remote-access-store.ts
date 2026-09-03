/**
 * The one place the app's picture of remote access lives.
 *
 * ## Why this is a store and not a hook's state (DOR-1743)
 *
 * Remote access used to be understood by exactly one component — the Remote
 * Access dialog — so its state machine lived in that dialog's hook. It now has
 * three surfaces: the dialog, the Control Center row, and the top-bar beacon.
 * Three copies of a `useState` machine would each start a tunnel the other two
 * did not know about, so the row could sit at "Off" while the beacon breathed.
 * One module-scope store is the fix; every surface subscribes to the same
 * reduction, and an action taken on any of them is visible on all of them
 * before the request even settles.
 *
 * ## The one rule this store exists to keep (inherited from DOR-1739)
 *
 * There are two things that can move the tunnel state, and they are not peers:
 * an ACTION the person took, and a REPORT from the server about what the tunnel
 * is actually doing. An action's outcome is the newest fact in the room, so
 * nothing may overwrite it — a server report gets to speak only when it has
 * genuinely CHANGED. {@link RemoteAccessState.lastReport} is that gate, and it
 * lives here rather than in a hook's ref so that N subscribers cannot each
 * apply the same report N times.
 *
 * Before that gate existed the sync effect pushed every local transition
 * straight back to `off`: a failed start rendered the error view for a single
 * paint before erasing it, so "Try again" was unreachable and every ngrok
 * failure read as "the switch did nothing" (GitHub #1458).
 *
 * @module entities/tunnel/model/remote-access-store
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { ReportedStatus } from './tunnel-report';

/**
 * Remote access as the app currently understands it.
 *
 * Not "server-reported": `starting`, `stopping` and `error` exist only on this
 * side and have no server counterpart at all. The server reports connected or
 * not; everything else here is the app's own account of what the person just
 * did.
 */
export type TunnelState = 'off' | 'starting' | 'connected' | 'reconnecting' | 'stopping' | 'error';

/** The reduced state every remote-access surface reads. */
export interface RemoteAccessState {
  /** Where the tunnel is, as the app understands it right now. */
  state: TunnelState;
  /** The public URL, or `null` when there is not one to show. */
  url: string | null;
  /**
   * Why the last start or stop failed, verbatim from whatever rejected.
   *
   * **It is not cleared by looking at it**, which is a deliberate reversal of
   * the dialog-era behaviour (DOR-1739 cleared every error on the dialog's
   * opening edge). Remote access now has a permanent surface: the Control
   * Center row says "Couldn't start · Fix…", and Fix… opens the dialog to read
   * the full sentence. Clearing on open would empty the dialog the link exists
   * to fill. So a failure is a STATE of remote access and survives until
   * something actually changes it — a new attempt, a saved token, or any
   * change in what the server reports.
   */
  error: string | null;
  /**
   * The last server report this store reduced — the change gate.
   *
   * `null` before the first report has been applied, which is not the same as
   * a report of `off`: without the distinction the first real answer looks like
   * a transition.
   */
  lastReport: { status: ReportedStatus; url: string | null } | null;
  /**
   * Whether the one-time ngrok setup is done, as the server last reported it.
   *
   * Held here as well as on the config DTO so that a reader who must not take a
   * transport dependency — ⌘K's corpus — can still tell "not set up" from "set
   * up and off", which are two different offers.
   */
  tokenConfigured: boolean;
  /**
   * Armed while a change the person asked for is expected, so the announcer
   * does not read their own action back to them as news.
   *
   * Consumed by the first server transition either way, so a stop the server
   * never reports cannot leave the next genuine drop silent.
   */
  userInitiated: boolean;
}

/** Every way the reduced state moves. */
export interface RemoteAccessActions {
  /**
   * Reduce a fresh server report — and only a FRESH one.
   *
   * @param status - What the server's tunnel block says.
   * @param url - The public URL it names, or `null`.
   */
  applyServerReport: (status: ReportedStatus, url: string | null) => void;
  /** Record whether the one-time ngrok setup is done. */
  noteTokenConfigured: (configured: boolean) => void;
  /** A start the person asked for is in flight. */
  beginStart: () => void;
  /** The start succeeded and named an address. */
  settleStart: (url: string) => void;
  /**
   * The start was refused because a tunnel is ALREADY running (409).
   *
   * Not a failure — it is the answer converging on a tunnel that is up. With a
   * URL it settles straight into `connected`; without one the tunnel is up but
   * unreachable, which is exactly `reconnecting`.
   *
   * @param url - The live URL the refusal carried, or `null` when it named none.
   */
  convergeStart: (url: string | null) => void;
  /** The start failed for a reason worth showing. */
  failStart: (message: string) => void;
  /**
   * The start was blocked pending owner setup, so nothing is in flight and
   * nothing failed — the person has been handed a different task.
   */
  abandonStart: () => void;
  /** A stop the person asked for is in flight. */
  beginStop: () => void;
  /** The stop succeeded. */
  settleStop: () => void;
  /** The stop failed; the tunnel is still up. */
  failStop: (message: string) => void;
  /**
   * Forget a failure that has been answered by something else — saving a token
   * answers the most common reason a start failed.
   */
  clearError: () => void;
  /**
   * Read and disarm the suppression flag in one step.
   *
   * @returns `true` when the transition about to be announced is one the person
   *   asked for, and so should stay quiet.
   */
  consumeSuppression: () => boolean;
  /** Back to a fresh app's understanding. Tests only. */
  reset: () => void;
}

/** A fresh app's understanding of remote access: nothing known, nothing running. */
const INITIAL: RemoteAccessState = {
  state: 'off',
  url: null,
  error: null,
  lastReport: null,
  tokenConfigured: false,
  userInitiated: false,
};

/**
 * The remote-access store.
 *
 * Subscribe through {@link useRemoteAccess} rather than reading this directly —
 * that hook is what feeds the server's report in, and a component that
 * subscribes here alone would render a state nobody was updating.
 */
export const useRemoteAccessStore = create<RemoteAccessState & RemoteAccessActions>()(
  devtools(
    (set, get) => ({
      ...INITIAL,

      applyServerReport: (status, url) => {
        const previous = get().lastReport;
        if (previous && previous.status === status && previous.url === url) return;

        if (status === 'on' && url) {
          set({ lastReport: { status, url }, state: 'connected', url, error: null }, false, {
            type: 'remoteAccess/applyServerReport',
            status,
          });
        } else if (status === 'reconnecting') {
          // The listener is still open, so the URL the person copied is still
          // the right one and is kept. Clearing it would empty every surface
          // over a tunnel that is about to answer again.
          set(
            (state) => ({
              lastReport: { status, url },
              state: 'reconnecting',
              url: url ?? state.url,
              error: null,
            }),
            false,
            { type: 'remoteAccess/applyServerReport', status }
          );
        } else {
          set({ lastReport: { status, url }, state: 'off', url: null, error: null }, false, {
            type: 'remoteAccess/applyServerReport',
            status,
          });
        }
      },

      noteTokenConfigured: (configured) =>
        set(
          (state) =>
            state.tokenConfigured === configured ? state : { tokenConfigured: configured },
          false,
          'remoteAccess/noteTokenConfigured'
        ),

      beginStart: () =>
        set({ userInitiated: true, state: 'starting', error: null }, false, 'remoteAccess/begin'),

      settleStart: (url) =>
        set({ state: 'connected', url, error: null }, false, 'remoteAccess/settleStart'),

      // Disarmed like every other exit that changes nothing: the tunnel was
      // ALREADY up, so the refetch reports no change and consumes nothing — and
      // a flag left armed would sit there until the next genuine drop and
      // swallow the one announcement that mattered.
      convergeStart: (url) =>
        set(
          (state) => ({
            userInitiated: false,
            state: url ? 'connected' : 'reconnecting',
            url: url ?? state.url,
            error: null,
          }),
          false,
          'remoteAccess/convergeStart'
        ),

      // No status change is coming, so the suppression must not stay armed over
      // whatever happens next.
      failStart: (message) =>
        set({ userInitiated: false, state: 'error', error: message }, false, {
          type: 'remoteAccess/failStart',
          message,
        }),

      abandonStart: () =>
        set({ userInitiated: false, state: 'off' }, false, 'remoteAccess/abandonStart'),

      beginStop: () =>
        set(
          { userInitiated: true, state: 'stopping', error: null },
          false,
          'remoteAccess/beginStop'
        ),

      settleStop: () =>
        set({ state: 'off', url: null, error: null }, false, 'remoteAccess/settleStop'),

      failStop: (message) =>
        set({ userInitiated: false, state: 'connected', error: message }, false, {
          type: 'remoteAccess/failStop',
          message,
        }),

      clearError: () =>
        set(
          (state) => ({ error: null, state: state.state === 'error' ? 'off' : state.state }),
          false,
          'remoteAccess/clearError'
        ),

      consumeSuppression: () => {
        if (!get().userInitiated) return false;
        set({ userInitiated: false }, false, 'remoteAccess/consumeSuppression');
        return true;
      },

      reset: () => set({ ...INITIAL }, false, 'remoteAccess/reset'),
    }),
    { name: 'RemoteAccessStore' }
  )
);

/**
 * Put the store back to a fresh app's understanding.
 *
 * Module-scope state outlives a test's `cleanup()`, so a suite that drives
 * remote access has to say when one case ends and the next begins.
 *
 * @internal Exported for testing only.
 */
export function resetRemoteAccessStore(): void {
  useRemoteAccessStore.getState().reset();
}
