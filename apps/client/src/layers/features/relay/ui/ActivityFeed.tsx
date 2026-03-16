import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Inbox, Search } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useRelayConversations, useAggregatedDeadLetters } from '@/layers/entities/relay';
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui';
import { ConversationRow } from './ConversationRow';
import { DeadLetterSection } from './DeadLetterSection';
import { ComposeMessageDialog } from './ComposeMessageDialog';
import { MetricsSummary } from './MetricsSummary';
import type { RelayConversation } from '@dorkos/shared/relay-schemas';

interface ActivityFeedProps {
  enabled: boolean;
  /** Ref attached to the dead-letter section wrapper for scroll-to support. */
  deadLetterRef?: RefObject<HTMLDivElement | null>;
  /** Called when the user clicks "Set up an adapter" in the no-messages empty state. */
  onSwitchToAdapters?: () => void;
  /** When true, forces the dead-letter section open. Used by the health bar click handler. */
  autoShowFailures?: boolean;
}

type SourceFilter = 'all' | 'chat' | 'pulse' | 'system';
type StatusFilter = 'all' | 'delivered' | 'failed' | 'pending';

/** Derive a human-readable source category from the raw subject. */
function getSourceCategory(subject: string): 'chat' | 'pulse' | 'system' {
  if (subject.startsWith('relay.agent.')) return 'chat';
  if (subject.startsWith('relay.system.pulse.')) return 'pulse';
  return 'system';
}

/** Animation props for conversations that appear after initial load (SSE-delivered). */
const NEW_ITEM_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, height: 0 },
  transition: { duration: 0.2, ease: 'easeOut' },
} as const;

/** Animation props for history conversations present on first render. */
const HISTORY_ITEM_ANIMATION = {
  initial: false,
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, height: 0 },
  transition: { duration: 0.2, ease: 'easeOut' },
} as const;

/** Apply all active filters to the conversation list. */
function applyFilters(
  conversations: RelayConversation[],
  sourceFilter: SourceFilter,
  statusFilter: StatusFilter,
  searchFilter: string,
): RelayConversation[] {
  return conversations.filter((conv) => {
    if (sourceFilter !== 'all' && getSourceCategory(conv.subject) !== sourceFilter) return false;
    if (statusFilter !== 'all' && conv.status !== statusFilter) return false;

    if (searchFilter) {
      const q = searchFilter.toLowerCase();
      const matchesSearch =
        conv.from.label.toLowerCase().includes(q) ||
        conv.to.label.toLowerCase().includes(q) ||
        conv.preview.toLowerCase().includes(q) ||
        conv.subject.toLowerCase().includes(q);
      if (!matchesSearch) return false;
    }

    return true;
  });
}

/** Chronological conversation feed with source/status filters and search. */
export function ActivityFeed({
  enabled,
  deadLetterRef,
  onSwitchToAdapters: _onSwitchToAdapters,
  autoShowFailures,
}: ActivityFeedProps) {
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [searchFilter, setSearchFilter] = useState('');
  const [showFailures, setShowFailures] = useState(false);
  const [userToggled, setUserToggled] = useState(false);
  const { data, isLoading } = useRelayConversations(enabled);
  const { data: deadLetterGroups = [] } = useAggregatedDeadLetters(enabled);
  const conversations = useMemo(() => data?.conversations ?? [], [data?.conversations]);
  const _hasDeadLetters = deadLetterGroups.length > 0;

  // Track which conversation IDs were present on first render so history items
  // are not animated — only SSE-delivered items that arrive later get entrance animations.
  const initialIdsRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (conversations.length > 0 && initialIdsRef.current === null) {
      initialIdsRef.current = new Set(conversations.map((c) => c.id));
    }
  }, [conversations]);

  // Auto-open the dead-letter section when dead letters arrive, unless the user manually closed it.
  useEffect(() => {
    if (!userToggled && deadLetterGroups.length > 0) {
      setShowFailures(true);
    }
  }, [deadLetterGroups.length, userToggled]);

  // Force the dead-letter section open when the health bar click handler signals it.
  // Also resets userToggled so the auto-show effect can fire again on future arrivals.
  useEffect(() => {
    if (autoShowFailures) {
      setShowFailures(true);
      setUserToggled(false);
    }
  }, [autoShowFailures]);

  const hasActiveFilters = sourceFilter !== 'all' || statusFilter !== 'all' || searchFilter !== '';

  const filteredConversations = applyFilters(conversations, sourceFilter, statusFilter, searchFilter);

  function clearFilters() {
    setSourceFilter('all');
    setStatusFilter('all');
    setSearchFilter('');
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
    <>
    <MetricsSummary enabled={enabled} />
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={sourceFilter} onValueChange={(v) => setSourceFilter(v as SourceFilter)}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            <SelectItem value="chat">Chat messages</SelectItem>
            <SelectItem value="pulse">Pulse jobs</SelectItem>
            <SelectItem value="system">System</SelectItem>
          </SelectContent>
        </Select>

        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="delivered">Delivered</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
          </SelectContent>
        </Select>

        <Button
          variant={showFailures ? 'secondary' : 'ghost'}
          size="sm"
          className="relative"
          onClick={() => {
            setShowFailures(!showFailures);
            setUserToggled(true);
          }}
          aria-pressed={showFailures}
          aria-label="Show dead letters"
        >
          <AlertTriangle className="mr-1 size-3.5" />
          Dead Letters
          {deadLetterGroups.length > 0 && !showFailures && userToggled && (
            <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-red-500" />
          )}
        </Button>

        <Input
          className="h-9 w-44"
          placeholder="Filter by agent or message..."
          value={searchFilter}
          onChange={(e) => setSearchFilter(e.target.value)}
          aria-label="Search conversations"
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

      {showFailures && (
        <div ref={deadLetterRef}>
          <DeadLetterSection enabled={enabled} />
        </div>
      )}

      {filteredConversations.length === 0 && !hasActiveFilters ? (
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
          {/* Ghost preview rows — faded placeholders showing what conversations will look like */}
          <div className="mb-2 w-full max-w-sm select-none opacity-20 pointer-events-none">
            <div className="space-y-2">
              <div className="rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <div className="size-4 rounded bg-muted" />
                  <div className="h-3 w-32 rounded bg-muted" />
                  <div className="ml-auto h-3 w-12 rounded bg-muted" />
                </div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <div className="size-4 rounded bg-muted" />
                  <div className="h-3 w-44 rounded bg-muted" />
                  <div className="ml-auto h-3 w-12 rounded bg-muted" />
                </div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <div className="size-4 rounded bg-muted" />
                  <div className="h-3 w-24 rounded bg-muted" />
                  <div className="ml-auto h-3 w-12 rounded bg-muted" />
                </div>
              </div>
            </div>
          </div>

          <Inbox className="size-10 text-muted-foreground/50" />
          <div className="space-y-1">
            <p className="text-sm font-medium">No activity yet</p>
            <p className="text-sm text-muted-foreground">
              Messages will appear here as your agents communicate
            </p>
          </div>
        </div>
      ) : filteredConversations.length === 0 ? (
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
            {filteredConversations.map((conv) => {
              const isNew = initialIdsRef.current !== null && !initialIdsRef.current.has(conv.id);
              const animProps = isNew ? NEW_ITEM_ANIMATION : HISTORY_ITEM_ANIMATION;

              return (
                <motion.div key={conv.id} {...animProps}>
                  <ConversationRow conversation={conv} />
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </div>
    </>
  )
}
