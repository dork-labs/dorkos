import { useState, useCallback } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  Badge,
  Button,
  CollapsibleFieldCard,
  FieldCard,
  FieldCardContent,
  Input,
  SettingRow,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/layers/shared/ui';
import type { AgentManifest, EnabledToolGroups } from '@dorkos/shared/mesh-schemas';
import { useRelayEnabled } from '@/layers/entities/relay';
import { useTasksEnabled } from '@/layers/entities/tasks';
import { useAgentContextConfig } from '../model/use-agent-context-config';

// ---------------------------------------------------------------------------
// Tool inventories — display names without the mcp__dorkos__ prefix.
// Source of truth: services/runtimes/claude-code/tool-filter.ts
// Duplicated here because FSD prevents cross-feature imports from settings/.
// ---------------------------------------------------------------------------

const TOOL_INVENTORY = {
  tasks: ['tasks_list', 'tasks_create', 'tasks_update', 'tasks_delete', 'tasks_get_run_history'],
  relay: [
    'relay_send',
    'relay_inbox',
    'relay_list_endpoints',
    'relay_register_endpoint',
    'relay_send_and_wait',
    'relay_send_async',
    'relay_unregister_endpoint',
    'relay_get_trace',
    'relay_get_metrics',
  ],
  mesh: [
    'mesh_discover',
    'mesh_register',
    'mesh_list',
    'mesh_deny',
    'mesh_unregister',
    'mesh_status',
    'mesh_inspect',
    'mesh_query_topology',
  ],
  adapter: [
    'relay_list_adapters',
    'relay_enable_adapter',
    'relay_disable_adapter',
    'relay_reload_adapters',
    'binding_list',
    'binding_create',
    'binding_delete',
    'binding_list_sessions',
    'relay_notify_user',
  ],
} as const;

type ToolDomainKey = 'tasks' | 'relay' | 'mesh' | 'adapter';
type GlobalConfigKey = 'tasksTools' | 'relayTools' | 'meshTools' | 'adapterTools';

interface ToolDomain {
  key: ToolDomainKey;
  configKey: GlobalConfigKey;
  label: string;
  description: string;
  tools: readonly string[];
  serverDisabled?: boolean;
  serverDisabledReason?: string;
}

interface ToolGroupRowProps {
  domain: ToolDomain;
  agentOverride: boolean | undefined;
  globalDefault: boolean;
  onToggle: (key: ToolDomainKey, value: boolean) => void;
  onReset: (key: ToolDomainKey) => void;
}

// ---------------------------------------------------------------------------
// ToolCountBadge — shows tool count with tooltip listing all tool names.
// Duplicated from Settings ToolsTab (FSD prevents cross-feature imports).
// ---------------------------------------------------------------------------

/** Badge showing tool count that reveals the full tool list on hover. */
function ToolCountBadge({ tools }: { tools: readonly string[] }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className="text-muted-foreground shrink-0 cursor-default text-xs font-normal"
        >
          {tools.length}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <p className="font-mono text-xs">{tools.join(', ')}</p>
      </TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// ToolGroupRow — single tool domain with switch, effective state, reset.
// ---------------------------------------------------------------------------

/**
 * A single tool group row showing its effective on/off state.
 * Shows a "default" badge when inheriting from global config and a reset
 * button when the agent has an explicit override.
 */
function ToolGroupRow({
  domain,
  agentOverride,
  globalDefault,
  onToggle,
  onReset,
}: ToolGroupRowProps) {
  const isOverridden = agentOverride !== undefined;
  const effectiveValue = agentOverride ?? globalDefault;

  if (domain.serverDisabled) {
    return (
      <SettingRow label={domain.label} description={domain.description} className="py-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-xs">
                Disabled
              </Badge>
              <ToolCountBadge tools={domain.tools} />
              <Switch checked={false} disabled aria-label={`Toggle ${domain.label} tools`} />
            </div>
          </TooltipTrigger>
          <TooltipContent side="left">
            {domain.serverDisabledReason ?? 'Disabled globally by server configuration.'}
          </TooltipContent>
        </Tooltip>
      </SettingRow>
    );
  }

  return (
    <SettingRow label={domain.label} description={domain.description} className="py-1">
      <div className="flex items-center gap-2">
        {!isOverridden && (
          <Badge variant="outline" className="text-muted-foreground text-xs font-normal">
            default
          </Badge>
        )}
        {isOverridden && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0"
                onClick={() => onReset(domain.key)}
                aria-label={`Reset ${domain.label} to default`}
              >
                <RotateCcw className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Reset to global default</TooltipContent>
          </Tooltip>
        )}
        <ToolCountBadge tools={domain.tools} />
        <Switch
          checked={effectiveValue}
          onCheckedChange={(value) => onToggle(domain.key, value)}
          aria-label={`Toggle ${domain.label} tools`}
        />
      </div>
    </SettingRow>
  );
}

