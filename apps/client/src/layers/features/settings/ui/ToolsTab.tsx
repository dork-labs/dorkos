import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRelayEnabled } from '@/layers/entities/relay';
import { useTasksEnabled } from '@/layers/entities/tasks';
import { FieldCard, FieldCardContent } from '@/layers/shared/ui';
import { useDeepLinkScroll, useSettingsDeepLink, useTransport } from '@/layers/shared/model';
import { configKeys } from '@/layers/entities/config';
import { SchedulerSettings } from './tools/SchedulerSettings';
import { BackgroundSystemsCard } from './tools/BackgroundSystemsCard';
import { ExternalMcpCard } from './external-mcp/ExternalMcpCard';

/**
 * Tools tab for the Settings dialog: the background systems agents work
 * through (scheduled runs, messaging), how many scheduled runs may go at once,
 * and whether other apps may use DorkOS as an MCP server.
 *
 * What agents may DO with their tools is not here: it is Settings → Permissions
 * (spec `agent-permissions`), which replaced the tool-group switches this tab
 * used to carry. Those only ever left tool docs out of an agent's context.
 */
export function ToolsTab() {
  const relayEnabled = useRelayEnabled();
  const tasksEnabled = useTasksEnabled();
  const transport = useTransport();
  const queryClient = useQueryClient();
  const { section } = useSettingsDeepLink();
  useDeepLinkScroll(section);

  const { data: serverConfig } = useQuery({
    queryKey: configKeys.current(),
    queryFn: () => transport.getConfig(),
    staleTime: 30_000,
  });
  const scheduler = serverConfig?.scheduler;

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
  // matters here because the app is not sent every field of these blocks and
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
      {scheduler && tasksEnabled && (
        <FieldCard>
          <FieldCardContent>
            <SchedulerSettings scheduler={scheduler} onUpdate={updateScheduler} />
          </FieldCardContent>
        </FieldCard>
      )}
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
