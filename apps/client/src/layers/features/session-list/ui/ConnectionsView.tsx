import { useMemo } from 'react';
import { useRelayAdapters } from '@/layers/entities/relay';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { useBindings } from '@/layers/entities/binding';
import { useAppStore } from '@/layers/shared/model';
import type { AgentToolStatus, ChipState } from '@/layers/entities/agent';
import { useMcpConfig } from '@/layers/entities/agent';
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
  agentId: string | null | undefined;
}

const ADAPTER_STATE_COLORS: Record<string, string> = {
  connected: 'bg-green-500',
  disconnected: 'bg-amber-500',
  error: 'bg-red-500',
};

const TOOL_STATUS_COLORS: Record<ChipState, string> = {
  enabled: 'bg-green-500',
  'disabled-by-agent': 'bg-muted-foreground/20',
  'disabled-by-server': 'bg-muted-foreground/20',
};

const MCP_STATUS_COLORS: Partial<Record<string, string>> = {
  connected: 'bg-green-500',
  failed: 'bg-red-500',
  'needs-auth': 'bg-amber-500',
  pending: 'bg-amber-500',
  disabled: 'bg-muted-foreground/20',
};

const DORKOS_TOOLS = [
  { key: 'pulse' as const, label: 'Pulse' },
  { key: 'relay' as const, label: 'Relay' },
  { key: 'mesh' as const, label: 'Mesh' },
] as const;

/** Read-only adapter and agent summary for the sidebar Connections tab. */
export function ConnectionsView({ toolStatus, agentId }: ConnectionsViewProps) {
  const { setRelayOpen, setMeshOpen, setAgentDialogOpen, selectedCwd } = useAppStore();
  const relayEnabled = toolStatus.relay !== 'disabled-by-server';
  const meshEnabled = toolStatus.mesh !== 'disabled-by-server';
  const { data: adapters = [] } = useRelayAdapters(relayEnabled);
  const { data: bindings = [] } = useBindings();
  const { data: agentsData } = useRegisteredAgents(undefined, meshEnabled);
  const agents = agentsData?.agents ?? [];
  const { data: mcpConfig } = useMcpConfig(selectedCwd);
  const mcpServers = mcpConfig?.servers ?? [];

  // Show only adapters that are either the built-in CCA (serves all agents) or
  // have a binding to the currently viewed agent.
  // Note: `builtin` means loaded from @dorkos/relay; only claude-code type serves all agents.
  const visibleAdapters = useMemo(() => {
    const isCca = (a: (typeof adapters)[number]) =>
      a.config.type === 'claude-code' && a.config.builtin === true;
    if (!agentId) return adapters.filter(isCca);
    const boundAdapterIds = new Set(
      bindings.filter((b) => b.agentId === agentId).map((b) => b.adapterId),
    );
    return adapters.filter((a) => isCca(a) || boundAdapterIds.has(a.config.id));
  }, [adapters, bindings, agentId]);

  const showRelaySection = relayEnabled;
  const showMeshSection = meshEnabled;

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
            ) : visibleAdapters.length === 0 ? (
              <div className="px-3 py-2">
                <p className="text-muted-foreground/60 text-sm">No adapters configured</p>
              </div>
            ) : (
              <SidebarMenu>
                {visibleAdapters.map((adapter) => (
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

        {/* Tools section */}
        <SidebarGroup>
          <SidebarGroupLabel className="text-2xs text-muted-foreground/70 font-medium tracking-wider uppercase">
            Tools
          </SidebarGroupLabel>

          <SidebarMenu>
            {DORKOS_TOOLS.map(({ key, label }) => {
              const state = toolStatus[key];
              return (
                <SidebarMenuItem key={key}>
                  <SidebarMenuButton className="text-sm" onClick={() => setAgentDialogOpen(true)}>
                    <span
                      className={cn(
                        'size-2 shrink-0 rounded-full',
                        TOOL_STATUS_COLORS[state],
                      )}
                    />
                    <span className="truncate">{label}</span>
                    <span className="text-muted-foreground/50 ml-auto text-xs">
                      {state === 'enabled' ? 'enabled' : 'off'}
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}

            {mcpServers.map((server) => (
              <SidebarMenuItem key={server.name}>
                <SidebarMenuButton className="text-sm">
                  <span
                    className={cn(
                      'size-2 shrink-0 rounded-full',
                      MCP_STATUS_COLORS[server.status ?? ''] ?? 'bg-muted-foreground/40',
                    )}
                  />
                  <span className="truncate">{server.name}</span>
                  <span className="text-muted-foreground/50 ml-auto text-xs">mcp</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>

          <div className="px-3 py-2">
            <button
              onClick={() => setAgentDialogOpen(true)}
              className="text-muted-foreground hover:text-foreground text-xs transition-colors"
            >
              Edit capabilities →
            </button>
          </div>
        </SidebarGroup>
      </div>
    </ScrollArea>
  );
}
