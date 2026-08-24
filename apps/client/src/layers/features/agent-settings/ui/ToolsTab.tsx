import { useCallback } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  Badge,
  Button,
  FieldCard,
  FieldCardContent,
  SettingRow,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/layers/shared/ui';
import type { AgentManifest, EnabledToolGroups } from '@dorkos/shared/mesh-schemas';
import { toolNamesForDomain, type ToolDomainKey } from '@dorkos/shared/mcp-tool-groups';
import { useRelayEnabled } from '@/layers/entities/relay';
import { useTasksEnabled } from '@/layers/entities/tasks';
import { useCapabilitiesForRuntime } from '@/layers/entities/runtime';
import { useAgentContextConfig } from '../model/use-agent-context-config';
import { AgentMcpServers } from './AgentMcpServers';

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
// ToolsTab — per-agent tool groups and safety limits.
// ---------------------------------------------------------------------------

interface ToolsTabProps {
  agent: AgentManifest;
  projectPath: string;
  onUpdate: (updates: Partial<AgentManifest>) => void;
}

/**
 * Tools tab for agent configuration: per-agent tool group overrides and
 * MCP server overview.
 */
export function ToolsTab({ agent, projectPath, onUpdate }: ToolsTabProps) {
  const relayEnabled = useRelayEnabled();
  const tasksEnabled = useTasksEnabled();
  const { config: globalConfig } = useAgentContextConfig();

  // DorkOS's own tool groups (Scheduling/Messaging/Discovery/Integrations) are
  // injected as an MCP server. A runtime that can't consume MCP (e.g. Codex,
  // `supportsMcp: false`) never receives them, so the toggles would be
  // dishonest. Default to available while capabilities load so Claude never
  // flashes the gated state. See use-runtime-capabilities.
  const caps = useCapabilitiesForRuntime(agent.runtime);
  const supportsDorkTools = caps?.supportsMcp ?? true;

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
      description: 'Create and run scheduled tasks',
      tools: toolNamesForDomain('tasks'),
      serverDisabled: !tasksEnabled,
      serverDisabledReason: 'Disabled globally by server configuration.',
    },
    {
      key: 'relay',
      configKey: 'relayTools',
      label: 'Messaging',
      description: 'Send and receive messages between agents',
      tools: toolNamesForDomain('relay'),
      serverDisabled: !relayEnabled,
      serverDisabledReason: 'Disabled globally by server configuration.',
    },
    {
      key: 'mesh',
      configKey: 'meshTools',
      label: 'Agent Discovery',
      description: 'Find and register agents on this machine',
      tools: toolNamesForDomain('mesh'),
    },
    {
      key: 'adapter',
      configKey: 'adapterTools',
      label: 'External Integrations',
      description: 'Manage integrations with Slack, Telegram, and other platforms',
      tools: toolNamesForDomain('adapter'),
      serverDisabled: !relayEnabled,
      serverDisabledReason: 'Disabled globally by server configuration.',
    },
  ];

  const groups: EnabledToolGroups = agent.enabledToolGroups ?? {};

  return (
    <div className="space-y-4">
      {supportsDorkTools ? (
        <>
          <p className="text-muted-foreground text-sm">
            Choose which tool groups this agent is told about. Turn a group off and the agent stops
            being told those tools exist, so it stops reaching for them. This is guidance, not a
            lock: if the agent asks for one anyway, you still get an approval prompt. Leave a group
            unset to inherit the global default.
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
            Core tools (ping, server info, agent identity) are always registered, whatever you set
            here.
          </p>
        </>
      ) : (
        <FieldCard>
          <FieldCardContent>
            <p className="text-muted-foreground text-sm">
              This agent&rsquo;s runtime does not support DorkOS tool groups (Scheduling, Messaging,
              Agent Discovery, External Integrations). These are delivered over MCP, which this
              runtime cannot consume.
            </p>
          </FieldCardContent>
        </FieldCard>
      )}

      <AgentMcpServers agent={agent} projectPath={projectPath} />
    </div>
  );
}
