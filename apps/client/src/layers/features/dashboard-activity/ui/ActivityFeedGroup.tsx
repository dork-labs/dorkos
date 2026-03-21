import type { ActivityGroup } from '../model/use-activity-feed';
import { ActivityFeedItem } from './ActivityFeedItem';

/** @internal Format hours/days ago for the "since your last visit" separator. */
function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 24) return `${hours} hours ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

interface SinceLastVisitSeparatorProps {
  lastVisitedAt: string;
}

function SinceLastVisitSeparator({ lastVisitedAt }: SinceLastVisitSeparatorProps) {
  const timeAgo = formatTimeAgo(lastVisitedAt);

  return (
    <div className="flex items-center gap-3 py-2">
      <div className="border-muted-foreground/20 flex-1 border-t" />
      <span className="text-muted-foreground shrink-0 text-xs">
        Since your last visit · {timeAgo}
      </span>
      <div className="border-muted-foreground/20 flex-1 border-t" />
    </div>
  );
}

interface ActivityFeedGroupProps {
  group: ActivityGroup;
  lastVisitedAt: string | null;
  /** When true, renders "since your last visit" separator between new and old events. */
  showSeparator?: boolean;
}

/** Time-grouped list of activity events with an optional "since your last visit" divider. */
export function ActivityFeedGroup({ group, lastVisitedAt, showSeparator }: ActivityFeedGroupProps) {
  const separatorIndex = lastVisitedAt
    ? group.events.findIndex((e) => new Date(e.timestamp) <= new Date(lastVisitedAt))
    : -1;

  return (
    <div>
      <h3 className="text-muted-foreground mt-4 mb-2 text-xs font-medium tracking-wider uppercase">
        {group.label}
      </h3>
      <div className="space-y-0.5">
        {group.events.map((event, idx) => (
          <div key={event.id}>
            {showSeparator && idx === separatorIndex && separatorIndex > 0 && (
              <SinceLastVisitSeparator lastVisitedAt={lastVisitedAt!} />
            )}
            <ActivityFeedItem
              event={event}
              isNew={lastVisitedAt ? new Date(event.timestamp) > new Date(lastVisitedAt) : false}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
