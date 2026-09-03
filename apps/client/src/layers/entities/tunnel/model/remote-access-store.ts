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

/**
 * The states the SERVER has no word for.
 *
 * It reports connected, running-but-unreachable, or neither. These three are
 * this side's own account of what somebody just did, so a report that repeats
 * itself says nothing about them and must not disturb them.
 */
const LOCAL_ONLY_STATES: ReadonlySet<TunnelState> = new Set(['starting', 'stopping', 'error']);

/**
 * The state a server report, on its own, would put the store in.
 *
 * Extracted so the change gate and the reduction below cannot drift: the gate
 * asks "does the store already agree with this report?" and has to mean exactly
 * what the reduction would do with it.
 *
 * @param status - What the server's tunnel block says.
 * @param url - The public URL it names, or `null`. A tunnel that claims to be on
 *   without saying where cannot be shown as connected, so it reads `off` — the
 *   same fallback the reduction takes.
 */
function impliedState(status: ReportedStatus, url: string | null): TunnelState {
  if (status === 'on' && url) return 'connected';
  if (status === 'reconnecting') return 'reconnecting';
  return 'off';
}

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
   *
   * `fetchedAt` is the query's `dataUpdatedAt` — when the SERVER last answered,
   * not when a component asked. It is what separates "the server said the same
   * thing again" from "a component mounted and replayed the cached answer", and
   * those two need opposite treatment. See {@link RemoteAccessActions.applyServerReport}.
   */
  lastReport: { status: ReportedStatus; url: string | null; fetchedAt: number } | null;
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
   * Reduce a server report — and only one that is actually news.
   *
   * ## Three cases, and they are genuinely different
   *
   * 1. **The facts changed.** Apply, always. The server is describing a tunnel
   *    this store has not heard about.
   * 2. **A replay** — the same facts at the same `fetchedAt`. That is a
   *    component MOUNTING and handing round the cached answer, not the server
   *    speaking. Never let it overwrite anything: opening the Control Center
   *    mid-start would otherwise snap the row back to Off over a tunnel that is
   *    coming up.
   * 3. **The server asked and answered again with the same facts.** Now it
   *    matters what this store holds:
   *    - `starting`, `stopping` and `error` are LOCAL-ONLY — the server has no
   *      word for them, so a report that repeats itself says nothing about
   *      them and they stand. This is the DOR-1739 rule: a failed start
   *      survives a refetch that reports no change.
   *    - `connected`, `reconnecting` and `off` are the SERVER'S to name. One
   *      that disagrees with a freshly re-confirmed report is stale optimism —
   *      a `settleStart` whose tunnel the server never saw — and gets
   *      corrected. Without this the beacon could sit green over a dead tunnel
   *      until the page was reloaded, because the tuple never changed.
   *
   * @param status - What the server's tunnel block says.
   * @param url - The public URL it names, or `null`.
   * @param fetchedAt - When the server answered (`dataUpdatedAt`). Distinguishes
   *   case 2 from case 3; a caller that passes a constant collapses them.
   */
  applyServerReport: (status: ReportedStatus, url: string | null, fetchedAt: number) => void;
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

      applyServerReport: (status, url, fetchedAt) => {
        const previous = get().lastReport;
        const sameFacts = previous !== null && previous.status === status && previous.url === url;

        if (sameFacts) {
          // Case 2: a replay of an answer already reduced. A component mounted;
          // the server did not speak.
          if (fetchedAt <= previous.fetchedAt) return;

          // Case 3: the server re-confirmed the same facts. Note WHEN, then
          // decide whether anything else should move.
          const noteOnly = () =>
            set({ lastReport: { status, url, fetchedAt } }, false, 'remoteAccess/reconfirmed');

          // Local-only states outlive a report that says nothing about them.
          if (LOCAL_ONLY_STATES.has(get().state)) return noteOnly();
          // A server-owned state that already agrees needs nothing.
          if (get().state === impliedState(status, url)) return noteOnly();
          // Otherwise fall through and correct the disagreement.
        }

        if (status === 'on' && url) {
          set(
            { lastReport: { status, url, fetchedAt }, state: 'connected', url, error: null },
            false,
            {
              type: 'remoteAccess/applyServerReport',
              status,
            }
          );
        } else if (status === 'reconnecting') {
          // The listener is still open, so the URL the person copied is still
          // the right one and is kept. Clearing it would empty every surface
          // over a tunnel that is about to answer again.
          set(
            (state) => ({
              lastReport: { status, url, fetchedAt },
              state: 'reconnecting',
              url: url ?? state.url,
              error: null,
            }),
            false,
            { type: 'remoteAccess/applyServerReport', status }
          );
        } else {
          set(
            { lastReport: { status, url, fetchedAt }, state: 'off', url: null, error: null },
            false,
            {
              type: 'remoteAccess/applyServerReport',
              status,
            }
          );
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
