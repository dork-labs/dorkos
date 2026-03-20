import { useRef, useEffect, useState, useCallback } from 'react';
import { ArrowDown, Activity } from 'lucide-react';
import { Badge } from '@/layers/shared/ui/badge';
import { Button } from '@/layers/shared/ui/button';
import { Skeleton } from '@/layers/shared/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui/select';
import { useAdapterEvents, type AdapterEventMetadata } from '@/layers/entities/relay';
import { cn } from '@/layers/shared/lib';

/** Badge color by event type category. */
const EVENT_TYPE_COLORS: Record<string, string> = {
  'adapter.connected': 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  'adapter.message_sent': 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  'adapter.disconnected': 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  'adapter.error': 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  'adapter.message_received': 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  'adapter.status_change': 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
};

/** Human-readable label for event types. */
const EVENT_TYPE_LABELS: Record<string, string> = {
  'adapter.connected': 'Connected',
  'adapter.disconnected': 'Disconnected',
  'adapter.message_received': 'Received',
  'adapter.message_sent': 'Sent',
  'adapter.error': 'Error',
  'adapter.status_change': 'Status',
};

const ALL_EVENT_TYPES = Object.keys(EVENT_TYPE_LABELS);

interface AdapterEventLogProps {
  adapterId: string;
}

/** Chronological event log for a single adapter with auto-scroll and type filtering. */
export function AdapterEventLog({ adapterId }: AdapterEventLogProps) {
  const { data, isLoading } = useAdapterEvents(adapterId);
  const [filter, setFilter] = useState<string>('all');
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  // Track scroll position to determine auto-scroll behavior
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 20; // px tolerance
    setIsAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < threshold);
  }, []);

  // Auto-scroll to bottom when new events arrive (only if user is at bottom)
  useEffect(() => {
    if (isAtBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [data, isAtBottom]);

  const jumpToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      setIsAtBottom(true);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-2 p-3">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </div>
    );
  }

  const events = data?.events ?? [];
  const filteredEvents = filter === 'all' ? events : events.filter((e) => e.subject === filter);

  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
        <Activity className="text-muted-foreground size-6" />
        <p className="text-muted-foreground text-sm">No events recorded</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header with filter */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h4 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
          Events
        </h4>
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="h-7 w-[130px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {ALL_EVENT_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {EVENT_TYPE_LABELS[type]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Event list */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-2">
        {filteredEvents.map((event) => {
          const meta: AdapterEventMetadata | null = event.metadata
            ? (JSON.parse(event.metadata) as AdapterEventMetadata)
            : null;
          const time = new Date(event.sentAt).toLocaleTimeString('en-US', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          });
          return (
            <div key={event.id} className="flex items-start gap-2 py-1">
              <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
                {time}
              </span>
              <Badge
                variant="secondary"
                className={cn('shrink-0 text-[10px]', EVENT_TYPE_COLORS[event.subject] ?? '')}
              >
                {EVENT_TYPE_LABELS[event.subject] ?? event.subject}
              </Badge>
              <span className="text-xs break-words">{meta?.message ?? event.subject}</span>
            </div>
          );
        })}
      </div>

      {/* Jump to bottom button (shown when user has scrolled up) */}
      {!isAtBottom && (
        <div className="flex justify-center border-t py-1">
          <Button variant="ghost" size="sm" onClick={jumpToBottom} className="h-6 text-xs">
            <ArrowDown className="mr-1 size-3" />
            Jump to bottom
          </Button>
        </div>
      )}
    </div>
  );
}
