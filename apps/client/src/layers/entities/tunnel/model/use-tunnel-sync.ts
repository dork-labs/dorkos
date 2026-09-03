/**
 * Keeping this browser's picture of the tunnel true.
 *
 * @module entities/tunnel/model/use-tunnel-sync
 */

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createChannel } from '@/layers/shared/lib';
import { useEventSubscription } from '@/layers/shared/model';
import { configKeys } from '@/layers/entities/config';
import { useRemoteAccessReducer } from './use-remote-access';

const CHANNEL_NAME = 'dorkos-tunnel';

/** Broadcast a tunnel status change to other tabs. */
export function broadcastTunnelChange(): void {
  const channel = createChannel(CHANNEL_NAME);
  channel.postMessage({ type: 'tunnel_changed' });
  channel.close();
}

/**
 * Cross-tab and cross-device tunnel status sync. **Mount this exactly once**,
 * from the app shell.
 *
 * Subscribes to a BroadcastChannel for same-browser tab sync and to the shared
 * `/api/events` SSE stream for everything else, and refreshes the config read
 * that every remote-access surface derives from.
 *
 * ## It went un-mounted for a while, and that was a real hole (DOR-1743)
 *
 * Its previous caller was the sidebar footer's globe, which went when the
 * footer became one strip (BC-47) — and nothing picked the hook up. So the
 * server emitted `tunnel_status` on every connect, drop and reconnect
 * (DOR-1738) and no client did anything with it: the only way a browser learned
 * its tunnel had dropped was the config query happening to go stale. The beacon
 * and the Control Center row both report live state, so the stream is wired
 * again.
 *
 * The payload is deliberately not written into the cache directly. `/api/config`
 * is the shape every surface reads, `TunnelStatus` is a narrower one, and
 * re-asking costs a single small request against a server that is usually on
 * this machine.
 */
export function useTunnelSync(): void {
  const queryClient = useQueryClient();

  // The shell's guarantee that the shared store is current, even on a route
  // where nothing draws remote access. `useRemoteAccessSnapshot` — ⌘K's reader
  // — has no query of its own, so without this its answer would depend on
  // whether some other component happened to be mounted. Idempotent: the change
  // gate is in the store.
  useRemoteAccessReducer();

  // Cross-tab sync via BroadcastChannel
  useEffect(() => {
    const channel = createChannel<{ type: string }>(CHANNEL_NAME);
    const unsubscribe = channel.onMessage(() => {
      queryClient.invalidateQueries({ queryKey: configKeys.all });
    });

    return () => {
      unsubscribe();
      channel.close();
    };
  }, [queryClient]);

  // Cross-device sync via the shared SSE event stream
  useEventSubscription('tunnel_status', () => {
    queryClient.invalidateQueries({ queryKey: configKeys.all });
  });
}
