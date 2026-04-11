import { Plus } from 'lucide-react';

interface AgentOnboardingCardProps {
  onAddAgent: () => void;
}

/**
 * Inline onboarding card shown below the agent list when fewer than 3 agents exist.
 *
 * Dashed border card with explanation text and a CTA button.
 * Encourages the user to add more agents to their fleet.
 */
export function AgentOnboardingCard({ onAddAgent }: AgentOnboardingCardProps) {
  return (
    <div className="border-border/50 mx-1 mt-2 rounded-lg border border-dashed p-3">
      <p className="text-muted-foreground text-xs leading-relaxed">
        Add more agents to your fleet. Each agent can be configured with its own tools, personality,
        and project context.
      </p>
      <button
        type="button"
        onClick={onAddAgent}
        className="text-muted-foreground hover:text-foreground mt-2 flex items-center gap-1.5 text-xs font-medium transition-colors"
      >
        <Plus className="size-3.5" />
        Add agent
      </button>
    </div>
  );
}
