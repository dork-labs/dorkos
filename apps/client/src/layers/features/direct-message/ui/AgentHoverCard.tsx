/**
 * The identity card over an agent, with the DM view's actions on it
 * (DOR-3074).
 *
 * @module features/direct-message/ui/AgentHoverCard
 */
import { useCallback, useState, type ReactNode } from 'react';
import { IdentityHoverCard, type IdentityHoverCardDescriptor } from '@/layers/shared/ui';
import { useAgentCard } from '../model/use-agent-card';

/** What {@link AgentHoverCard} needs. */
export interface AgentHoverCardProps {
  /** The identity the card describes, as the surface already resolved it. */
  identity: IdentityHoverCardDescriptor;
  /** The agent's directory, when the surface can name it. */
  agentPath: string | undefined;
  /** Open the agent's profile, the door the surface already offers. */
  onViewProfile?: () => void;
  /** Open the card on a click of the trigger too (a face, a name). */
  openOnClick?: boolean;
  /** The element that opens the card: a face, a name, a mention. */
  children: ReactNode;
}

/**
 * {@link IdentityHoverCard}, plus the agent's role, what it is doing, and
 * Message, Profile and (with Show sessions on) its session in this room.
 *
 * One card, not a second one: with the DM view off, or for an agent the
 * surface cannot name, this is the plain card with today's "View profile"
 * footer. Nothing is read until the card first opens.
 */
export function AgentHoverCard({
  identity,
  agentPath,
  onViewProfile,
  openOnClick = false,
  children,
}: AgentHoverCardProps) {
  const [engaged, setEngaged] = useState(false);
  const card = useAgentCard({
    agentPath,
    displayName: identity.displayName,
    onViewProfile,
    engaged,
  });
  const handleOpenChange = useCallback((open: boolean) => {
    if (open) setEngaged(true);
  }, []);

  return (
    <IdentityHoverCard
      identity={identity}
      onViewProfile={onViewProfile}
      onOpenChange={handleOpenChange}
      openOnClick={openOnClick && card !== null}
      {...(card ? { about: card.about, actions: card.actions } : {})}
    >
      {children}
    </IdentityHoverCard>
  );
}
