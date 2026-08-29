import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRelayEnabled } from '@/layers/entities/relay';
import { useTasksEnabled } from '@/layers/entities/tasks';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { useToolNamesForGroup } from '@/layers/entities/capability';
import { FieldCard, FieldCardContent, SettingRow } from '@/layers/shared/ui';
import { useDeepLinkScroll, useSettingsDeepLink, useTransport } from '@/layers/shared/model';
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
import { BackgroundSystemsCard } from './tools/BackgroundSystemsCard';
import { ExternalMcpCard } from './external-mcp/ExternalMcpCard';
import { ResetToDefaultsButton } from './ResetToDefaultsButton';
import { configKeys } from '@/layers/entities/config';

/**
 * Header action for the Tools panel — turns every tool group back on.
 *
 * A component rather than an element because the dialog declares its tabs
 * before any of them mount, and this needs the transport the panel writes with.
 */
export function ToolsResetAction() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  const handleReset = useCallback(async () => {
    await transport.updateConfig({
      agentContext: {
        relayTools: true,
        meshTools: true,
        adapterTools: true,
        tasksTools: true,
      },
    });
    queryClient.invalidateQueries({ queryKey: configKeys.all });
  }, [transport, queryClient]);

  return <ResetToDefaultsButton onClick={() => void handleReset()} />;
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
  const { section } = useSettingsDeepLink();
  useDeepLinkScroll(section);

  const { data: serverConfig } = useQuery({
    queryKey: configKeys.current(),
    queryFn: () => transport.getConfig(),
    staleTime: 30_000,
  });

  const { data: agentsData } = useRegisteredAgents();
  // The tool names behind the grant, derived from the live registry rather than
  // listed here — the fourth hand-kept copy is the one that drifts (DOR-499).
  const roomsManageTools = useToolNamesForGroup('roomsManage');
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
      const current = scheduler ?? { maxConcurrentRuns: 1, retentionCount: 100 };
      await transport.updateConfig({ scheduler: { ...current, ...patch } });
      await queryClient.invalidateQueries({ queryKey: configKeys.all });
    },
    [transport, queryClient, scheduler]
  );

  // The background-system switches send the ONE key they change. `PATCH
  // /api/config` deep-merges, so the rest of each block is left alone — which
  // matters here because the cockpit is not sent every field of these blocks and
  // could not round-trip them faithfully if it tried.
  const setTasksEnabled = useCallback(
    async (enabled: boolean) => {
      await transport.updateConfig({ scheduler: { enabled } });
      await queryClient.invalidateQueries({ queryKey: configKeys.all });
    },
    [transport, queryClient]
  );

  const setRelaySubsystemEnabled = useCallback(
    async (enabled: boolean) => {
      await transport.updateConfig({ relay: { enabled } });
      await queryClient.invalidateQueries({ queryKey: configKeys.all });
    },
    [transport, queryClient]
  );

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Choose which tool groups your agents are told about by default. Turning a group off leaves
        it out of an agent&rsquo;s instructions, so agents stop reaching for it. It is guidance, not
        a lock &mdash; an agent that asks for one anyway still gets it. Individual agents can
        override these in their own Tools tab.
      </p>
      <FieldCard>
        <FieldCardContent>
          <SettingRow
            label="Core Tools"
            description="Server info, agent identity, app controls, and preview reads"
          >
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
      {/* Its own card, apart from the four above, because it is a different
          mechanism and one paragraph cannot honestly describe both. No switch
          here on purpose: there is no global default for this grant (spec §D5),
          and inventing one would be a second, weaker path to the same
          permission. */}
      <FieldCard>
        <FieldCardContent className="space-y-2">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Manage rooms</span>
                {roomsManageTools.length > 0 ? <ToolCountBadge tools={roomsManageTools} /> : null}
              </div>
              <p className="text-muted-foreground text-sm">
                Create channels and direct messages, add and remove members, rename a channel, and
                leave a channel.
              </p>
            </div>
            <span className="text-muted-foreground shrink-0 text-xs">Granted per agent</span>
          </div>
          {/* NO COUNT HERE, and that is a correction rather than a gap
              (DOR-1611 review). This screen reads `GET /api/mesh/agents`, whose
              rows come from the SQLite cache — and that cache has no
              `enabled_tool_groups` column, so `rowToEntry` hardcodes `{}` and
              every agent reads as ungranted. A "0 agents can manage rooms" that
              is wrong on a machine where three of them can is worse than no
              number at all, and the honest number needs a manifest-backed
              surface this row does not justify building. What the row owes the
              person is where to go, and it says that. */}
          <p className="text-muted-foreground text-sm">
            Unlike the groups above, this one blocks: an agent without it is refused and told to ask
            you. Turn it on for an agent in that agent&rsquo;s own Tools settings.
          </p>
        </FieldCardContent>
      </FieldCard>
      <BackgroundSystemsCard
        tasks={{
          running: tasksEnabled,
          enabledInConfig: serverConfig?.tasks?.enabledInConfig,
          lockedByEnv: serverConfig?.tasks?.lockedByEnv,
          initError: serverConfig?.tasks?.initError,
        }}
        relay={{
          running: relayEnabled,
          enabledInConfig: serverConfig?.relay?.enabledInConfig,
          lockedByEnv: serverConfig?.relay?.lockedByEnv,
          initError: serverConfig?.relay?.initError,
        }}
        onTasksChange={(v) => void setTasksEnabled(v)}
        onRelayChange={(v) => void setRelaySubsystemEnabled(v)}
      />
      {serverConfig?.mcp && (
        <div data-section="external-mcp">
          <ExternalMcpCard
            mcp={serverConfig.mcp}
            authEnabled={serverConfig.auth?.enabled === true}
          />
        </div>
      )}
    </div>
  );
}
