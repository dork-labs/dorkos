/**
 * The dashboard "Your agents" section: up to six messageable agent cards
 * (default agent first, then recency), with an overflow link to the full fleet.
 *
 * @module widgets/dashboard/ui/YourAgentsSection
 */
import { useNavigate, Link } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';
import { useDashboardAgents } from '../model/use-dashboard-agents';
import { MAX_AGENT_CARDS } from '../lib/order-agent-cards';
import { AgentCard } from './AgentCard';

/** The messageable agent cards on the dashboard. */
export function YourAgentsSection() {
  const navigate = useNavigate();
  const { cards } = useDashboardAgents();

  if (cards.length === 0) return null;

  const visible = cards.slice(0, MAX_AGENT_CARDS);
  const hasOverflow = cards.length > MAX_AGENT_CARDS;

  return (
    <section>
      <h2 className="text-muted-foreground mb-3 text-xs font-medium tracking-widest uppercase">
        Your agents
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((card) => (
          <AgentCard
            key={card.path}
            card={card}
            onSelect={() => navigate({ to: '/session', search: { dir: card.path } })}
          />
        ))}
      </div>
      {hasOverflow && (
        <div className="mt-3">
          <Link
            to="/agents"
            className="text-muted-foreground hover:text-foreground focus-ring inline-flex items-center gap-1 rounded-md text-xs font-medium transition-colors"
          >
            All agents
            <ArrowRight className="size-3" />
          </Link>
        </div>
      )}
    </section>
  );
}
