import { Settings, User, X } from 'lucide-react';
import type { AgentHealthStatus } from '@dorkos/shared/mesh-schemas';
import { Badge } from '@/layers/shared/ui/badge';
import { useMeshAgentHealth } from '@/layers/entities/mesh';
import { useProfileDeepLink } from '@/layers/shared/model';
import { cn, formatRelativeTime } from '@/layers/shared/lib';
import { HEALTH_DISPLAY } from '../lib/health-display';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Whether a health string off the wire is one this build knows how to draw. */
function isAgentStatus(value: string): value is AgentHealthStatus {
  return value in HEALTH_DISPLAY;
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
  /**
   * ID of the agent to show health details for — the mesh registry id, which is
   * also the id the team roster and the profile drawer file this agent under.
   */
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
 *
 * **About mesh health, not identity** (spec `identity-consistency` §W2.5). It is
 * deliberately not grown into a profile: its "View profile" button opens the one
 * profile drawer every other face in the cockpit opens, and everything about who
 * this agent IS belongs there rather than being restated here.
 */
export function AgentHealthDetail({ agentId, onClose, onOpenSettings }: AgentHealthDetailProps) {
  const { data: health, isLoading } = useMeshAgentHealth(agentId);
  const { open: openProfile } = useProfileDeepLink();

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
  const statusInfo = HEALTH_DISPLAY[statusKey];

  return (
    <div className="w-64 overflow-y-auto border-l p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="truncate text-sm font-semibold">{health.name}</h3>
        <CloseButton onClick={onClose} />
      </div>

      <div className="space-y-3 text-xs">
        <div className="flex items-center gap-2">
          <span className={cn('h-2.5 w-2.5 rounded-full', statusInfo.dot)} aria-hidden="true" />
          <span>{statusInfo.label}</span>
        </div>

        <div>
          <span className="text-muted-foreground">Last seen: </span>
          <span>{health.lastSeenAt ? formatRelativeTime(health.lastSeenAt) : 'Never'}</span>
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
          <span>{health.registeredAt ? formatRelativeTime(health.registeredAt) : 'Unknown'}</span>
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

      <div className="mt-4 space-y-2 border-t pt-3">
        <button
          type="button"
          onClick={() => openProfile(agentId)}
          className="hover:bg-muted inline-flex w-full items-center justify-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium"
        >
          <User className="size-3.5" />
          View profile
        </button>
        {onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            className="hover:bg-muted inline-flex w-full items-center justify-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium"
          >
            <Settings className="size-3.5" />
            Open Settings
          </button>
        )}
      </div>
    </div>
  );
}
