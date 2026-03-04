import { useCallback } from 'react';
import { useRelayEnabled } from '@/layers/entities/relay';
import { usePulseEnabled } from '@/layers/entities/pulse';
import { Badge, Label, Switch } from '@/layers/shared/ui';
import { useAgentContextConfig } from '@/layers/features/agent-settings/model/use-agent-context-config';

const PULSE_PREVIEW = `DorkOS Pulse lets you create and manage scheduled agent runs.

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
  relay.system.pulse.{scheduleId}  — Pulse scheduler events

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
- binding_create(adapterId, agentId, projectPath) — route an adapter to an agent
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
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label className="text-sm font-medium">{label}</Label>
          <p className="text-muted-foreground text-xs">{description}</p>
        </div>
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
      </div>
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
 * Displays global toggle switches for each tool context block (pulse, relay, mesh, adapter)
 * with read-only previews of the content injected into agent system prompts.
 * These are global defaults; per-agent overrides are set in the Agent dialog Capabilities tab.
 */
export function ToolsTab() {
  const relayEnabled = useRelayEnabled();
  const pulseEnabled = usePulseEnabled();
  const { config, updateConfig } = useAgentContextConfig();

  const handleToggle = useCallback(
    (key: 'pulseTools' | 'relayTools' | 'meshTools' | 'adapterTools', value: boolean) => {
      updateConfig({ [key]: value });
    },
    [updateConfig]
  );

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        Control which tool usage instructions are injected into agent system prompts by default.
        These are global defaults — individual agents can override them in their Capabilities tab.
      </p>

      <ToolBlockSection
        label="Pulse Tools"
        description="Scheduling tools for creating and managing scheduled agent runs."
        enabled={config.pulseTools}
        available={pulseEnabled}
        unavailableReason="Pulse is disabled"
        onToggle={(v) => handleToggle('pulseTools', v)}
        preview={PULSE_PREVIEW}
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
    </div>
  );
}
