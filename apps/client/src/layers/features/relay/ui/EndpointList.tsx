import { Inbox, Radio } from 'lucide-react';
import { useRelayEndpoints } from '@/layers/entities/relay';
import { cn } from '@/layers/shared/lib';
import { getStatusDotColor } from '../lib/status-colors';
import { resolveSubjectLabelLocal } from '../lib/resolve-label';

interface EndpointListProps {
  enabled: boolean;
  onSelectEndpoint?: (subject: string) => void;
}

/** Format an ISO timestamp as a relative time string. */
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

/** List of registered relay endpoints with health indicators and card layout. */
export function EndpointList({ enabled, onSelectEndpoint }: EndpointListProps) {
  const { data: endpoints = [], isLoading } = useRelayEndpoints(enabled);

  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        {[1, 2].map((i) => (
          <div key={i} className="rounded-lg border p-3">
            <div className="h-4 w-48 animate-pulse rounded bg-muted" />
            <div className="mt-1.5 h-3 w-32 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
    );
  }

  if (endpoints.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
        <Inbox className="size-10 text-muted-foreground/50" />
        <div className="space-y-1">
          <p className="text-sm font-medium">No endpoints registered</p>
          <p className="text-sm text-muted-foreground">
            Endpoints are created automatically when adapters subscribe to message subjects.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2 p-4">
      {endpoints.map((ep) => {
        const endpoint = ep as Record<string, unknown>;
        const subject = endpoint.subject as string;
        const status = (endpoint.status as string | undefined) ?? 'healthy';
        const description = endpoint.description as string | undefined;
        const messageCount = endpoint.messageCount as number | undefined;
        const lastActivity = endpoint.lastActivity as string | undefined;

        return (
          <button
            key={subject}
            type="button"
            onClick={() => onSelectEndpoint?.(subject)}
            className="w-full rounded-lg border p-3 text-left transition-shadow hover:shadow-sm"
          >
            <div className="flex items-center gap-2">
              <span
                className={cn('size-2 shrink-0 rounded-full', getStatusDotColor(status))}
                aria-label={`Status: ${status}`}
              />
              <Inbox className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium">{resolveSubjectLabelLocal(subject)}</span>
                <p className="truncate font-mono text-xs text-muted-foreground">{subject}</p>
              </div>
            </div>
            {description != null && (
              <p className="mt-1 text-xs text-muted-foreground">{description}</p>
            )}
            {(messageCount != null || lastActivity != null) && (
              <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
                {messageCount != null && <span>{messageCount} messages</span>}
                {lastActivity != null && <span>{formatTimeAgo(lastActivity)}</span>}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
