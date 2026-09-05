import { useState } from 'react';
import { toast } from 'sonner';
import {
  cardVariants,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
} from '@/layers/shared/ui';
import { cn, getAgentDisplayName } from '@/layers/shared/lib';
import {
  useAgentConnectors,
  useAttachAgentConnector,
  useConnectorAccounts,
  useDetachAgentConnector,
} from '@/layers/entities/connectors';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { accountDisplayName } from '../lib/presentation';

/**
 * Which accounts an agent may use, standingly.
 *
 * An account switched on here stays on: every session that agent starts gets
 * it, and it survives a restart. A single session can still add or drop an
 * account just for itself, and that choice wins for that session.
 *
 * Switching one on is a consent point in its own right, so the custody
 * sentence the server composed for that account is shown again at the moment
 * it is granted, not just when it was first connected.
 */
export function AgentAccounts() {
  const { data: agentsData } = useRegisteredAgents();
  const agents = agentsData?.agents ?? [];
  const [agentId, setAgentId] = useState('');
  const selected = agents.find((a) => a.id === agentId);

  const { data: accountsData, isLoading: accountsLoading } = useConnectorAccounts();
  const { data: attached, isLoading: attachedLoading } = useAgentConnectors(agentId || null);
  const attach = useAttachAgentConnector();
  const detach = useDetachAgentConnector();

  const accounts = accountsData?.accounts ?? [];
  const attachedIds = new Set((attached ?? []).map((row) => row.accountId));
  const isBusy = attach.isPending || detach.isPending;

  if (accountsLoading) return <Skeleton className="h-24 w-full rounded-lg" />;
  if (accounts.length === 0) return null;

  return (
    <section aria-labelledby="connections-agent-accounts" className="space-y-3">
      <div>
        <h3 id="connections-agent-accounts" className="text-sm font-semibold">
          Give an agent an account
        </h3>
        <p className="text-muted-foreground mt-1 text-sm">
          Pick an agent, then switch on what it may use. It keeps them until you switch them off.
        </p>
      </div>

      <Select value={agentId} onValueChange={setAgentId}>
        <SelectTrigger className="w-full sm:w-64" aria-label="Which agent?">
          <SelectValue placeholder="Pick an agent" />
        </SelectTrigger>
        <SelectContent>
          {agents.map((agent) => (
            <SelectItem key={agent.id} value={agent.id}>
              {getAgentDisplayName(agent)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {selected &&
        (attachedLoading ? (
          <Skeleton className="h-20 w-full rounded-lg" />
        ) : (
          <ul className="space-y-2">
            {accounts.map((account) => {
              const on = attachedIds.has(account.id);
              const name = accountDisplayName(account.toolkit, account.label);
              return (
                <li
                  key={account.id}
                  // The card shell from the card's own recipe; the element stays
                  // an `<li>` because it is one item of a list.
                  className={cn(cardVariants(), 'flex-row items-start justify-between')}
                >
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium">{name}</p>
                    <p className="text-muted-foreground text-xs leading-relaxed">
                      {account.disclosure}
                    </p>
                  </div>
                  <Switch
                    checked={on}
                    disabled={isBusy}
                    aria-label={`Let ${getAgentDisplayName(selected)} use ${name}`}
                    onCheckedChange={(next) => {
                      if (next) {
                        attach.mutate(
                          { agentId: selected.id, accountId: account.id },
                          {
                            onSuccess: (result) =>
                              toast.success(`${getAgentDisplayName(selected)} can use ${name}.`, {
                                description: result.disclosure,
                              }),
                          }
                        );
                      } else {
                        detach.mutate(
                          { agentId: selected.id, accountId: account.id },
                          {
                            onSuccess: () =>
                              toast.success(
                                `${getAgentDisplayName(selected)} no longer uses ${name}.`,
                                {
                                  description:
                                    'Sessions already running keep it until they start again.',
                                }
                              ),
                          }
                        );
                      }
                    }}
                  />
                </li>
              );
            })}
          </ul>
        ))}
    </section>
  );
}
