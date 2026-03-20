import { useState, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronDown, ChevronRight, Route } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { useCreateBinding, useBindings } from '@/layers/entities/binding';
import { getStatusDotColor, getStatusTextColor, getStatusBorderColor } from '../lib/status-colors';
import { formatTimeAgo } from '../lib/format-time';
import { MessageTrace } from './MessageTrace';
import { BindingDialog, type BindingFormValues } from '@/layers/features/mesh/ui/BindingDialog';
import type { RelayConversation } from '@dorkos/shared/relay-schemas';

interface ConversationRowProps {
  conversation: RelayConversation;
}

/**
 * Attempt to extract an adapterId from conversation metadata.
 *
 * Adapter ID may be embedded in the `payload` if the conversation carries
 * relay trace metadata, or can be inferred from the source subject for known
 * patterns (e.g., `relay.human.telegram.12345`).
 *
 * @param conversation - The relay conversation record
 * @returns The adapter ID string, or empty string when unavailable
 */
function extractAdapterId(conversation: RelayConversation): string {
  // Prefer explicit adapterId from payload metadata
  if (conversation.payload && typeof conversation.payload === 'object') {
    const payload = conversation.payload as Record<string, unknown>;
    if (typeof payload.adapterId === 'string') return payload.adapterId;
  }
  // Infer from subject: relay.human.<platform>.<chatId>
  const match = conversation.from.raw.match(/^relay\.human\.([^.]+)/);
  if (match) return match[1];
  return '';
}

/**
 * Attempt to extract a chatId from conversation metadata.
 *
 * Chat ID may be embedded in the `payload` if the conversation carries
 * relay trace metadata.
 *
 * @param conversation - The relay conversation record
 * @returns The chat ID string, or undefined when unavailable
 */
function extractChatId(conversation: RelayConversation): string | undefined {
  if (conversation.payload && typeof conversation.payload === 'object') {
    const payload = conversation.payload as Record<string, unknown>;
    if (typeof payload.chatId === 'string') return payload.chatId;
  }
  return undefined;
}

/**
 * Attempt to extract a channelType from conversation metadata.
 *
 * Channel type may be embedded in the `payload` if the conversation carries
 * relay trace metadata.
 *
 * @param conversation - The relay conversation record
 * @returns The channel type string, or undefined when unavailable
 */
function extractChannelType(
  conversation: RelayConversation
): BindingFormValues['channelType'] | undefined {
  if (conversation.payload && typeof conversation.payload === 'object') {
    const payload = conversation.payload as Record<string, unknown>;
    const ct = payload.channelType;
    if (ct === 'dm' || ct === 'group' || ct === 'channel' || ct === 'thread') return ct;
  }
  return undefined;
}

