import { useRelayAdapters } from '@/layers/entities/relay';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { useAppStore } from '@/layers/shared/model';
import type { AgentToolStatus } from '@/layers/entities/agent';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  ScrollArea,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';

interface ConnectionsViewProps {
  toolStatus: AgentToolStatus;
  projectPath: string | null;
}

const ADAPTER_STATE_COLORS: Record<string, string> = {
  connected: 'bg-green-500',
  disconnected: 'bg-amber-500',
  error: 'bg-red-500',
};

/** Read-only adapter and agent summary for the sidebar Connections tab. */
export function ConnectionsView({ toolStatus, projectPath: _projectPath }: ConnectionsViewProps) {
  const { setRelayOpen, setMeshOpen } = useAppStore();
  const relayEnabled = toolStatus.relay !== 'disabled-by-server';
  const meshEnabled = toolStatus.mesh !== 'disabled-by-server';
  const { data: adapters = [] } = useRelayAdapters(relayEnabled);
  const { data: agentsData } = useRegisteredAgents(undefined, meshEnabled);
  const agents = agentsData?.agents ?? [];

  const showRelaySection = relayEnabled;
  const showMeshSection = meshEnabled;

  // Both sections hidden — nothing to show
  if (!showRelaySection && !showMeshSection) {
    return (
      <div className="flex h-32 items-center justify-center">
        <p className="text-muted-foreground/60 text-sm">No connections configured</p>
      </div>
    );
  }

  return (
    <ScrollArea type="scroll" className="h-full">
      <div className="pr-1">
        {/* Adapters section */}
        {showRelaySection && (
          <SidebarGroup>
            <SidebarGroupLabel className="text-2xs text-muted-foreground/70 font-medium tracking-wider uppercase">
              Adapters
            </SidebarGroupLabel>

            {toolStatus.relay === 'disabled-by-agent' ? (
              <div className="px-3 py-2">
                <p className="text-muted-foreground/60 text-sm">Relay disabled for this agent</p>
              </div>
            ) : adapters.length === 0 ? (
              <div className="px-3 py-2">
                <p className="text-muted-foreground/60 text-sm">No adapters configured</p>
              </div>
            ) : (
              <SidebarMenu>
                {adapters.map((adapter) => (
                  <SidebarMenuItem key={adapter.config.id}>
                    <SidebarMenuButton
                      onClick={() => setRelayOpen(true)}
                      className="text-sm"
                    >
                      <span
                        className={cn(
                          'size-2 shrink-0 rounded-full',
                          ADAPTER_STATE_COLORS[adapter.status.state] ?? 'bg-muted-foreground/20'
                        )}
                      />
                      <span className="truncate">{adapter.status.displayName}</span>
                      <span className="text-muted-foreground/50 ml-auto text-xs capitalize">
                        {adapter.status.state}
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            )}

            <div className="px-3 py-2">
              <button
                onClick={() => setRelayOpen(true)}
                className="text-muted-foreground hover:text-foreground text-xs transition-colors"
              >
                Open Relay →
              </button>
            </div>
          </SidebarGroup>
        )}

        {/* Agents section */}
        {showMeshSection && (
          <SidebarGroup>
            <SidebarGroupLabel className="text-2xs text-muted-foreground/70 font-medium tracking-wider uppercase">
              Agents
            </SidebarGroupLabel>

            {toolStatus.mesh === 'disabled-by-agent' ? (
              <div className="px-3 py-2">
                <p className="text-muted-foreground/60 text-sm">Mesh disabled for this agent</p>
              </div>
            ) : agents.length === 0 ? (
              <div className="px-3 py-2">
                <p className="text-muted-foreground/60 text-sm">No agents registered</p>
              </div>
            ) : (
              <SidebarMenu>
                {agents.map((agent) => (
                  <SidebarMenuItem key={agent.id}>
                    <SidebarMenuButton
                      onClick={() => setMeshOpen(true)}
                      className="text-sm"
                    >
                      {/* Registered agents show a neutral dot — health status requires a separate topology query */}
                      <span className="size-2 shrink-0 rounded-full bg-muted-foreground/40" />
                      <span className="truncate">{agent.name}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            )}

            <div className="px-3 py-2">
              <button
                onClick={() => setMeshOpen(true)}
                className="text-muted-foreground hover:text-foreground text-xs transition-colors"
              >
                Open Mesh →
              </button>
            </div>
          </SidebarGroup>
        )}
      </div>
    </ScrollArea>
  );
}
