/**
 * React hook wrapping SSEConnection for resilient EventSource management.
 *
 * @module shared/model/use-sse-connection
 */
import { useState, useEffect, useRef } from 'react';

import type { ConnectionState } from '@dorkos/shared/types';

import { SSEConnection } from '@/layers/shared/lib/transport';

/** Options for the {@link useSSEConnection} hook. */
export interface UseSSEConnectionOptions {
  /** Event handlers for SSE events, keyed by event type. */
  eventHandlers: Record<string, (data: unknown) => void>;
  /** Enable page visibility optimization (disconnect on hidden tab). Default: true. */
  visibilityOptimization?: boolean;
  /** Override heartbeat watchdog timeout in ms. Default: 45000. */
  heartbeatTimeoutMs?: number;
}

/** Return value of the {@link useSSEConnection} hook. */
export interface UseSSEConnectionReturn {
  /** Current connection state. */
  connectionState: ConnectionState;
  /** Number of consecutive failed connection attempts. */
  failedAttempts: number;
  /** Timestamp of the last received event, or null if none received yet. */
  lastEventAt: number | null;
}

/**
 * Manage a resilient SSE connection with automatic reconnection, heartbeat
 * watchdog, and page visibility optimization.
 *
 * Pass `null` as the URL to indicate "don't connect" — any existing connection
 * will be cleaned up and state reset.
 *
 * Event handlers are captured via ref to prevent reconnection when handler
 * identity changes between renders.
 *
 * @param url - SSE endpoint URL, or null to disable the connection
 * @param options - Connection configuration and event handlers
 */
export function useSSEConnection(
  url: string | null,
  options: UseSSEConnectionOptions
): UseSSEConnectionReturn {
  const [connectionState, setConnectionState] = useState<ConnectionState>('connected');
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const connectionRef = useRef<SSEConnection | null>(null);

  // Ref-stabilize handlers to prevent reconnection on identity changes
  const handlersRef = useRef(options.eventHandlers);
  handlersRef.current = options.eventHandlers;

  const visibilityOptimization = options.visibilityOptimization ?? true;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs;

  useEffect(() => {
    if (!url) {
      // No URL — clean up and reset to initial state
      if (connectionRef.current) {
        connectionRef.current.destroy();
        connectionRef.current = null;
      }
      setConnectionState('connected');
      setFailedAttempts(0);
      setLastEventAt(null);
      return;
    }

    // Build delegate handlers that forward to the ref-stabilized handlers
    // and track the last event timestamp
    const delegateHandlers: Record<string, (data: unknown) => void> = {};
    for (const key of Object.keys(handlersRef.current)) {
      delegateHandlers[key] = (data: unknown) => {
        handlersRef.current[key]?.(data);
        setLastEventAt(Date.now());
      };
    }

    const connection = new SSEConnection(url, {
      eventHandlers: delegateHandlers,
      onStateChange: (state, attempts) => {
        setConnectionState(state);
        setFailedAttempts(attempts);
      },
      heartbeatTimeoutMs,
    });

    connection.connect();

    if (visibilityOptimization) {
      connection.enableVisibilityOptimization();
    }

    connectionRef.current = connection;

    return () => {
      connection.destroy();
      connectionRef.current = null;
    };
  }, [url, visibilityOptimization, heartbeatTimeoutMs]);

  return { connectionState, failedAttempts, lastEventAt };
}
