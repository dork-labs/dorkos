import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Badge } from '@/layers/shared/ui/badge';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

interface AgentCardProps {
  agent: AgentManifest;
  onEdit: (agent: AgentManifest) => void;
  onUnregister: (agentId: string) => void;
}

/** Displays a registered agent with expandable details and edit/unregister actions. */
export function AgentCard({ agent, onEdit, onUnregister }: AgentCardProps) {
  const [expanded, setExpanded] = useState(false);

  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center justify-between">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <button
            onClick={() => setExpanded(!expanded)}
            className="shrink-0 rounded p-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-label={expanded ? 'Collapse details' : 'Expand details'}
          >
            <Chevron className="size-4 text-muted-foreground" />
          </button>
          <span className="truncate text-sm font-medium text-foreground">{agent.name}</span>
          <Badge variant="secondary" className="text-xs">
            {agent.runtime}
          </Badge>
        </div>
        <div className="ml-3 flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => onEdit(agent)}
            className="rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Edit
          </button>
          <button
            onClick={() => onUnregister(agent.id)}
            className="rounded-md bg-red-600/10 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-600/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 dark:text-red-400"
          >
            Unregister
          </button>
        </div>
      </div>

      {agent.capabilities.length > 0 && (
        <div className="mt-1.5 ml-7 flex flex-wrap gap-1">
          {agent.capabilities.map((cap) => (
            <Badge key={cap} variant="secondary" className="text-[10px]">
              {cap}
            </Badge>
          ))}
        </div>
      )}

      {expanded && (
        <div className="mt-2 ml-7 space-y-1 text-xs text-muted-foreground">
          {agent.description && <div>{agent.description}</div>}
          <div>
            Registered {new Date(agent.registeredAt).toLocaleDateString()} by{' '}
            {agent.registeredBy}
          </div>
          <div>
            Mode: {agent.behavior.responseMode === 'always' ? 'Always respond' : agent.behavior.responseMode}
            {agent.behavior.escalationThreshold !== undefined &&
              ` | Escalation threshold: ${agent.behavior.escalationThreshold}`}
          </div>
          <div>
            Relay depth: {agent.budget.maxHopsPerMessage} hops | Rate limit:{' '}
            {agent.budget.maxCallsPerHour}/hr
          </div>
        </div>
      )}
    </div>
  );
}
