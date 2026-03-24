import { Wifi, WifiOff } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import type { ConnectionState } from '@dorkos/shared/types';

interface ConnectionStatusBannerProps {
  connectionState: ConnectionState;
  failedAttempts?: number;
  maxAttempts?: number;
  className?: string;
}

/** Displays an inline status banner when an SSE connection is degraded or lost. */
export function ConnectionStatusBanner({
  connectionState,
  failedAttempts,
  maxAttempts,
  className,
}: ConnectionStatusBannerProps) {
  if (connectionState === 'connected' || connectionState === 'connecting') return null;

  const isDisconnected = connectionState === 'disconnected';
  const attemptText =
    failedAttempts && maxAttempts ? ` (attempt ${failedAttempts}/${maxAttempts})` : '';

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium',
        isDisconnected
          ? 'bg-red-500/10 text-red-600 dark:text-red-400'
          : 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
        className
      )}
    >
      {isDisconnected ? (
        <WifiOff className="size-3.5" />
      ) : (
        <Wifi className="size-3.5 animate-pulse" />
      )}
      <span>
        {isDisconnected ? 'Connection lost. Check your network.' : `Reconnecting...${attemptText}`}
      </span>
    </div>
  );
}
