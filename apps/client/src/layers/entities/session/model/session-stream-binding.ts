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
 * Install the StreamManager listeners that dispatch validated frames into the
 * stores. Idempotent — safe to call from every chat-hook mount.
 *
 * - `onSnapshot` → `applySnapshot` (hydration)
 * - `onSessionEvent` → `applyEvent` (idempotent seq-gated fold)
 * - `onSessionConnectionState` → `setConnectionState`
 * - `onListEvent` → the list store's `applyListEvent`, plus a `session_removed`
 *   fan-out that evicts the per-session stream store so a deleted session's
 *   projection is dropped immediately rather than lingering until LRU eviction.
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
      useSessionListStore.getState().applyListEvent(event);
      // A removed session must also drop its per-session stream projection.
      // `removeSession` is idempotent and no-throw for unknown ids.
      if (event.type === 'session_removed') {
        useSessionStreamStore.getState().removeSession(event.sessionId);
      }
    },
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
