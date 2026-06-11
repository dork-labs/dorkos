/**
 * Session-stream binding — wires the connection-only {@link streamManager}
 * (shared layer) to the per-session and global session-list stores (entities
 * layer). This is the one place the two halves of the FSD-split streaming
 * infrastructure meet; the entities→shared dependency direction is allowed.
 *
 * The chat hooks (#9, subscribe-first hydration) call {@link initSessionStreamBinding}
 * once to install the listeners, then drive the StreamManager via
 * `streamManager.attachSession(id)` / `connectList()`.
 *
 * @module entities/session/model/session-stream-binding
 */
import { streamManager } from '@/layers/shared/lib/transport';

import { useSessionStreamStore } from './session-stream-store';
import { useSessionListStore } from './session-list-store';

/**
 * Guards against re-installing listeners. The StreamManager singleton holds a
 * single listener set, so a second `setListeners` call would simply replace the
 * (identical) one — but skipping it keeps the binding a true once-per-app op and
 * StrictMode/HMR-safe.
 */
let bound = false;

/**
 * Lifecycles that settle a turn. A background session crossing
 * streaming/blocked→settled is "work finished while the operator looked
 * elsewhere" — the unseen-activity signal (the list store prunes settled
 * statuses, so without this flag all indication of the finished work vanishes
 * the moment it completes). `blocked` qualifies as the live side too: an
 * interaction resolved from another window settles the session without ever
 * re-entering `streaming`.
 */
const SETTLED_LIFECYCLES = new Set(['idle', 'interrupted']);

/**
 * Install the StreamManager listeners that dispatch validated frames into the
 * stores. Idempotent — safe to call from every chat-hook mount.
 *
 * - `onSnapshot` → `applySnapshot` (hydration)
 * - `onSessionEvent` → `applyEvent` (idempotent seq-gated fold)
 * - `onSessionConnectionState` → `setConnectionState`
 * - `onListEvent` → the list store's `applyListEvent`, plus a `session_removed`
 *   fan-out that evicts the per-session stream store, plus unseen-activity
 *   marking for background streaming→settled edges (see above).
 * - list connection state → `resetStatuses` on every (re)connect, because
 *   `session_status` is fan-out-only (no replay): a status held across a
 *   disconnect may describe a turn that settled while the stream was down.
 */
export function initSessionStreamBinding(): void {
  if (bound) return;
  bound = true;

  streamManager.setListeners({
    onSnapshot: (sessionId, snapshot) =>
      useSessionStreamStore.getState().applySnapshot(sessionId, snapshot),
    onSessionEvent: (sessionId, event) =>
      useSessionStreamStore.getState().applyEvent(sessionId, event),
    onSessionConnectionState: (sessionId, state) =>
      useSessionStreamStore.getState().setConnectionState(sessionId, state),
    onListEvent: (event) => {
      if (event.type === 'session_status') {
        // Read the PRE-apply status: the settle edge is prev=streaming →
        // settled. Skipped for the actively-attached session (the operator is
        // watching it settle — nothing is "unseen").
        const prev = useSessionListStore.getState().statuses[event.sessionId]?.lifecycle;
        if (
          (prev === 'streaming' || prev === 'blocked') &&
          SETTLED_LIFECYCLES.has(event.status.lifecycle) &&
          event.sessionId !== streamManager.getAttachedSessionId()
        ) {
          useSessionListStore.getState().markUnseen(event.sessionId, event.cwd);
        }
      }
      useSessionListStore.getState().applyListEvent(event);
      // A removed session must also drop its per-session stream projection.
      // `removeSession` is idempotent and no-throw for unknown ids.
      if (event.type === 'session_removed') {
        useSessionStreamStore.getState().removeSession(event.sessionId);
      }
    },
  });

  // Re-baseline statuses whenever the global stream ENTERS 'connected' — on
  // boot this is a no-op (nothing held yet); after a drop or hidden-tab release
  // it clears stale projections that would otherwise pin a dead border.
  streamManager.subscribeListConnectionState((state) => {
    if (state === 'connected') {
      useSessionListStore.getState().resetStatuses();
    }
  });
}

/**
 * Reset the bound guard so a subsequent {@link initSessionStreamBinding} re-installs
 * listeners.
 *
 * @internal Test-only.
 */
export function resetSessionStreamBinding(): void {
  bound = false;
}
