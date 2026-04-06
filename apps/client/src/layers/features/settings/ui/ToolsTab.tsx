import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRelayEnabled } from '@/layers/entities/relay';
import { useTasksEnabled } from '@/layers/entities/tasks';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import {
  FieldCard,
  FieldCardContent,
  NavigationLayoutPanelHeader,
  SettingRow,
} from '@/layers/shared/ui';
import { useTransport } from '@/layers/shared/model';
import { useAgentContextConfig } from '@/layers/features/agent-settings/model/use-agent-context-config';
import {
  TOOL_INVENTORY,
  TOOL_GROUPS,
  CONFIG_KEY_MAP,
  type ToolDomainKey,
} from '../config/tool-inventory';
import { ToolCountBadge } from './tools/ToolCountBadge';
import { ToolGroupRow } from './tools/ToolGroupRow';
import { SchedulerSettings } from './tools/SchedulerSettings';
import { ExternalMcpCard } from './external-mcp/ExternalMcpCard';

/** Inline reset button — kept local; promotion to shared deferred to a later spec. */
function ResetButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-muted-foreground hover:text-foreground text-xs transition-colors duration-150"
    >
      Reset to defaults
    </button>
  );
}

/**
 * Tools tab for the Settings dialog.
 *
 * Displays global toggle switches for each MCP tool group with tool inventories,
 * init error warnings, and per-agent override counts. The Tasks group includes
 * an expandable scheduler configuration section. These are global defaults;
 * per-agent overrides are set in the Agent dialog Tools tab.
 */
export function ToolsTab() {
  const relayEnabled = useRelayEnabled();
  const tasksEnabled = useTasksEnabled();
  const { config, updateConfig } = useAgentContextConfig();
  const transport = useTransport();
  const queryClient = useQueryClient();

  const { data: serverConfig } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 30_000,
  });

  const { data: agentsData } = useRegisteredAgents();
  const scheduler = serverConfig?.scheduler;

  const overrideCounts = useMemo(() => {
    const agents = agentsData?.agents ?? [];
    const counts: Record<ToolDomainKey, number> = { tasks: 0, relay: 0, mesh: 0, adapter: 0 };
    for (const agent of agents) {
      const groups = agent.enabledToolGroups;
      if (!groups) continue;
      if (groups.tasks !== undefined) counts.tasks++;
      if (groups.relay !== undefined) counts.relay++;
      if (groups.mesh !== undefined) counts.mesh++;
      if (groups.adapter !== undefined) counts.adapter++;
    }
    return counts;
  }, [agentsData]);

  const availabilityMap: Record<ToolDomainKey, boolean> = {
    tasks: tasksEnabled,
    relay: relayEnabled,
    mesh: true,
    adapter: relayEnabled,
  };

  const initErrorMap: Record<ToolDomainKey, string | undefined> = {
    tasks: serverConfig?.tasks?.initError,
    relay: serverConfig?.relay?.initError,
    mesh: serverConfig?.mesh?.initError,
    adapter: serverConfig?.relay?.initError,
  };

  const handleToggle = useCallback(
    (key: ToolDomainKey, value: boolean) => {
      updateConfig({ [CONFIG_KEY_MAP[key]]: value });
    },
    [updateConfig]
  );

  const updateScheduler = useCallback(
    async (patch: Record<string, unknown>) => {
      const current = scheduler ?? { maxConcurrentRuns: 1, timezone: null, retentionCount: 100 };
      await transport.updateConfig({ scheduler: { ...current, ...patch } });
      await queryClient.invalidateQueries({ queryKey: ['config'] });
    },
    [transport, queryClient, scheduler]
  );

  const handleResetTools = useCallback(async () => {
    await transport.updateConfig({
      agentContext: {
        relayTools: true,
        meshTools: true,
        adapterTools: true,
        tasksTools: true,
      },
    });
    queryClient.invalidateQueries({ queryKey: ['config'] });
  }, [transport, queryClient]);

  return (
    <div className="space-y-4">
      <NavigationLayoutPanelHeader actions={<ResetButton onClick={handleResetTools} />}>
        Tools
      </NavigationLayoutPanelHeader>
      <p className="text-muted-foreground text-sm">
        Control which MCP tool groups are available to agents. These are global defaults —
        individual agents can override them in their Tools tab.
      </p>
      <FieldCard>
        <FieldCardContent>
          <SettingRow label="Core Tools" description="Server info, agent identity, UI control">
            <div className="flex items-center gap-2">
              <ToolCountBadge tools={TOOL_INVENTORY.core} />
              <span className="text-muted-foreground text-xs">Always enabled</span>
            </div>
          </SettingRow>
          {TOOL_GROUPS.map((group) => (
            <ToolGroupRow
              key={group.key}
              group={group}
              enabled={config[CONFIG_KEY_MAP[group.key]]}
              available={availabilityMap[group.key]}
              initError={initErrorMap[group.key]}
              overrideCount={overrideCounts[group.key]}
              onToggle={handleToggle}
              expandContent={
                group.key === 'tasks' && scheduler ? (
                  <SchedulerSettings scheduler={scheduler} onUpdate={updateScheduler} />
                ) : undefined
              }
            />
          ))}
        </FieldCardContent>
      </FieldCard>
      {serverConfig?.mcp && <ExternalMcpCard mcp={serverConfig.mcp} />}
    </div>
  );
}
