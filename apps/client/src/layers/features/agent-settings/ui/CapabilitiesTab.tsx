import { useState, useCallback, useRef, useEffect, type KeyboardEvent } from 'react';
import { X, RotateCcw } from 'lucide-react';
import {
  Badge,
  Button,
  Label,
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
import type { AgentManifest, EnabledToolGroups } from '@dorkos/shared/mesh-schemas';
import { useRelayEnabled } from '@/layers/entities/relay';
import { usePulseEnabled } from '@/layers/entities/pulse';
import { useAgentContextConfig } from '../model/use-agent-context-config';

interface CapabilitiesTabProps {
  agent: AgentManifest;
  onUpdate: (updates: Partial<AgentManifest>) => void;
}

type ToolDomainKey = 'pulse' | 'relay' | 'mesh' | 'adapter';
type GlobalConfigKey = 'pulseTools' | 'relayTools' | 'meshTools' | 'adapterTools';

interface ToolDomain {
  key: ToolDomainKey;
  configKey: GlobalConfigKey;
  label: string;
  description: string;
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

/**
 * A single tool group row with switch, inherited/overridden state label,
 * and optional reset button.
 */
function ToolGroupRow({ domain, agentOverride, globalDefault, onToggle, onReset }: ToolGroupRowProps) {
  const isOverridden = agentOverride !== undefined;
  const effectiveValue = agentOverride ?? globalDefault;

  const stateLabel = isOverridden
    ? `Overridden: ${effectiveValue ? 'On' : 'Off'}`
    : 'Inherited';

  if (domain.serverDisabled) {
    return (
      <div className="flex items-center justify-between py-1">
        <div className="space-y-0.5">
          <Label className="text-sm font-medium">{domain.label}</Label>
          <p className="text-muted-foreground text-xs">{domain.description}</p>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground/50 text-xs">Server off</span>
              <Switch checked={false} disabled aria-label={`Toggle ${domain.label} tools`} />
            </div>
          </TooltipTrigger>
          <TooltipContent side="left">
            {domain.serverDisabledReason ?? 'Disabled globally by server configuration.'}
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between py-1">
      <div className="space-y-0.5">
        <Label className="text-sm font-medium">{domain.label}</Label>
        <p className="text-muted-foreground text-xs">{domain.description}</p>
      </div>
      <div className="flex items-center gap-2">
        <span className={`text-xs ${isOverridden ? 'text-foreground' : 'text-muted-foreground'}`}>
          {stateLabel}
        </span>
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
            <TooltipContent side="top">Reset to default</TooltipContent>
          </Tooltip>
        )}
        <Switch
          checked={effectiveValue}
          onCheckedChange={(value) => onToggle(domain.key, value)}
          aria-label={`Toggle ${domain.label} tools`}
        />
      </div>
    </div>
  );
}

const INPUT_CLASSES =
  'border-border bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2';

const DEBOUNCE_MS = 500;

/**
 * Capabilities tab for agent configuration: tag-based capabilities,
 * namespace, response mode, budget fields, and per-agent tool group toggles.
 */
export function CapabilitiesTab({ agent, onUpdate }: CapabilitiesTabProps) {
  const [capInput, setCapInput] = useState('');
  const relayEnabled = useRelayEnabled();
  const pulseEnabled = usePulseEnabled();
  const { config: globalConfig } = useAgentContextConfig();

  // Debounced namespace input (same pattern as IdentityTab)
  const [nsValue, setNsValue] = useState(agent.namespace ?? '');
  const nsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setNsValue(agent.namespace ?? '');
  }, [agent.namespace]);

  const handleNsChange = useCallback(
    (value: string) => {
      setNsValue(value);
      if (nsTimerRef.current) clearTimeout(nsTimerRef.current);
      nsTimerRef.current = setTimeout(() => {
        onUpdate({ namespace: value || undefined });
      }, DEBOUNCE_MS);
    },
    [onUpdate]
  );

  const handleNsBlur = useCallback(() => {
    if (nsTimerRef.current) clearTimeout(nsTimerRef.current);
    const current = nsValue || undefined;
    if (current !== agent.namespace) {
      onUpdate({ namespace: current });
    }
  }, [nsValue, agent.namespace, onUpdate]);

  useEffect(() => {
    return () => {
      if (nsTimerRef.current) clearTimeout(nsTimerRef.current);
    };
  }, []);

  const addCapability = useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed || agent.capabilities.includes(trimmed)) return;
      onUpdate({ capabilities: [...agent.capabilities, trimmed] });
      setCapInput('');
    },
    [agent.capabilities, onUpdate]
  );

  const removeCapability = useCallback(
    (cap: string) => {
      onUpdate({ capabilities: agent.capabilities.filter((c) => c !== cap) });
    },
    [agent.capabilities, onUpdate]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addCapability(capInput);
      }
    },
    [capInput, addCapability]
  );

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

  // Build domain definitions with server-disabled state resolved at render time
  const toolDomains: ToolDomain[] = [
    {
      key: 'pulse',
      configKey: 'pulseTools',
      label: 'Pulse (Scheduling)',
      description: 'Create and manage scheduled agent runs',
      serverDisabled: !pulseEnabled,
      serverDisabledReason: 'Disabled globally by server configuration.',
    },
    {
      key: 'relay',
      configKey: 'relayTools',
      label: 'Relay (Messaging)',
      description: 'Send messages, check inbox, register endpoints',
      serverDisabled: !relayEnabled,
      serverDisabledReason: 'Disabled globally by server configuration.',
    },
    {
      key: 'mesh',
      configKey: 'meshTools',
      label: 'Mesh (Discovery)',
      description: 'Discover, register, and query agents',
    },
    {
      key: 'adapter',
      configKey: 'adapterTools',
      label: 'Relay Adapters',
      description: 'Manage Slack, Telegram, and other adapters',
      serverDisabled: !relayEnabled,
      serverDisabledReason: 'Disabled globally by server configuration.',
    },
  ];

  const groups: EnabledToolGroups = agent.enabledToolGroups ?? {};

  return (
    <div className="space-y-6">
      {/* Capabilities tags */}
      <div className="space-y-2">
        <Label htmlFor="cap-input" className="text-sm font-medium">
          Capabilities
        </Label>
        <div className="flex flex-wrap gap-1.5">
          {agent.capabilities.map((cap) => (
            <Badge key={cap} variant="secondary" className="gap-1 pr-1">
              {cap}
              <button
                onClick={() => removeCapability(cap)}
                className="hover:bg-muted rounded-sm p-0.5 transition-colors duration-150"
                aria-label={`Remove ${cap}`}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
        <input
          id="cap-input"
          type="text"
          value={capInput}
          onChange={(e) => setCapInput(e.target.value)}
          onKeyDown={handleKeyDown}
          className={INPUT_CLASSES}
          placeholder="Add capability and press Enter"
        />
      </div>

      {/* Namespace */}
      <div className="space-y-2">
        <Label htmlFor="agent-namespace" className="text-sm font-medium">
          Namespace
        </Label>
        <input
          id="agent-namespace"
          type="text"
          value={nsValue}
          onChange={(e) => handleNsChange(e.target.value)}
          onBlur={handleNsBlur}
          className={INPUT_CLASSES}
          placeholder="Optional grouping namespace"
        />
      </div>

      {/* Response Mode */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">Response Mode</Label>
        <Select
          value={agent.behavior?.responseMode ?? 'always'}
          onValueChange={(v) =>
            onUpdate({
              behavior: {
                ...agent.behavior,
                responseMode: v as AgentManifest['behavior']['responseMode'],
              },
            })
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="always">Always respond</SelectItem>
            <SelectItem value="direct-only">Direct messages only</SelectItem>
            <SelectItem value="mention-only">Mentions only</SelectItem>
            <SelectItem value="silent">Silent</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Budget */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">Budget</Label>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label htmlFor="max-hops" className="text-muted-foreground text-xs">
              Max Hops / Message
            </label>
            <input
              id="max-hops"
              type="number"
              min={1}
              value={agent.budget?.maxHopsPerMessage ?? 5}
              onChange={(e) =>
                onUpdate({
                  budget: {
                    ...agent.budget,
                    maxHopsPerMessage: parseInt(e.target.value) || 5,
                  },
                })
              }
              className={INPUT_CLASSES}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="max-calls" className="text-muted-foreground text-xs">
              Max Calls / Hour
            </label>
            <input
              id="max-calls"
              type="number"
              min={1}
              value={agent.budget?.maxCallsPerHour ?? 100}
              onChange={(e) =>
                onUpdate({
                  budget: {
                    ...agent.budget,
                    maxCallsPerHour: parseInt(e.target.value) || 100,
                  },
                })
              }
              className={INPUT_CLASSES}
            />
          </div>
        </div>
      </div>

      {/* Tool Groups */}
      <div className="space-y-3">
        <Label className="text-sm font-medium">Tool Groups</Label>
        <p className="text-muted-foreground text-xs">
          Override which MCP tool domains are available to this agent. Leave unset to inherit global
          defaults.
        </p>

        {/* Core Tools — always enabled, no toggle */}
        <div className="flex items-center justify-between py-1">
          <div className="space-y-0.5">
            <Label className="text-sm font-medium">Core Tools</Label>
            <p className="text-muted-foreground text-xs">
              ping, server info, agent identity
            </p>
          </div>
          <span className="text-muted-foreground text-xs">Always enabled</span>
        </div>

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
      </div>
    </div>
  );
}
