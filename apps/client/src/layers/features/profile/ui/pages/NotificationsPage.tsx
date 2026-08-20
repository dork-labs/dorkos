/**
 * Notifications — everything this one agent has told the operator (spec
 * `notification-system` §Client, lenses).
 *
 * The same list the header bell draws, through this agent's lens. One component,
 * one store, one set of rules for what a row looks like and where it goes: the
 * whole point of the lens design is that an agent's page cannot drift from the
 * bell, because it IS the bell's list with a filter on it.
 *
 * @module features/profile/ui/pages/NotificationsPage
 */
import { InboxList } from '@/layers/features/inbox';
import type { ProfilePageContentProps } from './types';

/**
 * This agent's notifications, newest first.
 *
 * An agent with no manifest id has nothing to filter by — a person's profile
 * reaching this page, which the rows do not offer — so it says so rather than
 * quietly showing the whole fleet's history under one agent's name.
 */
export function NotificationsPage({ member }: ProfilePageContentProps) {
  const agentId = member.agent?.manifestId ?? null;

  if (agentId === null) {
    return (
      <div className="min-h-0 flex-1 px-4 py-3" data-slot="profile-notifications">
        <p className="text-muted-foreground text-xs">
          Notifications are kept per agent, and this profile is not one.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 px-2 py-2" data-slot="profile-notifications">
      <InboxList
        lens={{ agentId }}
        emptyLabel={`${member.displayName} has not told you anything yet.`}
      />
    </div>
  );
}
