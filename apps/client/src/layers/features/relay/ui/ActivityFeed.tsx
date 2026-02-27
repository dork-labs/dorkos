import { type RefObject, useEffect, useRef, useState } from 'react';
import { Inbox, Search } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useRelayMessages } from '@/layers/entities/relay';
import {
  Badge,
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui';
import { MessageRow } from './MessageRow';
import { DeadLetterSection } from './DeadLetterSection';
import { ComposeMessageDialog } from './ComposeMessageDialog';

interface ActivityFeedProps {
  enabled: boolean;
  /** Ref attached to the dead-letter section wrapper for scroll-to support. */
  deadLetterRef?: RefObject<HTMLDivElement | null>;
  /** Called when the user clicks "Set up an adapter" in the no-messages empty state. */
  onSwitchToAdapters?: () => void;
}

type SourceType = 'telegram' | 'webhook' | 'system';
type SourceFilter = 'all' | SourceType;
type StatusFilter = 'all' | 'delivered' | 'failed' | 'pending';
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

/** Animation props for messages that appear after initial load (SSE-delivered). */
const NEW_MESSAGE_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, height: 0 },
  transition: { duration: 0.2, ease: 'easeOut' },
} as const;

/** Animation props for history messages present on first render. */
const HISTORY_MESSAGE_ANIMATION = {
  initial: false,
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, height: 0 },
  transition: { duration: 0.2, ease: 'easeOut' },
} as const;

/** Apply all active filters to the message list. */
function applyFilters(
  messages: unknown[],
  sourceFilter: SourceFilter,
  statusFilter: StatusFilter,
  subjectFilter: string,
): unknown[] {
  return messages.filter((msg) => {
    const raw = msg as Record<string, unknown>;
    const subject = (raw.subject as string) ?? '';
    const status = (raw.status as string) ?? '';

    if (sourceFilter !== 'all' && getSourceType(subject) !== sourceFilter) return false;

    if (statusFilter !== 'all') {
      if (statusFilter === 'delivered' && status !== 'cur') return false;
      if (statusFilter === 'failed' && status !== 'failed' && status !== 'dead_letter') return false;
      if (statusFilter === 'pending' && status !== 'new') return false;
    }

    if (subjectFilter && !subject.toLowerCase().includes(subjectFilter.toLowerCase())) return false;

    return true;
  });
}

/** Chronological message list with source/direction indicators and multi-filter bar. */
export function ActivityFeed({ enabled, deadLetterRef, onSwitchToAdapters }: ActivityFeedProps) {
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [subjectFilter, setSubjectFilter] = useState('');
  const { data, isLoading } = useRelayMessages(undefined, enabled);
  const messages = data?.messages ?? [];

  // Track which message IDs were present on first render so history messages
  // are not animated — only SSE-delivered messages that arrive later get entrance animations.
  const initialIdsRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (messages.length > 0 && initialIdsRef.current === null) {
      initialIdsRef.current = new Set(
        messages.map((m) => (m as Record<string, unknown>).id as string),
      );
    }
  }, [messages]);

  const hasActiveFilters = sourceFilter !== 'all' || statusFilter !== 'all' || subjectFilter !== '';

  const filteredMessages = applyFilters(messages, sourceFilter, statusFilter, subjectFilter);

  function clearFilters() {
    setSourceFilter('all');
    setStatusFilter('all');
    setSubjectFilter('');
  }

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
      <div ref={deadLetterRef}>
        <DeadLetterSection enabled={enabled} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={sourceFilter} onValueChange={(v) => setSourceFilter(v as SourceFilter)}>
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

        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="delivered">Delivered</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
          </SelectContent>
        </Select>

        <Input
          className="h-9 w-44"
          placeholder="Filter by subject..."
          value={subjectFilter}
          onChange={(e) => setSubjectFilter(e.target.value)}
          aria-label="Filter by subject"
        />

        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        )}

        <div className="ml-auto">
          <ComposeMessageDialog />
        </div>
      </div>

      {filteredMessages.length === 0 && !hasActiveFilters ? (
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
          <Inbox className="size-10 text-muted-foreground/50" />
          <div className="space-y-1">
            <p className="text-sm font-medium">No messages yet</p>
            <p className="text-sm text-muted-foreground">
              Messages will appear here once your adapters are connected and agents start communicating.
            </p>
          </div>
          {onSwitchToAdapters && (
            <Button variant="outline" size="sm" onClick={onSwitchToAdapters}>
              Set up an adapter
            </Button>
          )}
        </div>
      ) : filteredMessages.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
          <Search className="size-10 text-muted-foreground/50" />
          <div className="space-y-1">
            <p className="text-sm font-medium">No messages match your filters</p>
            <p className="text-sm text-muted-foreground">
              Try adjusting your filter criteria.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <AnimatePresence mode="popLayout">
            {filteredMessages.map((msg, i) => {
              const raw = msg as Record<string, unknown>;
              const subject = (raw.subject as string) ?? '';
              const from = (raw.from as string) ?? '';
              const source = getSourceType(subject);
              const direction = getDirection(subject, from);
              const badgeCfg = SOURCE_BADGE_CONFIG[source];
              const msgId = (raw.id as string) ?? String(i);
              const isNew = initialIdsRef.current !== null && !initialIdsRef.current.has(msgId);
              const animProps = isNew ? NEW_MESSAGE_ANIMATION : HISTORY_MESSAGE_ANIMATION;

              return (
                <motion.div
                  key={msgId}
                  {...animProps}
                  className="relative"
                >
                  <div className="pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-1">
                    <span className="text-xs text-muted-foreground" aria-label={direction}>
                      {DIRECTION_SYMBOL[direction]}
                    </span>
                    <Badge variant="outline" className={badgeCfg.className}>
                      {badgeCfg.label}
                    </Badge>
                  </div>
                  <MessageRow message={raw} />
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
