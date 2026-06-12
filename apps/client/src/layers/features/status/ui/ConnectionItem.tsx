import { Wifi, WifiOff } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import type { ConnectionState } from '@dorkos/shared/types';
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/layers/shared/ui';
import { SSE_RESILIENCE } from '@/layers/shared/lib';
import { StatusLine } from './StatusLine';

const STATE_CONFIG: Record<
  ConnectionState,
  { color: string; label: string; icon: typeof Wifi; tasks: boolean }
> = {
  connecting: { color: 'bg-amber-500', label: 'Connecting', icon: Wifi, tasks: true },
  connected: { color: 'bg-emerald-500', label: 'Connected', icon: Wifi, tasks: false },
  reconnecting: { color: 'bg-amber-500', label: 'Reconnecting', icon: Wifi, tasks: true },
  disconnected: { color: 'bg-red-500', label: 'Connection lost', icon: WifiOff, tasks: false },
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
              className={cn('size-1.5 rounded-full', config.color, config.tasks && 'animate-tasks')}
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

/**
 * Contextual description explaining what's happening and what the user should
 * know. Honest about what this connection carries: the durable `/events`
 * stream IS the chat delivery path (spec chat-stream-reconnection), so while
 * it is down, incoming messages and updates do not appear.
 */
function HoverDescription({ connectionState }: { connectionState: ConnectionState }) {
  const base = 'text-muted-foreground text-xs leading-relaxed';

  if (connectionState === 'connecting') {
    return (
      <p className={base}>
        Opening the live connection to this session. New messages and updates appear once it&apos;s
        open.
      </p>
    );
  }

  if (connectionState === 'reconnecting') {
    return (
      <div className="space-y-1.5">
        <p className={base}>
          The live connection dropped and is reconnecting automatically. Incoming messages and
          updates are paused — nothing is lost; anything missed replays when it reconnects.
        </p>
        <p className={cn(base, 'text-muted-foreground/70')}>No action needed.</p>
      </div>
    );
  }

  // disconnected
  return (
    <div className="space-y-1.5">
      <p className={base}>
        Could not re-establish the live connection after several attempts. New messages and updates
        will not appear until it&apos;s restored.
      </p>
      <p className={cn(base, 'text-muted-foreground/70')}>
        Try refreshing the page. If the issue persists, check that the DorkOS server is running.
      </p>
    </div>
  );
}
