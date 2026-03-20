import { Settings, X } from 'lucide-react';
import { Badge } from '@/layers/shared/ui/badge';
import { useMeshAgentHealth } from '@/layers/entities/mesh';
import { relativeTime } from '../lib/relative-time';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_INFO = {
  active: { label: 'Active', color: 'bg-green-500' },
  inactive: { label: 'Inactive', color: 'bg-amber-500' },
  stale: { label: 'Stale', color: 'bg-zinc-400' },
} as const;

type AgentStatus = keyof typeof STATUS_INFO;

function isAgentStatus(value: string): value is AgentStatus {
  return value in STATUS_INFO;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface CloseButtonProps {
  onClick: () => void;
}

function CloseButton({ onClick }: CloseButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Close detail panel"
      className="text-muted-foreground hover:text-foreground"
    >
      <X className="size-(--size-icon-sm)" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

interface AgentHealthDetailProps {
  /** ID of the agent to show health details for. */
  agentId: string;
  /** Callback invoked when the user closes the detail panel. */
  onClose: () => void;
  /** Optional callback to open the agent settings dialog. */
  onOpenSettings?: () => void;
}

/**
 * Side-panel showing detailed health information for a specific mesh agent.
 *
 * Renders a loading state while the query is in flight and a "not found"
 * message when no health data is available for the given `agentId`.
 */
export function AgentHealthDetail({ agentId, onClose, onOpenSettings }: AgentHealthDetailProps) {
  const { data: health, isLoading } = useMeshAgentHealth(agentId);

  if (isLoading) {
    return (
      <div className="flex w-64 items-center justify-center border-l p-4">
        <span className="text-muted-foreground text-sm">Loading...</span>
      </div>
    );
  }

  if (!health) {
    return (
      <div className="w-64 border-l p-4">
        <div className="flex justify-end">
          <CloseButton onClick={onClose} />
        </div>
        <p className="text-muted-foreground mt-2 text-sm">Agent not found</p>
      </div>
    );
  }

  const statusKey = isAgentStatus(health.status) ? health.status : 'stale';
  const statusInfo = STATUS_INFO[statusKey];

  return (
    <div className="w-64 overflow-y-auto border-l p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="truncate text-sm font-semibold">{health.name}</h3>
        <CloseButton onClick={onClose} />
      </div>

      <div className="space-y-3 text-xs">
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${statusInfo.color}`} aria-hidden="true" />
          <span>{statusInfo.label}</span>
        </div>

        <div>
          <span className="text-muted-foreground">Last seen: </span>
          <span>{relativeTime(health.lastSeenAt)}</span>
        </div>

        {health.lastSeenEvent && (
          <div>
            <span className="text-muted-foreground">Last event: </span>
            <span>{health.lastSeenEvent}</span>
          </div>
        )}

        <div>
          <span className="text-muted-foreground">Runtime: </span>
          <Badge variant="secondary" className="text-[0.625rem]">
            {health.runtime}
          </Badge>
        </div>

        <div>
          <span className="text-muted-foreground">Registered: </span>
          <span>{relativeTime(health.registeredAt)}</span>
        </div>

        {Array.isArray(health.capabilities) && health.capabilities.length > 0 && (
          <div>
            <span className="text-muted-foreground mb-1 block">Capabilities:</span>
            <div className="flex flex-wrap gap-1">
              {health.capabilities.map((cap: string) => (
                <Badge key={cap} variant="outline" className="text-[0.625rem]">
                  {cap}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </div>

      {onOpenSettings && (
        <div className="mt-4 border-t pt-3">
          <button
            type="button"
            onClick={onOpenSettings}
            className="hover:bg-muted inline-flex w-full items-center justify-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium"
          >
            <Settings className="size-3.5" />
            Open Settings
          </button>
        </div>
      )}
    </div>
  );
}
