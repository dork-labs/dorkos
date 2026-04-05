import { useState, useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown } from 'lucide-react';
import { useRelayEnabled } from '@/layers/entities/relay';
import { useTasksEnabled } from '@/layers/entities/tasks';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import {
  Badge,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { useAgentContextConfig } from '@/layers/features/agent-settings/model/use-agent-context-config';

// ---------------------------------------------------------------------------
// Tool inventories — display names without the mcp__dorkos__ prefix.
// Source of truth: services/runtimes/claude-code/tool-filter.ts
// ---------------------------------------------------------------------------

const TOOL_INVENTORY = {
  core: ['ping', 'get_server_info', 'get_session_count', 'get_agent', 'control_ui', 'get_ui_state'],
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

const CONFIG_KEY_MAP: Record<ToolDomainKey, GlobalConfigKey> = {
  tasks: 'tasksTools',
  relay: 'relayTools',
  mesh: 'meshTools',
  adapter: 'adapterTools',
};

interface ToolGroupDef {
  key: ToolDomainKey;
  label: string;
  description: string;
  tools: readonly string[];
  implicitNote?: string;
}

const TOOL_GROUPS: ToolGroupDef[] = [
  {
    key: 'tasks',
    label: 'Tasks (Scheduling)',
    description: 'Create and manage scheduled agent runs',
    tools: TOOL_INVENTORY.tasks,
  },
  {
    key: 'relay',
    label: 'Relay (Messaging)',
    description: 'Send messages, check inbox, register endpoints',
    tools: TOOL_INVENTORY.relay,
    implicitNote: 'Includes trace tools (relay_get_trace, relay_get_metrics)',
  },
  {
    key: 'mesh',
    label: 'Mesh (Discovery)',
    description: 'Discover, register, and query agents',
    tools: TOOL_INVENTORY.mesh,
  },
  {
    key: 'adapter',
    label: 'Relay Adapters',
    description: 'Manage Telegram, Slack, webhooks, and bindings',
    tools: TOOL_INVENTORY.adapter,
    implicitNote: 'Includes binding tools (binding_list, binding_create, binding_delete)',
  },
];

// ---------------------------------------------------------------------------
// ToolGroupRow — single tool domain with switch, status, and tool inventory.
// Supports an optional expandable section for nested configuration.
// ---------------------------------------------------------------------------

interface ToolGroupRowProps {
  group: ToolGroupDef;
  enabled: boolean;
  available: boolean;
  initError?: string;
  overrideCount: number;
  onToggle: (key: ToolDomainKey, value: boolean) => void;
  /** Optional content shown when the row is expanded (e.g., scheduler settings). */
  expandContent?: React.ReactNode;
}

/** A single tool group row with switch, init error, override count, and tool inventory tooltip. */
function ToolGroupRow({
  group,
  enabled,
  available,
  initError,
  overrideCount,
  onToggle,
  expandContent,
}: ToolGroupRowProps) {
  const [expanded, setExpanded] = useState(false);
  const hasExpand = !!expandContent;

  const controls = (
    <div className="flex items-center gap-2">
      {initError && (
        <Tooltip>
          <TooltipTrigger asChild>
            <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            <p className="text-xs">{initError}</p>
          </TooltipContent>
        </Tooltip>
      )}
      {!available && !initError && (
        <Badge variant="secondary" className="text-xs">
          Disabled
        </Badge>
      )}
      {overrideCount > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-muted-foreground shrink-0 text-xs">
              {overrideCount} {overrideCount === 1 ? 'override' : 'overrides'}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="text-xs">
              {overrideCount} {overrideCount === 1 ? 'agent has' : 'agents have'} a per-agent
              override for this group
            </p>
          </TooltipContent>
        </Tooltip>
      )}
      <ToolCountBadge tools={group.tools} implicitNote={group.implicitNote} />
      <Switch
        checked={enabled}
        onCheckedChange={(v) => onToggle(group.key, v)}
        disabled={!available}
        aria-label={`Toggle ${group.label}`}
      />
      {hasExpand && (
        <CollapsibleTrigger asChild>
          <button
            className="text-muted-foreground hover:text-foreground rounded-sm p-0.5 transition-colors duration-150"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${group.label} settings`}
          >
            <ChevronDown
              className={cn(
                'size-3.5 transition-transform duration-150',
                !expanded && '-rotate-90'
              )}
            />
          </button>
        </CollapsibleTrigger>
      )}
    </div>
  );

  const row = (
    <SettingRow label={group.label} description={group.description}>
      {controls}
    </SettingRow>
  );

  if (!hasExpand) return row;

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      {row}
      <CollapsibleContent>
        <div className="border-border mt-2 space-y-2 border-t pt-2">{expandContent}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// ToolCountBadge — shows tool count with tooltip listing all tool names
// ---------------------------------------------------------------------------

interface ToolCountBadgeProps {
  tools: readonly string[];
  implicitNote?: string;
}

/** Badge showing tool count that reveals the full tool list on hover. */
function ToolCountBadge({ tools, implicitNote }: ToolCountBadgeProps) {
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
        {implicitNote && <p className="text-muted-foreground mt-1 text-xs">{implicitNote}</p>}
      </TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// SchedulerSettings — nested configuration for the Tasks scheduler
// ---------------------------------------------------------------------------

interface SchedulerSettingsProps {
  scheduler: { maxConcurrentRuns: number; timezone: string | null; retentionCount: number };
  onUpdate: (patch: Record<string, unknown>) => void;
}

/** Scheduler configuration rows rendered inside the Tasks tool group expansion. */
function SchedulerSettings({ scheduler, onUpdate }: SchedulerSettingsProps) {
  return (
    <>
      <SettingRow label="Concurrent runs" description="Maximum parallel task runs">
        <Input
          type="number"
          min={1}
          max={10}
          value={scheduler.maxConcurrentRuns}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (v >= 1 && v <= 10) onUpdate({ maxConcurrentRuns: v });
          }}
          className="w-20"
        />
      </SettingRow>

      <SettingRow label="Timezone" description="IANA timezone for cron schedules">
        <Select
          value={scheduler.timezone ?? 'system'}
          onValueChange={(v) => onUpdate({ timezone: v === 'system' ? null : v })}
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

      <SettingRow label="Run history" description="Completed runs to keep">
        <Input
          type="number"
          min={1}
          max={10000}
          value={scheduler.retentionCount}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (v >= 1) onUpdate({ retentionCount: v });
          }}
          className="w-24"
        />
      </SettingRow>
    </>
  );
}

// ---------------------------------------------------------------------------
// ToolsTab — main component
// ---------------------------------------------------------------------------

/**
 * Tools tab for the Settings dialog.
 *
 * Displays global toggle switches for each MCP tool group with tool inventories,
 * init error warnings, and per-agent override counts. The Tasks group includes
 * an expandable scheduler configuration section. These are global defaults;
 * per-agent overrides are set in the Agent dialog Capabilities tab.
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

  // Count per-agent tool group overrides
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

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Control which MCP tool groups are available to agents. These are global defaults —
        individual agents can override them in their Capabilities tab.
      </p>

      <FieldCard>
        <FieldCardContent>
          {/* Core tools — always enabled, informational */}
          <SettingRow label="Core Tools" description="Server info, agent identity, UI control">
            <div className="flex items-center gap-2">
              <ToolCountBadge tools={TOOL_INVENTORY.core} />
              <span className="text-muted-foreground text-xs">Always enabled</span>
            </div>
          </SettingRow>

          {/* Toggleable tool groups */}
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
    </div>
  );
}
