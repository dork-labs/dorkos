/**
 * EventStreamProvider — React access to the unified `/api/events` broadcast
 * stream WITHOUT owning a connection. The underlying connection is the
 * {@link streamManager}'s global session-list stream (the second of the
 * two-connection budget, spec chat-stream-reconnection / CLI-B5): generic
 * events (tunnel status, relay traffic, extension reloads) ride the same SSE
 * connection as the session-list events, dispatched through the manager's
 * `subscribeEvent` API.
 *
 * This provider therefore only (1) ensures the list stream is connected,
 * (2) mirrors its connection state into React state, and (3) installs the
 * refetch-on-reconnect cache invalidation. In embedded mode (Obsidian) the
 * manager's transport source yields no generic events, so subscriptions are
 * inert no-ops there — by design (no HTTP broadcast stream exists in-process).
 *
 * @module shared/model/event-stream-context
 */
import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';

import type { ConnectionState } from '@dorkos/shared/types';

import { streamManager, type GenericEventName } from '@/layers/shared/lib/transport';

/** Handler function for a single SSE event payload. */
export type EventHandler = (data: unknown) => void;

/** Subscribe to a named SSE event; returns an unsubscribe function. */
export type SubscribeFn = (eventName: KnownEvent, handler: EventHandler) => () => void;

/**
 * Known event names published by the `/api/events` unified stream. The
 * canonical list lives with the connection owner ({@link streamManager}'s
 * `GENERIC_EVENTS`) — add new events there as the server emits them.
 */
export type KnownEvent = GenericEventName;

/** Value exposed by the {@link useEventStream} hook. */
export interface EventStreamContextValue {
  /** Subscribe to a named event. Returns an unsubscribe function. */
  subscribe: SubscribeFn;
  /** Current SSE connection state. */
  connectionState: ConnectionState;
  /** Number of consecutive failed connection attempts. */
  failedAttempts: number;
}

// ---------------------------------------------------------------------------
// Refetch-on-reconnect — installed once per app lifetime (module-level guard,
// preserved across Vite HMR via import.meta.hot.data so a re-evaluation of this
// module cannot stack a second invalidation listener).
// ---------------------------------------------------------------------------

let reconnectInvalidationInstalled: boolean =
  import.meta.hot?.data?.reconnectInvalidationInstalled === true;

/**
 * Invalidate TanStack Query caches whenever the global stream recovers from a
 * disconnect (reconnecting → connected). Server state may have changed while
 * the stream was down; a full invalidation is the honest re-sync.
 */
function installReconnectInvalidation(): void {
  if (reconnectInvalidationInstalled) return;
  reconnectInvalidationInstalled = true;
  if (import.meta.hot?.data) {
    import.meta.hot.data.reconnectInvalidationInstalled = true;
  }

  let previousState: ConnectionState = streamManager.getListConnectionState();
  streamManager.subscribeListConnectionState((state) => {
    if (state === 'connected' && previousState === 'reconnecting') {
      import('@/layers/shared/lib/query-client').then(
        ({ queryClient }) => {
          queryClient.invalidateQueries();
        },
        () => {
          // Silently ignore — query client may not be available in test environments
        }
      );
    }
    previousState = state;
  });
}

// ---------------------------------------------------------------------------

const EventStreamContext = createContext<EventStreamContextValue | null>(null);

/**
 * Provide the shared `/api/events` subscription API to the component tree.
 *
 * Mount this once near the top of the provider tree. No connection is owned
 * here — the provider drives the {@link streamManager}'s global list stream
 * (idempotent `connectList`), so StrictMode double-mounts and HMR cannot open
 * duplicates.
 *
 * Consumers subscribe via {@link useEventStream} or {@link useEventSubscription}.
 */
export function EventStreamProvider({ children }: { children: React.ReactNode }) {
  const [connectionState, setConnectionState] = useState<ConnectionState>(
    streamManager.getListConnectionState()
  );
  const [failedAttempts, setFailedAttempts] = useState(streamManager.getListFailedAttempts());

  useEffect(() => {
    installReconnectInvalidation();
    streamManager.connectList();

    // Re-read after connect — connectList may have transitioned the state
    // synchronously between the render snapshot and this subscription.
    setConnectionState(streamManager.getListConnectionState());
    setFailedAttempts(streamManager.getListFailedAttempts());
    return streamManager.subscribeListConnectionState((state, attempts) => {
      setConnectionState(state);
      setFailedAttempts(attempts);
    });
  }, []);

  const subscribe: SubscribeFn = useCallback(
    (eventName, handler) => streamManager.subscribeEvent(eventName, handler),
    []
  );

  return (
    <EventStreamContext.Provider value={{ subscribe, connectionState, failedAttempts }}>
      {children}
    </EventStreamContext.Provider>
  );
}

/**
 * Access the shared event stream subscription API.
 *
 * Must be used within an {@link EventStreamProvider}.
 *
 * @throws If called outside an `EventStreamProvider`.
 */
export function useEventStream(): EventStreamContextValue {
  const ctx = useContext(EventStreamContext);
  if (!ctx) {
    throw new Error('useEventStream must be used within an EventStreamProvider');
  }
  return ctx;
}

/**
 * Subscribe to a named SSE event for the lifetime of the calling component.
 *
 * The handler is ref-stabilized — its identity may change between renders
 * without causing re-subscriptions.
 *
 * @param eventName - The SSE event type to listen for.
 * @param handler - Callback invoked with the parsed event payload.
 */
export function useEventSubscription(eventName: KnownEvent, handler: EventHandler): void {
  const { subscribe } = useEventStream();

  // Ref-stabilize the handler to avoid re-subscribing on every render
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    // Wrap with a stable function that delegates to the latest handler ref
    const stableHandler: EventHandler = (data) => {
      handlerRef.current(data);
    };
    return subscribe(eventName, stableHandler);
  }, [subscribe, eventName]);
}
