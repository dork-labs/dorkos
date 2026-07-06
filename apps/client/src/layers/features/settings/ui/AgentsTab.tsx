import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { getAgentDisplayName } from '@/layers/shared/lib';
import {
  FieldCard,
  FieldCardContent,
  SettingRow,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@/layers/shared/ui';

/** Agents section within Settings — the default agent used for new sessions. */
export function AgentsTab() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  const { data: agentsData, isLoading } = useQuery({
    queryKey: ['mesh', 'agents'],
    queryFn: () => transport.listMeshAgents(),
    staleTime: 30_000,
  });

  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 30_000,
  });

  const agents = agentsData?.agents ?? [];
  const currentDefault = config?.agents?.defaultAgent ?? 'dorkbot';

  async function handleSetDefaultAgent(agentName: string) {
    await transport.setDefaultAgent(agentName);
    await queryClient.invalidateQueries({ queryKey: ['config'] });
  }

  if (isLoading) {
    return <Skeleton className="h-10 w-full rounded-md" />;
  }

  // Should not happen: DorkBot is guaranteed to be registered. Still, never render
  // a blank panel if the mesh agents list is somehow empty.
  if (agents.length === 0) {
    return (
      <div className="rounded-xl border border-dashed py-8 text-center">
        <p className="text-muted-foreground text-sm">No agents found</p>
      </div>
    );
  }

  return (
    <FieldCard>
      <FieldCardContent>
        <SettingRow
          label="Default agent"
          description="The primary agent used for new sessions and post-onboarding"
        >
          <Select value={currentDefault} onValueChange={handleSetDefaultAgent}>
            <SelectTrigger className="w-44" data-testid="default-agent-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.name}>
                  {getAgentDisplayName(agent)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </FieldCardContent>
    </FieldCard>
  );
}
