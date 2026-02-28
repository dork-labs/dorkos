import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { getStatusDotColor, getStatusTextColor, getStatusBorderColor } from '../lib/status-colors';
import { MessageTrace } from './MessageTrace';
import type { RelayConversation } from '@dorkos/shared/relay-schemas';

interface ConversationRowProps {
  conversation: RelayConversation;
}

const STATUS_LABELS: Record<RelayConversation['status'], string> = {
  delivered: 'Delivered',
  failed: 'Failed',
  pending: 'Pending',
};

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Build outcome string from conversation status and metadata. */
function buildOutcome(conversation: RelayConversation): string {
  if (conversation.status === 'delivered') {
    return conversation.responseCount > 0
      ? `delivered \u00b7 ${conversation.responseCount} chunks`
      : 'delivered';
  }
  return conversation.failureReason ?? STATUS_LABELS[conversation.status].toLowerCase();
}

/** Conversation card with progressive disclosure: human labels, payload, technical details. */
export function ConversationRow({ conversation }: ConversationRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);
  const [showTrace, setShowTrace] = useState(false);

  const dotColor = getStatusDotColor(conversation.status);
  const textColor = getStatusTextColor(conversation.status);
  const borderColor = getStatusBorderColor(conversation.status);

  return (
    <div
      className={cn(
        'w-full rounded-lg border border-l-2 text-left transition-colors hover:bg-muted/50 hover:shadow-sm',
        borderColor,
        expanded && 'bg-muted/30',
      )}
    >
      {/* Collapsed view — human-readable summary */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full p-3"
      >
        <div className="flex items-center gap-2">
          <span className={cn('size-2 shrink-0 rounded-full', dotColor)} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {conversation.from.label}
            <span className="mx-1.5 text-muted-foreground">&rarr;</span>
            {conversation.to.label}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatTimeAgo(conversation.sentAt)}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2">
          {conversation.preview && (
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
              &quot;{conversation.preview}&quot;
            </span>
          )}
          <span className={cn('shrink-0 text-xs', textColor)}>
            {buildOutcome(conversation)}
          </span>
        </div>
      </button>

      {/* Expanded view — payload + delivery details */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="space-y-3 border-t px-3 pb-3 pt-3">
              {/* Payload */}
              {conversation.payload != null && (
                <div>
                  <span className="text-xs font-medium text-muted-foreground">Payload</span>
                  <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-xs">
                    {JSON.stringify(conversation.payload, null, 2)}
                  </pre>
                </div>
              )}

              {/* Delivery timing */}
              <div className="text-xs text-muted-foreground">
                <span>Sent {formatTime(conversation.sentAt)}</span>
                {conversation.completedAt && (
                  <span> &middot; Completed {formatTime(conversation.completedAt)}</span>
                )}
                {conversation.durationMs != null && (
                  <span> &middot; Duration: {formatDuration(conversation.durationMs)}</span>
                )}
                {conversation.responseCount > 0 && (
                  <span> &middot; {conversation.responseCount} response chunks</span>
                )}
              </div>

              {/* Failure reason */}
              {conversation.failureReason && (
                <div className="rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">
                  {conversation.failureReason}
                </div>
              )}

              {/* Technical Details accordion */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowTechnical(!showTechnical);
                }}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                {showTechnical ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
                Technical Details
              </button>
              <AnimatePresence initial={false}>
                {showTechnical && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="overflow-hidden"
                  >
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                      <dt className="text-muted-foreground">Subject</dt>
                      <dd className="truncate font-mono">{conversation.subject}</dd>
                      {conversation.sessionId && (
                        <>
                          <dt className="text-muted-foreground">Session</dt>
                          <dd className="font-mono">{conversation.sessionId.slice(0, 8)}</dd>
                        </>
                      )}
                      {conversation.traceId && (
                        <>
                          <dt className="text-muted-foreground">Trace ID</dt>
                          <dd className="font-mono">{conversation.traceId.slice(0, 12)}&hellip;</dd>
                        </>
                      )}
                      <dt className="text-muted-foreground">From (raw)</dt>
                      <dd className="truncate font-mono">{conversation.from.raw}</dd>
                      <dt className="text-muted-foreground">To (raw)</dt>
                      <dd className="truncate font-mono">{conversation.to.raw}</dd>
                    </dl>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Trace Timeline accordion */}
              {conversation.traceId && (
                <>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowTrace(!showTrace);
                    }}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                  >
                    {showTrace ? (
                      <ChevronDown className="size-3.5" />
                    ) : (
                      <ChevronRight className="size-3.5" />
                    )}
                    Trace Timeline
                  </button>
                  <AnimatePresence initial={false}>
                    {showTrace && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className="overflow-hidden"
                      >
                        <MessageTrace
                          messageId={conversation.traceId}
                          onClose={() => setShowTrace(false)}
                        />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
