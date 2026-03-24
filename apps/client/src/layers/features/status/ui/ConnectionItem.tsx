import { Wifi, WifiOff } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import type { ConnectionState } from '@dorkos/shared/types';
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/layers/shared/ui';
import { SSE_RESILIENCE } from '@/layers/shared/lib';
import { StatusLine } from './StatusLine';

const STATE_CONFIG: Record<
  ConnectionState,
  { color: string; label: string; icon: typeof Wifi; pulse: boolean }
> = {
  connecting: { color: 'bg-amber-500', label: 'Sync connecting', icon: Wifi, pulse: true },
  connected: { color: 'bg-emerald-500', label: 'Sync connected', icon: Wifi, pulse: false },
  reconnecting: { color: 'bg-amber-500', label: 'Sync reconnecting', icon: Wifi, pulse: true },
  disconnected: { color: 'bg-red-500', label: 'Sync offline', icon: WifiOff, pulse: false },
};

interface ConnectionItemProps {
  connectionState: ConnectionState;
  failedAttempts?: number;
}

/** StatusLine item showing live-sync connection health. Only visible when NOT connected. */
export function ConnectionItem({ connectionState, failedAttempts }: ConnectionItemProps) {
  const visible = connectionState !== 'connected';
  const config = STATE_CONFIG[connectionState];
  const Icon = config.icon;

  const shortLabel =
    failedAttempts && connectionState === 'reconnecting'
      ? `Reconnecting (${failedAttempts}/${SSE_RESILIENCE.DISCONNECTED_THRESHOLD})`
      : config.label;

  return (
    <StatusLine.Item itemKey="connection" visible={visible}>
      <HoverCard openDelay={200}>
        <HoverCardTrigger asChild>
          <span className="flex cursor-default items-center gap-1.5 text-xs" role="status">
            <span
              className={cn('size-1.5 rounded-full', config.color, config.pulse && 'animate-pulse')}
            />
            <span className="text-muted-foreground">{shortLabel}</span>
          </span>
        </HoverCardTrigger>
        <HoverCardContent side="top" align="center" className="w-72 p-3">
          <div className="flex items-start gap-2.5">
            <Icon
              className={cn(
                'mt-0.5 size-4 shrink-0',
                connectionState === 'disconnected' ? 'text-red-500' : 'text-amber-500'
              )}
            />
            <div className="min-w-0 space-y-1.5">
              <p className="text-sm font-medium">{shortLabel}</p>
              <HoverDescription connectionState={connectionState} />
            </div>
          </div>
        </HoverCardContent>
      </HoverCard>
    </StatusLine.Item>
  );
}

/** Contextual description explaining what's happening and what the user should know. */
function HoverDescription({ connectionState }: { connectionState: ConnectionState }) {
  const base = 'text-muted-foreground text-xs leading-relaxed';

  if (connectionState === 'connecting') {
    return (
      <p className={base}>
        Establishing the live-sync connection. Your chat works normally — this only affects
        real-time updates from other windows.
      </p>
    );
  }

  if (connectionState === 'reconnecting') {
    return (
      <div className="space-y-1.5">
        <p className={base}>
          The live-sync connection was interrupted and is reconnecting automatically. Your chat
          works normally — you just won't see real-time updates from other clients until it
          reconnects.
        </p>
        <p className={cn(base, 'text-muted-foreground/70')}>No action needed.</p>
      </div>
    );
  }

  // disconnected
  return (
    <div className="space-y-1.5">
      <p className={base}>
        Could not re-establish the live-sync connection after several attempts. Your chat still
        works — messages you send and receive are unaffected.
      </p>
      <p className={cn(base, 'text-muted-foreground/70')}>
        Try refreshing the page. If the issue persists, check that the DorkOS server is running.
      </p>
    </div>
  );
}
