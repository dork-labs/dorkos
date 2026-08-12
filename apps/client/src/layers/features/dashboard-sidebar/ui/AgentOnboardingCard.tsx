import { Plus } from 'lucide-react';

interface AgentOnboardingCardProps {
  onAddAgent: () => void;
}

/**
 * The invitation drawn in place of Library, on the one morning there is nothing
 * to put in it.
 *
 * **Separation is tint, never a line (spec `sidebar-now-today-library` R1).**
 * It was a dashed outline over a `--muted` word, which made a brand-new panel
 * the only surface in the cockpit still drawing a box — on precisely the
 * morning calm is worth most. It now sits on the same `--sidebar-accent`/40
 * step the zones use, and the invitation is carried by the tint and the words
 * rather than by a rule around them.
 *
 * The `mx-1` went with the border. The panel pays its inset once (8px) and this
 * card pays the row's other 8px, so its words line up with every row above it
 * instead of sitting four pixels further in than all of them.
 */
export function AgentOnboardingCard({ onAddAgent }: AgentOnboardingCardProps) {
  return (
    <div className="bg-sidebar-accent/40 mt-2 rounded-lg px-2 py-2.5">
      <p className="text-sidebar-foreground/70 text-xs leading-relaxed">
        Add more agents to your fleet. Each agent can be configured with its own tools, personality,
        and project context.
      </p>
      <button
        type="button"
        onClick={onAddAgent}
        className="text-sidebar-foreground/70 hover:text-sidebar-foreground focus-visible:ring-sidebar-ring mt-2 flex items-center gap-1.5 rounded-sm text-xs font-medium outline-hidden transition-colors focus-visible:ring-2"
      >
        <Plus className="size-3.5" />
        Add agent
      </button>
    </div>
  );
}
