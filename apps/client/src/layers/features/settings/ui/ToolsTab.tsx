import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRelayEnabled } from '@/layers/entities/relay';
import { useTasksEnabled } from '@/layers/entities/tasks';
import {
  Badge,
  FieldCard,
  FieldCardContent,
  Input,
  SettingRow,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@/layers/shared/ui';
import { useTransport } from '@/layers/shared/model';
import { useAgentContextConfig } from '@/layers/features/agent-settings/model/use-agent-context-config';

const TASKS_PREVIEW = `DorkOS Tasks lets you create and manage scheduled agent runs.

Available tools:
  list_schedules() -- list all configured schedules
  create_schedule(name, cron, prompt, ...) -- create a new schedule
  update_schedule(id, ...) -- modify schedule settings
  delete_schedule(id) -- remove a schedule
  get_run_history(scheduleId) -- view past run results

Schedules can target a specific agent (by agentId) or a directory (by cwd).`;

const RELAY_PREVIEW = `DorkOS Relay is a pub/sub message bus for inter-agent communication.

Subject hierarchy:
  relay.agent.{sessionId}          — address a specific agent session
  relay.human.console.{clientId}   — reach a human in the DorkOS UI
  relay.system.console             — system broadcast channel
  relay.system.tasks.{scheduleId}  — Tasks scheduler events

Workflows:
- Register a reply address first: relay_register_endpoint(subject="relay.agent.{your-sessionId}")
- Message another agent: relay_send(subject="relay.agent.{their-sessionId}", payload={...}, from="relay.agent.{your-sessionId}")
- Check for replies: relay_inbox(endpoint_subject="relay.agent.{your-sessionId}")
- See who is listening: relay_list_endpoints()

Error codes: RELAY_DISABLED (feature off), ACCESS_DENIED (subject blocked), INVALID_SUBJECT (malformed), ENDPOINT_NOT_FOUND (inbox miss).`;

const MESH_PREVIEW = `DorkOS Mesh is a local agent registry for discovering and communicating with AI agents on this machine.

Agent lifecycle:
1. mesh_discover(roots=["/path"]) — scan directories for agent candidates (looks for CLAUDE.md, .dork/agent.json)
2. mesh_register(path, name, runtime, capabilities) — register a candidate as a known agent
3. mesh_inspect(agentId) — get full manifest, health status, and relay endpoint
4. mesh_status() — aggregate overview: total, active, stale agent counts
5. mesh_list(runtime?, capability?) — filter agents by runtime or capability
6. mesh_deny(path, reason) — exclude a path from future discovery
7. mesh_unregister(agentId) — remove an agent from the registry
8. mesh_query_topology(namespace?) — view agent network from a namespace perspective

Workflows:
- Find agents: mesh_list() then mesh_inspect(agentId) for details
- Contact another agent: mesh_inspect(agentId) to get their relay endpoint, then relay_send
- Register this project: mesh_register(path=cwd, name="project-name", runtime="claude-code")

Runtimes: claude-code | cursor | codex | other`;

const ADAPTER_PREVIEW = `Relay adapters bridge external platforms (Telegram, webhooks) to the agent message bus.

Subject conventions for external messages:
  relay.human.telegram.{chatId}    — send to / receive from Telegram
  relay.human.webhook.{webhookId}  — send to / receive from webhooks

Adapter management:
- relay_list_adapters() — see all adapters and their status (connected, disconnected, error)
- relay_enable_adapter(id) / relay_disable_adapter(id) — toggle an adapter on/off
- relay_reload_adapters() — hot-reload config from disk

Bindings route adapter messages to agent projects:
- binding_list() — see current adapter-to-agent bindings
- binding_create(adapterId, agentId) — route an adapter to an agent
- binding_delete(id) — remove a binding

Session strategies: per-chat (default, one session per conversation), per-user (shared across chats), stateless (new session each message).`;

interface ToolBlockSectionProps {
  label: string;
  description: string;
  enabled: boolean;
  available: boolean;
  unavailableReason?: string;
  onToggle: (value: boolean) => void;
  preview: string;
}

function ToolBlockSection({
  label,
  description,
  enabled,
  available,
  unavailableReason,
  onToggle,
  preview,
}: ToolBlockSectionProps) {
  const effective = available && enabled;

  return (
    <section className="space-y-2">
      <SettingRow label={label} description={description}>
        <div className="flex items-center gap-2">
          {!available && (
            <Badge variant="secondary" className="text-xs">
              {unavailableReason}
            </Badge>
          )}
          <Switch
            checked={enabled}
            onCheckedChange={onToggle}
            disabled={!available}
            aria-label={`Toggle ${label} context`}
          />
        </div>
      </SettingRow>
      {effective && (
        <pre className="bg-muted max-h-40 overflow-y-auto rounded-md p-3 text-xs leading-relaxed">
          {preview}
        </pre>
      )}
    </section>
  );
}

/**
 * Tools tab for the Settings dialog.
 *
 * Displays global toggle switches for each tool context block (tasks, relay, mesh, adapter)
 * with read-only previews of the content injected into agent system prompts.
 * These are global defaults; per-agent overrides are set in the Agent dialog Capabilities tab.
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

  const scheduler = serverConfig?.scheduler;

  const updateScheduler = useCallback(
    async (patch: Record<string, unknown>) => {
      const current = scheduler ?? { maxConcurrentRuns: 1, timezone: null, retentionCount: 100 };
      await transport.updateConfig({ scheduler: { ...current, ...patch } });
      await queryClient.invalidateQueries({ queryKey: ['config'] });
    },
    [transport, queryClient, scheduler]
  );

  const handleToggle = useCallback(
    (key: 'tasksTools' | 'relayTools' | 'meshTools' | 'adapterTools', value: boolean) => {
      updateConfig({ [key]: value });
    },
    [updateConfig]
  );

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Control which tool usage instructions are injected into agent system prompts by default.
        These are global defaults — individual agents can override them in their Capabilities tab.
      </p>

      <FieldCard>
        <FieldCardContent>
          <ToolBlockSection
            label="Tasks Tools"
            description="Scheduling tools for creating and managing scheduled agent runs."
            enabled={config.tasksTools}
            available={tasksEnabled}
            unavailableReason="Tasks is disabled"
            onToggle={(v) => handleToggle('tasksTools', v)}
            preview={TASKS_PREVIEW}
          />

          <ToolBlockSection
            label="Relay Tools"
            description="Subject hierarchy, messaging workflows, and error codes for the Relay message bus."
            enabled={config.relayTools}
            available={relayEnabled}
            unavailableReason="Relay is disabled"
            onToggle={(v) => handleToggle('relayTools', v)}
            preview={RELAY_PREVIEW}
          />

          <ToolBlockSection
            label="Mesh Tools"
            description="Agent lifecycle, discovery workflow, and cross-tool orchestration with Relay."
            enabled={config.meshTools}
            available={true}
            onToggle={(v) => handleToggle('meshTools', v)}
            preview={MESH_PREVIEW}
          />

          <ToolBlockSection
            label="Adapter Tools"
            description="External platform subjects, adapter management, and binding routing conventions."
            enabled={config.adapterTools}
            available={relayEnabled}
            unavailableReason="Relay is disabled"
            onToggle={(v) => handleToggle('adapterTools', v)}
            preview={ADAPTER_PREVIEW}
          />
        </FieldCardContent>
      </FieldCard>

      {scheduler && (
        <>
          <h3 className="text-sm font-semibold">Tasks Configuration</h3>
          <FieldCard>
            <FieldCardContent>
              <SettingRow
                label="Concurrent runs"
                description="Maximum task runs that can execute in parallel"
              >
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={scheduler.maxConcurrentRuns}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (v >= 1 && v <= 10) updateScheduler({ maxConcurrentRuns: v });
                  }}
                  className="w-20"
                />
              </SettingRow>

              <SettingRow
                label="Timezone"
                description="IANA timezone for interpreting cron schedules"
              >
                <Select
                  value={scheduler.timezone ?? 'system'}
                  onValueChange={(v) => updateScheduler({ timezone: v === 'system' ? null : v })}
                >
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="system">System default</SelectItem>
                    <SelectItem value="UTC">UTC</SelectItem>
                    <SelectItem value="America/New_York">America/New_York</SelectItem>
                    <SelectItem value="America/Chicago">America/Chicago</SelectItem>
                    <SelectItem value="America/Denver">America/Denver</SelectItem>
                    <SelectItem value="America/Los_Angeles">America/Los_Angeles</SelectItem>
                    <SelectItem value="Europe/London">Europe/London</SelectItem>
                    <SelectItem value="Europe/Berlin">Europe/Berlin</SelectItem>
                    <SelectItem value="Europe/Paris">Europe/Paris</SelectItem>
                    <SelectItem value="Asia/Tokyo">Asia/Tokyo</SelectItem>
                    <SelectItem value="Asia/Shanghai">Asia/Shanghai</SelectItem>
                    <SelectItem value="Asia/Kolkata">Asia/Kolkata</SelectItem>
                    <SelectItem value="Australia/Sydney">Australia/Sydney</SelectItem>
                  </SelectContent>
                </Select>
              </SettingRow>

              <SettingRow
                label="Run history retention"
                description="Number of completed task runs to keep in history"
              >
                <Input
                  type="number"
                  min={1}
                  max={10000}
                  value={scheduler.retentionCount}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (v >= 1) updateScheduler({ retentionCount: v });
                  }}
                  className="w-24"
                />
              </SettingRow>
            </FieldCardContent>
          </FieldCard>
        </>
      )}
    </div>
  );
}
