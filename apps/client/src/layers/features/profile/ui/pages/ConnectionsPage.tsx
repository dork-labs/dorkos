/**
 * Connections — the outside accounts this agent is bound to (spec
 * `profile-unification` §1.5).
 *
 * @module features/profile/ui/pages/ConnectionsPage
 */
import { Skeleton } from '@/layers/shared/ui';
import { IntegrationsTab } from '@/layers/features/agent-settings';
import { useProfileAgent } from '../../model/use-profile-agent';
import type { ProfilePageContentProps } from './types';

/** Which Telegram, Slack or other account this agent answers on. */
export function ConnectionsPage({ member }: ProfilePageContentProps) {
  const { agent, isPending } = useProfileAgent(member);

  if (isPending) return <Skeleton className="h-32 w-full" />;
  if (!agent) {
    return <p className="text-muted-foreground text-sm">Couldn’t read this agent’s connections.</p>;
  }

  return <IntegrationsTab agent={agent} />;
}
