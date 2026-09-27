import { useState } from 'react';
import { useAdapterEvents, type AdapterEventMetadata } from '@/layers/entities/relay';
import { cn, formatRelativeTime } from '@/layers/shared/lib';
import { Button, Skeleton } from '@/layers/shared/ui';
import { AdapterEventLog } from './AdapterEventLog';

/** How many recent events show before "See all". */
const RECENT_LIMIT = 3;

/** Plain words for what happened on a chat app. */
const EVENT_LINES: Record<string, string> = {
  'adapter.message_received': 'A message came in',
  'adapter.message_sent': 'A reply went out',
  'adapter.connected': 'Connected',
  'adapter.disconnected': 'Disconnected',
  'adapter.status_change': 'Its status changed',
};

/** The event's metadata, or null when it is missing or unreadable. */
function parseMetadata(metadata: string | null | undefined): AdapterEventMetadata | null {
  if (!metadata) return null;
  try {
    return JSON.parse(metadata) as AdapterEventMetadata;
  } catch {
    return null;
  }
}

/** One event as a plain line; an error keeps the server's own message. */
function eventLine(subject: string, metadata: string | null | undefined): string {
  if (subject === 'adapter.error') {
    const meta = parseMetadata(metadata);
    return meta?.message ? `Something went wrong: ${meta.message}` : 'Something went wrong';
  }
  return EVENT_LINES[subject] ?? subject;
}

/**
 * "Recently" for one chat app: the last three things that happened on it, in
 * plain words, and "See all" for the full event log.
 *
 * @param props - The chat app's id.
 * @param props.adapterId - The chat app instance to read.
 */
export function ChatAppRecent({ adapterId }: { adapterId: string }) {
  const { data, isPending, isError, refetch } = useAdapterEvents(adapterId);
  const [showAll, setShowAll] = useState(false);
  // The server answers newest first (`trace-store` orders by sentAt DESC).
  const events = data?.events ?? [];
  const [expanded, setExpanded] = useState<string | null>(null);

  if (isPending) return <Skeleton className="h-16 rounded-lg" />;
  if (isError) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        Couldn’t load what happened here.
        <Button variant="link" size="xs" className="h-auto p-0" onClick={() => void refetch()}>
          Try again
        </Button>
      </p>
    );
  }
  if (events.length === 0) return <p className="text-muted-foreground text-sm">Nothing yet.</p>;
  if (showAll) {
    return (
      <div className="space-y-2">
        <div className="bg-muted/30 h-72 overflow-hidden rounded-lg">
          <AdapterEventLog adapterId={adapterId} />
        </div>
        <Button variant="link" size="xs" className="h-auto p-0" onClick={() => setShowAll(false)}>
          Show less
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <ul className="space-y-1.5">
        {events.slice(0, RECENT_LIMIT).map((event) => {
          const line = eventLine(event.subject, event.metadata);
          const open = expanded === event.id;
          const time = (
            <span className="text-muted-foreground shrink-0 text-xs">
              {formatRelativeTime(event.sentAt)}
            </span>
          );
          // An error's own words can be long; the line opens to show all of them.
          return event.subject === 'adapter.error' ? (
            <li key={event.id}>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setExpanded(open ? null : event.id)}
                className="focus-ring hover:bg-muted/50 -mx-1 flex w-full items-baseline justify-between gap-3 rounded px-1 text-left text-sm"
              >
                <span className={cn('min-w-0', open ? 'break-words' : 'truncate')}>{line}</span>
                {time}
              </button>
            </li>
          ) : (
            <li key={event.id} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{line}</span>
              {time}
            </li>
          );
        })}
      </ul>
      <Button variant="link" size="xs" className="h-auto p-0" onClick={() => setShowAll(true)}>
        See all
      </Button>
    </div>
  );
}
