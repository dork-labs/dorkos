import { X } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { useAppStore } from '@/layers/shared/model';
import { AgentIdentity } from '@/layers/entities/agent';
import { useAgentHubContext } from '../model/agent-hub-context';
import { resolveAgentVisual } from '@/layers/entities/agent';

/**
 * Header bar for the Agent Hub panel.
 *
 * Displays the active agent's avatar and name, and a close button that
 * collapses the right panel.
 */
export function AgentHubHeader() {
  const { agent } = useAgentHubContext();
  const setRightPanelOpen = useAppStore((s) => s.setRightPanelOpen);

  const visual = resolveAgentVisual(agent);

  return (
    <div
      data-slot="agent-hub-header"
      className="flex items-center justify-between border-b px-3 py-2"
    >
      <AgentIdentity
        color={visual.color}
        emoji={visual.emoji}
        name={agent.displayName ?? agent.name}
        size="sm"
      />
      <Button
        variant="ghost"
        size="icon"
        aria-label="Close agent hub"
        className="size-7 shrink-0"
        onClick={() => setRightPanelOpen(false)}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
