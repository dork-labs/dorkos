import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createChannel } from '@/layers/shared/lib';
import { useEventSubscription } from '@/layers/shared/model';
import type { TunnelStatus } from '@dorkos/shared/types';
import { configKeys } from '@/layers/shared/model';

const CHANNEL_NAME = 'dorkos-tunnel';

/** Broadcast a tunnel status change to other tabs. */
export function broadcastTunnelChange(): void {
  const channel = createChannel(CHANNEL_NAME);
  channel.postMessage({ type: 'tunnel_changed' });
  channel.close();
}

/**
 * Cross-tab and cross-device tunnel status sync.
 *
 * Subscribes to BroadcastChannel for same-browser tab sync and the
 * shared `/api/events` SSE stream for cross-device sync. Invalidates
 * `tunnel-status` and `config` queries on any `tunnel_status` event.
 */
export function useTunnelSync(): void {
  const queryClient = useQueryClient();

  // Cross-tab sync via BroadcastChannel
  useEffect(() => {
    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: ['tunnel-status'] });
      queryClient.invalidateQueries({ queryKey: configKeys.all });
    };

    const channel = createChannel<{ type: string }>(CHANNEL_NAME);
    const unsubscribe = channel.onMessage(() => invalidate());

    return () => {
      unsubscribe();
      channel.close();
    };
  }, [queryClient]);

  // Cross-device sync via the shared SSE event stream
  useEventSubscription('tunnel_status', (data) => {
    try {
      // The event stream context delivers already-parsed payloads
      queryClient.setQueryData(['tunnel-status'], data as TunnelStatus);
      queryClient.invalidateQueries({ queryKey: configKeys.all });
    } catch {
      queryClient.invalidateQueries({ queryKey: ['tunnel-status'] });
      queryClient.invalidateQueries({ queryKey: configKeys.all });
    }
  });
}
