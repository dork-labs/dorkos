/**
 * Connections — the outside accounts this agent is bound to (spec
 * `profile-unification` §1.5).
 *
 * @module features/profile/ui/pages/ConnectionsPage
 */
import { Skeleton } from '@/layers/shared/ui';
import { useOpenConnections } from '@/layers/shared/model';
import { AgentConnectionAccessList } from '@/layers/entities/connectors';
import { IntegrationsTab } from '@/layers/features/agent-settings';
import { useProfileAgent } from '../../model/use-profile-agent';
import type { ProfilePageContentProps } from './types';

/** Which Telegram, Slack or other account this agent answers on. */
export function ConnectionsPage({ member }: ProfilePageContentProps) {
  const { agent, isPending } = useProfileAgent(member);
  const openConnections = useOpenConnections();

  if (isPending) return <Skeleton className="h-32 w-full" />;
  if (!agent) {
    return <p className="text-muted-foreground text-sm">Couldn’t read this agent’s connections.</p>;
  }

  return (
    <div className="space-y-6">
      <AgentConnectionAccessList agentId={agent.id} onManage={() => openConnections('accounts')} />
      <section aria-labelledby="agent-messaging-access" className="space-y-3">
        <div>
          <h3 id="agent-messaging-access" className="text-sm font-semibold">
            Messaging
          </h3>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Places where people can reach this agent.
          </p>
        </div>
        <IntegrationsTab agent={agent} />
      </section>
    </div>
  );
}
