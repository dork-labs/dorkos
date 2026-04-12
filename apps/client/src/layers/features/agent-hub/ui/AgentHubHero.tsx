import { X } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { useAppStore } from '@/layers/shared/model';
import { AgentAvatar, resolveAgentVisual } from '@/layers/entities/agent';
import type { AgentHealthStatus } from '@dorkos/shared/mesh-schemas';
import { useAgentHubContext } from '../model/agent-hub-context';

// AgentManifest does not carry healthStatus — that lives on TopologyAgent.
// The cast below handles agents enriched at runtime with health data.
type AgentWithHealth = { healthStatus?: AgentHealthStatus };

function deriveStatus(agent: AgentWithHealth): { label: string; className: string } {
  if (agent.healthStatus === 'active') {
    return { label: 'Online', className: 'text-emerald-500' };
  }
  return { label: 'Offline', className: 'text-muted-foreground' };
}

/**
 * Identity hero header for the Agent Hub panel.
 *
 * Replaces the former AgentHubHeader with a richer, centered identity display:
 * 48px avatar with optional status ring, agent name, status + runtime meta row,
 * and a close button positioned absolute top-right.
 *
 * This zone is sticky and never scrolls with tab content below it.
 */
export function AgentHubHero() {
  const { agent } = useAgentHubContext();
  const setRightPanelOpen = useAppStore((s) => s.setRightPanelOpen);

  const visual = resolveAgentVisual(agent);
  const agentWithHealth = agent as unknown as AgentWithHealth;
  const status = deriveStatus(agentWithHealth);

  return (
    <div
      data-slot="agent-hub-hero"
      className="relative flex flex-col items-center gap-1 border-b px-4 py-3"
    >
      {/* Close button — absolute top-right */}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Close agent hub"
        className="absolute top-2 right-2 size-7 shrink-0"
        onClick={() => setRightPanelOpen(false)}
      >
        <X className="size-4" />
      </Button>

      {/* Avatar — lg size (size-12 = 48px) with optional health ring */}
      <AgentAvatar
        color={visual.color}
        emoji={visual.emoji}
        size="lg"
        healthStatus={agentWithHealth.healthStatus}
      />

      {/* Agent name */}
      <span className="text-[15px] font-semibold">{agent.displayName ?? agent.name}</span>

      {/* Meta row: status + runtime */}
      <span className="text-muted-foreground text-[10px]">
        <span className={status.className}>{status.label}</span>
        {' · '}
        {agent.runtime}
      </span>
    </div>
  );
}
