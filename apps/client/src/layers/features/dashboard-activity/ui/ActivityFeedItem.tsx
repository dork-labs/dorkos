import { useNavigate } from '@tanstack/react-router';
import { Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import type { ActivityEvent } from '../model/use-activity-feed';

const TYPE_DOT_COLORS: Record<ActivityEvent['type'], string> = {
  session: 'bg-blue-500',
  pulse: 'bg-purple-500',
  relay: 'bg-teal-500',
  mesh: 'bg-muted-foreground/40',
  system: 'bg-muted-foreground/30',
};

const TYPE_LABELS: Record<ActivityEvent['type'], string> = {
  session: 'Session',
  pulse: 'Pulse',
  relay: 'Relay',
  mesh: 'Mesh',
  system: 'System',
};

/** @internal Format a timestamp as h:mm a for today or MMM d for older dates. */
function formatEventTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface ActivityFeedItemProps {
  event: ActivityEvent;
  /** Events since last visit receive a blue left border accent. */
  isNew?: boolean;
}

/** Single activity event row with type dot, label, title, timestamp, and optional link button. */
export function ActivityFeedItem({ event, isNew }: ActivityFeedItemProps) {
  const navigate = useNavigate();
  const time = formatEventTime(event.timestamp);

  return (
    <div
      className={cn('flex items-center gap-3 py-1', isNew && 'border-l-2 border-blue-500/30 pl-3')}
    >
      <span className="text-muted-foreground w-16 shrink-0 text-xs tabular-nums">{time}</span>
      <span className={cn('size-2 shrink-0 rounded-full', TYPE_DOT_COLORS[event.type])} />
      <span className="text-muted-foreground w-14 shrink-0 text-xs">{TYPE_LABELS[event.type]}</span>
      <span className="text-foreground/80 flex-1 truncate text-sm">{event.title}</span>
      {event.link && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 text-xs"
          onClick={() =>
            navigate({
              to: event.link!.to as '/session',
              search: event.link!.params as Record<string, string>,
            })
          }
        >
          Open
        </Button>
      )}
    </div>
  );
}