const STATUS_LABELS: Record<RelayConversation['status'], string> = {
  delivered: 'Delivered',
  failed: 'Failed',
  pending: 'Pending',
};

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
  const [routeAgentId, setRouteAgentId] = useState('');
  const [routePopoverOpen, setRoutePopoverOpen] = useState(false);
  const [bindingDialogOpen, setBindingDialogOpen] = useState(false);

  const { data: agentsData } = useRegisteredAgents();
  const agents = useMemo(() => agentsData?.agents ?? [], [agentsData]);
  const { mutate: createBinding } = useCreateBinding();
  const { data: allBindings = [] } = useBindings();
  const extractedAdapterId = extractAdapterId(conversation);
  const existingBindings = useMemo(
    () => allBindings.filter((b) => b.adapterId === extractedAdapterId),
    [allBindings, extractedAdapterId]
  );

  const dotColor = getStatusDotColor(conversation.status);
  const textColor = getStatusTextColor(conversation.status);
  const borderColor = getStatusBorderColor(conversation.status);

  const handleQuickRoute = useCallback(() => {
    const agent = agents.find((a) => a.id === routeAgentId);
    if (!agent) return;
    createBinding({
      adapterId: extractAdapterId(conversation),
      agentId: routeAgentId,
      sessionStrategy: 'per-chat',
      label: '',
      chatId: extractChatId(conversation),
      channelType: extractChannelType(conversation),
    });
    setRouteAgentId('');
    setRoutePopoverOpen(false);
  }, [agents, routeAgentId, conversation, createBinding]);

  const handleRouteAdvanced = useCallback(() => {
    setRoutePopoverOpen(false);
    setBindingDialogOpen(true);
  }, []);

  const handleBindingDialogConfirm = useCallback(
    (values: BindingFormValues) => {
      createBinding({
        adapterId: values.adapterId,
        agentId: values.agentId,
        sessionStrategy: values.sessionStrategy,
        label: values.label,
        chatId: values.chatId,
        channelType: values.channelType,
        canInitiate: values.canInitiate,
        canReply: values.canReply,
        canReceive: values.canReceive,
      });
      setBindingDialogOpen(false);
    },
    [createBinding]
  );

  return (
    <div
      className={cn(
        'hover:bg-muted/50 w-full rounded-lg border border-l-2 text-left transition-colors hover:shadow-sm',
        borderColor,
        expanded && 'bg-muted/30'
      )}
    >
      {/* Collapsed view — human-readable summary */}
      <div className="flex items-start gap-2 p-3">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex min-w-0 flex-1 items-start gap-2"
        >
          <span className={cn('mt-1 size-2 shrink-0 rounded-full', dotColor)} />
          <div className="min-w-0 flex-1 text-left">
            <div className="text-muted-foreground text-xs">
              <span className="inline-block w-8 font-medium">From</span>
              <span className="text-foreground">{conversation.from.label}</span>
            </div>
            <div className="text-muted-foreground text-xs">
              <span className="inline-block w-8 font-medium">To</span>
              <span className="text-foreground">{conversation.to.label}</span>
            </div>
            <div className="mt-1 flex items-center gap-2">
              {conversation.preview && (
                <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                  &quot;{conversation.preview}&quot;
                </span>
              )}
              <span className={cn('shrink-0 text-xs', textColor)}>
                {buildOutcome(conversation)}
              </span>
            </div>
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-1">
          <span className="text-muted-foreground text-xs">
            {formatTimeAgo(conversation.sentAt)}
          </span>

          {/* Route to Agent popover */}
          <Popover open={routePopoverOpen} onOpenChange={setRoutePopoverOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-xs"
                onClick={(e) => e.stopPropagation()}
                aria-label="Route to agent"
              >
                <Route className="mr-1 size-3" />
                Route
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64 space-y-3 p-3" align="end">
              <p className="text-xs font-medium">Route to Agent</p>
              {existingBindings.length > 0 && (
                <div className="rounded border border-blue-200 bg-blue-50 px-2 py-1.5 text-xs dark:border-blue-900 dark:bg-blue-950">
                  <p className="font-medium text-blue-800 dark:text-blue-200">
                    {existingBindings.length} binding{existingBindings.length !== 1 ? 's' : ''}{' '}
                    already exist{existingBindings.length === 1 ? 's' : ''} for this adapter
                  </p>
                </div>
              )}
              <Select value={routeAgentId} onValueChange={setRouteAgentId}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Select agent" />
                </SelectTrigger>
                <SelectContent>
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center justify-between">
                <Button
                  variant="link"
                  size="sm"
                  className="h-6 px-0 text-xs"
                  onClick={handleRouteAdvanced}
                >
                  More options...
                </Button>
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  disabled={!routeAgentId}
                  onClick={handleQuickRoute}
                >
                  Create Binding
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* Full BindingDialog for advanced routing (More options...) */}
      {bindingDialogOpen && (
        <BindingDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) setBindingDialogOpen(false);
          }}
          mode="create"
          initialValues={{
            adapterId: extractAdapterId(conversation),
            agentId: routeAgentId || undefined,
            chatId: extractChatId(conversation),
            channelType: extractChannelType(conversation),
          }}
          onConfirm={handleBindingDialogConfirm}
        />
      )}

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
            <div className="space-y-3 border-t px-3 pt-3 pb-3">
              {/* Payload */}
              {conversation.payload != null && (
                <div>
                  <span className="text-muted-foreground text-xs font-medium">Payload</span>
                  <pre className="bg-muted mt-1 max-h-40 overflow-auto rounded p-2 font-mono text-xs">
                    {JSON.stringify(conversation.payload, null, 2)}
                  </pre>
                </div>
              )}

              {/* Delivery timing */}
              <div className="text-muted-foreground text-xs">
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
                <div className="bg-destructive/10 text-destructive rounded px-2 py-1 text-xs">
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
                className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-xs"
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
                      <dt className="text-muted-foreground">Source</dt>
                      <dd className="truncate font-mono">{conversation.from.raw}</dd>
                      <dt className="text-muted-foreground">Destination</dt>
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
                    className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-xs"
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
