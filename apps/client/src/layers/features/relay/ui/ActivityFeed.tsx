import { useState } from 'react';
import { Inbox } from 'lucide-react';
import { useRelayMessages } from '@/layers/entities/relay';
import {
  Badge,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui';
import { MessageRow } from './MessageRow';

interface ActivityFeedProps {
  enabled: boolean;
}

type SourceType = 'telegram' | 'webhook' | 'system';
type FilterValue = 'all' | SourceType;
type DirectionType = 'inbound' | 'outbound' | 'neutral';

/** Derive the adapter source from the message subject prefix. */
function getSourceType(subject: string): SourceType {
  if (subject.startsWith('relay.human.telegram')) return 'telegram';
  if (subject.startsWith('relay.webhook')) return 'webhook';
  return 'system';
}

/** Derive the message direction from the subject and from fields. */
function getDirection(subject: string, from: string): DirectionType {
  if (subject.startsWith('relay.human.telegram')) return 'inbound';
  if (from.startsWith('relay.agent.')) return 'outbound';
  return 'neutral';
}

const SOURCE_BADGE_CONFIG: Record<SourceType, { label: string; className: string }> = {
  telegram: {
    label: 'TG',
    className: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300',
  },
  webhook: {
    label: 'WH',
    className: 'border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-800 dark:bg-purple-950 dark:text-purple-300',
  },
  system: {
    label: 'SYS',
    className: 'border-border bg-muted text-muted-foreground',
  },
};

const DIRECTION_SYMBOL: Record<DirectionType, string> = {
  inbound: '↓',
  outbound: '↑',
  neutral: '→',
};

/** Chronological message list with source/direction indicators and source filter. */
export function ActivityFeed({ enabled }: ActivityFeedProps) {
  const [filter, setFilter] = useState<FilterValue>('all');
  const { data, isLoading } = useRelayMessages(undefined, enabled);
  const messages = data?.messages ?? [];

  const filteredMessages = filter === 'all'
    ? messages
    : messages.filter((msg) => {
        const subject = (msg as Record<string, unknown>).subject as string ?? '';
        return getSourceType(subject) === filter;
      });

  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="rounded-lg border p-3">
            <div className="flex items-center gap-2">
              <div className="size-4 animate-pulse rounded bg-muted" />
              <div className="h-4 w-40 animate-pulse rounded bg-muted" />
              <div className="ml-auto h-3 w-16 animate-pulse rounded bg-muted" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <Select value={filter} onValueChange={(v) => setFilter(v as FilterValue)}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="telegram">Telegram</SelectItem>
            <SelectItem value="webhook">Webhook</SelectItem>
            <SelectItem value="system">System</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {filteredMessages.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
          <Inbox className="size-8 text-muted-foreground/30" />
          <div>
            <p className="font-medium">No messages yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {filter === 'all'
                ? 'Messages sent through the Relay bus will appear here.'
                : `No ${filter} messages found.`}
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {filteredMessages.map((msg, i) => {
            const raw = msg as Record<string, unknown>;
            const subject = (raw.subject as string) ?? '';
            const from = (raw.from as string) ?? '';
            const source = getSourceType(subject);
            const direction = getDirection(subject, from);
            const badgeCfg = SOURCE_BADGE_CONFIG[source];

            return (
              <div key={(raw.id as string) ?? i} className="relative">
                <div className="absolute top-3 right-3 z-10 flex items-center gap-1 pointer-events-none">
                  <span className="text-xs text-muted-foreground" aria-label={direction}>
                    {DIRECTION_SYMBOL[direction]}
                  </span>
                  <Badge variant="outline" className={badgeCfg.className}>
                    {badgeCfg.label}
                  </Badge>
                </div>
                <MessageRow message={raw} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
