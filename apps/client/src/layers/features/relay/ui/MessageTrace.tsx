import { useMessageTrace } from '@/layers/entities/relay';
import { STATUS_TONE_DOT, type StatusTone } from '@/layers/shared/ui';
import type { TraceSpan } from '@dorkos/shared/relay-schemas';

interface MessageTraceProps {
  messageId: string;
  onClose?: () => void;
}

/**
 * What each span in a trace is saying, in the app's one status vocabulary.
 *
 * `sent` is `info` — the same blue relay draws `pending` and `starting` in,
 * because all three mean "on its way", not "look at me".
 *
 * `no_subscriber` and `timeout` are `neutral`: the message reached nobody, but
 * nothing went wrong. Never the failure red.
 */
const SPAN_TONE: Record<TraceSpan['status'], StatusTone> = {
  delivered: 'success',
  failed: 'error',
  no_subscriber: 'neutral',
  sent: 'info',
  timeout: 'neutral',
};

/** Status color mapping for timeline dots. */
function statusColor(status: TraceSpan['status']): string {
  return STATUS_TONE_DOT[SPAN_TONE[status]];
}

/** Format ISO 8601 timestamp to readable time. */
function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

/** Calculate latency between two ISO timestamps. */
function latencyLabel(from: string | null, to: string | null): string | null {
  if (from == null || to == null) return null;
  const delta = new Date(to).getTime() - new Date(from).getTime();
  return delta < 1000 ? `${delta}ms` : `${(delta / 1000).toFixed(1)}s`;
}

/** Vertical timeline showing the delivery path of a single Relay message. */
export function MessageTrace({ messageId, onClose }: MessageTraceProps) {
  const { data, isLoading, error } = useMessageTrace(messageId);

  if (isLoading) {
    return <div className="text-muted-foreground p-4 text-sm">Loading trace...</div>;
  }

  if (error || !data) {
    return <div className="text-destructive p-4 text-sm">Failed to load trace.</div>;
  }

  const { traceId, spans } = data;

  return (
    <div className="flex flex-col gap-2 p-4">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground font-mono text-xs">
          Trace: {traceId.slice(0, 8)}...
        </span>
        {onClose && (
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xs">
            Close
          </button>
        )}
      </div>

      <div className="border-border relative ml-3 border-l pl-6">
        {spans.map((span) => {
          const deliveryLatency = latencyLabel(span.sentAt, span.deliveredAt);
          const processingLatency = latencyLabel(span.deliveredAt, span.processedAt);

          return (
            <div key={span.id} className="relative pb-4 last:pb-0">
              {/* Timeline dot */}
              <div
                className={`absolute top-1 -left-[calc(1.5rem+0.3125rem)] h-2.5 w-2.5 rounded-full ${statusColor(span.status)}`}
              />

              {/* Span content */}
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium">{span.subject}</span>
                  <span className="bg-muted rounded px-1.5 py-0.5 text-xs">{span.status}</span>
                </div>

                <div className="text-muted-foreground flex gap-3 text-xs">
                  <span>Sent: {formatTime(span.sentAt)}</span>
                  {deliveryLatency && <span>Delivery: {deliveryLatency}</span>}
                  {processingLatency && <span>Processing: {processingLatency}</span>}
                </div>

                {span.errorMessage && (
                  <div className="bg-destructive/10 text-destructive mt-1 rounded px-2 py-1 text-xs">
                    {span.errorMessage}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
