import { Wifi, WifiOff } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import type { ConnectionState } from '@dorkos/shared/types';
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/layers/shared/ui';

const STATE_CONFIG: Record<
  ConnectionState,
  { color: string; label: string; shortLabel: string; icon: typeof Wifi; tasks: boolean }
> = {
  connecting: {
    color: 'bg-amber-500',
    label: 'Connecting',
    shortLabel: 'Connecting',
    icon: Wifi,
    tasks: true,
  },
  connected: {
    color: 'bg-emerald-500',
    label: 'Connected',
    shortLabel: 'Connected',
    icon: Wifi,
    tasks: false,
  },
  reconnecting: {
    color: 'bg-amber-500',
    label: 'Reconnecting',
    shortLabel: 'Reconnecting',
    icon: Wifi,
    tasks: true,
  },
  // "Offline" rather than a clipped "Connection los…": a narrow line gets a
  // shorter true sentence, never a truncated one.
  disconnected: {
    color: 'bg-red-500',
    label: 'Connection lost',
    shortLabel: 'Offline',
    icon: WifiOff,
    tasks: false,
  },
};

interface ConnectionItemProps {
  connectionState: ConnectionState;
  /**
   * Say it in as few pixels as possible — set below the status line's widest
   * tier. Swaps in the state's short label; the full one still heads the hover
   * card, and the Session panel reports it too.
   */
  compact?: boolean;
}

/**
 * Status line item showing live-sync connection health. The registry decides when
 * it shows (only when the link is not connected); this component only draws it.
 *
 * @param props - The session's live-sync connection state.
 */
export function ConnectionItem({ connectionState, compact }: ConnectionItemProps) {
  const config = STATE_CONFIG[connectionState];
  const Icon = config.icon;

  return (
    <HoverCard openDelay={200}>
      <HoverCardTrigger asChild>
        {/* Deliberately unnamed: `role="status"` is a live region, so a screen
            reader announces the CONTENT. An `aria-label` here would have it read
            the long label and then the short one. */}
        <span className="flex min-w-0 cursor-default items-center gap-1.5 text-xs" role="status">
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              config.color,
              config.tasks && 'animate-tasks'
            )}
          />
          <span className="text-muted-foreground truncate">
            {compact ? config.shortLabel : config.label}
          </span>
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
            <p className="text-sm font-medium">{config.label}</p>
            <HoverDescription connectionState={connectionState} />
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
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
