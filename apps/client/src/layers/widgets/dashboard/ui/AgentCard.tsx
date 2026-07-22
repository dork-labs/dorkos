/**
 * One agent card in the dashboard "Your agents" section: avatar, name, and a
 * one-line human status. Clicking anywhere opens a session with that agent.
 *
 * @module widgets/dashboard/ui/AgentCard
 */
import { AgentAvatar } from '@/layers/entities/agent';
import { agentCardStatusLabel } from '../lib/agent-card-status';
import type { DashboardAgentCard } from '../lib/order-agent-cards';

/** Props for {@link AgentCard}. */
export interface AgentCardProps {
  /** The card view model. */
  card: DashboardAgentCard;
  /** Open a session with this agent. */
  onSelect: () => void;
}

/** A single clickable agent card. */
export function AgentCard({ card, onSelect }: AgentCardProps) {
  const status = agentCardStatusLabel(card.attention, card.lastActivityIso);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Open a session with ${card.displayName}`}
      className="bg-card shadow-soft card-interactive flex w-full items-center gap-3 rounded-lg border p-3 text-left"
    >
      <AgentAvatar color={card.color} emoji={card.emoji} size="md" className="flex-shrink-0" />
      <div className="min-w-0">
        <p className="text-foreground truncate text-sm font-medium">{card.displayName}</p>
        <p className="text-muted-foreground truncate text-xs">{status}</p>
      </div>
    </button>
  );
}