// ---------------------------------------------------------------------------
// ToolsTab — per-agent tool access and safety limits.
// ---------------------------------------------------------------------------

interface ToolsTabProps {
  agent: AgentManifest;
  onUpdate: (updates: Partial<AgentManifest>) => void;
}

/**
 * Tools tab for agent configuration: per-agent tool group overrides
 * and collapsible safety limits (budget).
 */
export function ToolsTab({ agent, onUpdate }: ToolsTabProps) {
  const [limitsOpen, setLimitsOpen] = useState(false);
  const relayEnabled = useRelayEnabled();
  const tasksEnabled = useTasksEnabled();
  const { config: globalConfig } = useAgentContextConfig();

  const handleToolGroupChange = useCallback(
    (key: ToolDomainKey, value: boolean) => {
      const current = agent.enabledToolGroups ?? {};
      onUpdate({ enabledToolGroups: { ...current, [key]: value } });
    },
    [agent.enabledToolGroups, onUpdate]
  );

  const handleToolGroupReset = useCallback(
    (key: ToolDomainKey) => {
      const current = { ...(agent.enabledToolGroups ?? {}) };
      delete current[key];
      onUpdate({ enabledToolGroups: current });
    },
    [agent.enabledToolGroups, onUpdate]
  );

  const toolDomains: ToolDomain[] = [
    {
      key: 'tasks',
      configKey: 'tasksTools',
      label: 'Scheduling',
      description: 'Create and run scheduled agent tasks',
      tools: TOOL_INVENTORY.tasks,
      serverDisabled: !tasksEnabled,
      serverDisabledReason: 'Disabled globally by server configuration.',
    },
    {
      key: 'relay',
      configKey: 'relayTools',
      label: 'Messaging',
      description: 'Send and receive messages between agents',
      tools: TOOL_INVENTORY.relay,
      serverDisabled: !relayEnabled,
      serverDisabledReason: 'Disabled globally by server configuration.',
    },
    {
      key: 'mesh',
      configKey: 'meshTools',
      label: 'Agent Discovery',
      description: 'Find and register agents on this machine',
      tools: TOOL_INVENTORY.mesh,
    },
    {
      key: 'adapter',
      configKey: 'adapterTools',
      label: 'External Channels',
      description: 'Manage connections to Slack, Telegram, and other platforms',
      tools: TOOL_INVENTORY.adapter,
      serverDisabled: !relayEnabled,
      serverDisabledReason: 'Disabled globally by server configuration.',
    },
  ];

  const groups: EnabledToolGroups = agent.enabledToolGroups ?? {};

  const hops = agent.budget?.maxHopsPerMessage ?? 5;
  const calls = agent.budget?.maxCallsPerHour ?? 100;

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Control which tool groups are available to this agent. Leave unset to inherit global
        defaults.
      </p>

      <FieldCard>
        <FieldCardContent>
          {toolDomains.map((domain) => (
            <ToolGroupRow
              key={domain.key}
              domain={domain}
              agentOverride={groups[domain.key]}
              globalDefault={globalConfig[domain.configKey]}
              onToggle={handleToolGroupChange}
              onReset={handleToolGroupReset}
            />
          ))}
        </FieldCardContent>
      </FieldCard>

      <p className="text-muted-foreground text-xs">
        Core tools (ping, server info, agent identity) are always available.
      </p>

      <CollapsibleFieldCard
        open={limitsOpen}
        onOpenChange={setLimitsOpen}
        trigger="Limits"
        badge={
          <span className="text-muted-foreground text-xs font-normal">
            {hops} hops · {calls} calls/hr
          </span>
        }
      >
        <SettingRow
          label="Message forwarding depth"
          description="Maximum agents a message can pass through before stopping"
          orientation="vertical"
        >
          <Input
            type="number"
            min={1}
            value={hops}
            onChange={(e) =>
              onUpdate({
                budget: {
                  ...agent.budget,
                  maxHopsPerMessage: parseInt(e.target.value) || 5,
                },
              })
            }
            className="w-24"
          />
        </SettingRow>
        <SettingRow
          label="Hourly rate limit"
          description="Maximum tool invocations per hour. The agent pauses when exceeded."
          orientation="vertical"
        >
          <Input
            type="number"
            min={1}
            value={calls}
            onChange={(e) =>
              onUpdate({
                budget: {
                  ...agent.budget,
                  maxCallsPerHour: parseInt(e.target.value) || 100,
                },
              })
            }
            className="w-24"
          />
        </SettingRow>
      </CollapsibleFieldCard>
    </div>
  );
}
