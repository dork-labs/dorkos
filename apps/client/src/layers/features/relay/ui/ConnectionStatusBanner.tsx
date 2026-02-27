import { Wifi, WifiOff } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import type { RelayConnectionState } from '@/layers/entities/relay';

interface ConnectionStatusBannerProps {
  connectionState: RelayConnectionState;
  className?: string;
}

/** Displays an inline status banner when the Relay SSE connection is degraded or lost. */
export function ConnectionStatusBanner({ connectionState, className }: ConnectionStatusBannerProps) {
  if (connectionState === 'connected') return null;

  const isDisconnected = connectionState === 'disconnected';

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium',
        isDisconnected
          ? 'bg-red-500/10 text-red-600 dark:text-red-400'
          : 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
        className,
      )}
    >
      {isDisconnected ? (
        <WifiOff className="size-3.5" />
      ) : (
        <Wifi className="size-3.5 animate-pulse" />
      )}
      <span>
        {isDisconnected
          ? 'Connection lost. Check your network.'
          : 'Connection lost. Reconnecting...'}
      </span>
    </div>
  );
}
