import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import {
  Badge,
  Button,
  FieldCard,
  FieldCardContent,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingRow,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/layers/shared/ui';
import type { AgentManifest, EnabledToolGroups } from '@dorkos/shared/mesh-schemas';
import { DEFAULT_AGENT_TIER_CEILING, type CapabilityTier } from '@dorkos/shared/capabilities';
import { toolNamesForDomain, type ToolDomainKey } from '@dorkos/shared/mcp-tool-groups';
import { useRelayEnabled } from '@/layers/entities/relay';
import { useTasksEnabled } from '@/layers/entities/tasks';
import { useCapabilitiesForRuntime } from '@/layers/entities/runtime';
import { useToolNamesForGroup } from '@/layers/entities/capability';
import { useUpdateAgent as useUpdateMeshAgent } from '@/layers/entities/mesh';
import { agentKeys } from '@/layers/entities/agent';
import { TEAM_ROSTER_KEY } from '@/layers/entities/team';
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
}

/**
 * The one group that is a LOCK rather than a hint (DOR-1611).
 *
 * Its own card, visually apart from the four above it, because merging them
 * would make one paragraph describe two different mechanisms — and the whole
 * point of this row is that it does not behave like its neighbours.
 *
 * **Written through the operator's route, never the agent self-edit route.**
 * `PATCH /api/agents/current` REFUSES this field by design: a grant the governed
 * agent can set for itself is not a grant. The cockpit is the person, so it uses
 * `PATCH /api/mesh/agents/:id`, which is the only way in.
 *
 * **Rendered whatever the runtime is.** The four toggles above hide when a
 * runtime cannot consume in-session MCP, because there is nothing to describe to
 * it. This one still applies: a Codex or OpenCode agent reaches these same
 * capabilities over the external MCP server, and the grant is enforced there too.
 *
 * **And it refreshes what it invalidated.** The `agent` this card renders is
 * read through `useCurrentAgent`, which the mesh mutation knows nothing about —
 * it clears `['mesh','agents']` and stops. Without the two invalidations below
 * the switch flipped, the server stored it, and the next render put it straight
 * back where it was: a save that looked like a refusal. The keys are the ones
 * `useProfileAgent` already clears for the same reason.
 */
function ManageRoomsCard({
  agent,
  supportsDorkTools,
}: {
  agent: AgentManifest;
  supportsDorkTools: boolean;
}) {
  const tools = useToolNamesForGroup('roomsManage');
  const updateAgent = useUpdateMeshAgent();
  const queryClient = useQueryClient();
  const granted = agent.enabledToolGroups?.roomsManage === true;

  const onToggle = useCallback(
    (value: boolean) => {
      updateAgent.mutate(
        {
          id: agent.id,
          updates: {
            enabledToolGroups: { ...(agent.enabledToolGroups ?? {}), roomsManage: value },
          },
        },
        {
          // `onSettled`, not `onSuccess`: the switch is fully controlled by the
          // manifest, so a re-read is the only thing that ever moves it — and
          // after a REFUSED write it is the only thing that proves it did not.
          onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: agentKeys.all });
            void queryClient.invalidateQueries({ queryKey: TEAM_ROSTER_KEY });
          },
        }
      );
    },
    [agent.id, agent.enabledToolGroups, queryClient, updateAgent]
  );

  return (
    <FieldCard>
      <FieldCardContent className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Manage rooms</span>
              {tools.length > 0 ? <ToolCountBadge tools={tools} /> : null}
            </div>
            <p className="text-muted-foreground text-sm">
              Let this agent create channels and direct messages, add and remove members, rename a
              channel, and leave a channel.
            </p>
          </div>
          <Switch
            checked={granted}
            onCheckedChange={onToggle}
            disabled={updateAgent.isPending}
            aria-label="Manage rooms"
          />
        </div>
        <p className="text-muted-foreground text-sm">
          <span className="text-foreground font-medium">This switch is a lock, not a hint.</span>{' '}
          Unlike the groups above, turning it off blocks the calls: the agent is refused, and told
          to ask you. It is off until you turn it on, and only you can change it &mdash; the agent
          cannot turn it on for itself.
        </p>
        <p className="text-muted-foreground text-sm">
          It can never remove you from a room, and any room holding two agents holds you too.
        </p>
        {supportsDorkTools ? null : (
          <p className="text-muted-foreground text-sm">
            This agent&rsquo;s runtime reaches these over the external MCP server rather than
            in-session, and the switch applies there just the same.
          </p>
        )}
      </FieldCardContent>
    </FieldCard>
  );
}

/**
 * The outermost fence around an agent: the most it may ever do (DOR-486).
 *
 * Not a tool group and not a grant — a CAP. Every capability DorkOS exposes
 * carries a rung, and a capability above this one is refused outright, with the
 * refusal saying plainly that nobody can approve it. That is the difference
 * worth showing: the switch below can be answered by a person saying yes, and
 * this cannot.
 *
 * **Written through the operator's route, never the agent self-edit route**, for
 * the same reason the grant below it is: the self-edit route refuses any change
 * that WIDENS a ceiling, whoever sends it, so an agent cannot hand itself back
 * what a person took away. Lowering is the one direction an agent may take on
 * its own. The cockpit is the person, so it uses `PATCH /api/mesh/agents/:id`
 * and can set any rung.
 *
 * The two invalidations are the ones `ManageRoomsCard` explains: this card's
 * `agent` comes from `useCurrentAgent`, which the mesh mutation knows nothing
 * about, so without them the select would snap back after a successful save.
 */
function TierCeilingCard({ agent }: { agent: AgentManifest }) {
  const updateAgent = useUpdateMeshAgent();
  const queryClient = useQueryClient();
  const ceiling = agent.tierCeiling ?? DEFAULT_AGENT_TIER_CEILING;

  const onChange = useCallback(
    (value: string) => {
      updateAgent.mutate(
        { id: agent.id, updates: { tierCeiling: value as CapabilityTier } },
        {
          onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: agentKeys.all });
            void queryClient.invalidateQueries({ queryKey: TEAM_ROSTER_KEY });
          },
        }
      );
    },
    [agent.id, queryClient, updateAgent]
  );

  return (
    <FieldCard>
      <FieldCardContent className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <span className="text-sm font-medium">The most this agent can ever do</span>
            <p className="text-muted-foreground text-sm">
              Anything past this line is refused, and no approval can unlock it. Use it when you
              want an agent that reads your work but can never take anything away.
            </p>
          </div>
          <Select value={ceiling} onValueChange={onChange} disabled={updateAgent.isPending}>
            <SelectTrigger className="w-56" aria-label="The most this agent can ever do">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="observe">Read only</SelectItem>
              <SelectItem value="act">Change things, never delete</SelectItem>
              <SelectItem value="destructive">No extra limit</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p className="text-muted-foreground text-sm">
          Every agent starts with no extra limit, so nothing you already run changes until you set
          one here. An agent can tighten its own limit; only you can loosen it.
        </p>
        {/* Said plainly rather than left for someone to discover: the cap holds
            on the path an agent is meant to use, and an agent with a terminal
            can step off that path. Same residual, and same remedy, as the grant
            below — see `contributing/agent-operator-surface.md`. A limit whose
            edge is unstated reads as a sandbox, and this is not one. */}
        <p className="text-muted-foreground text-sm">
          This covers what the agent asks DorkOS to do. An agent that can run terminal commands can
          still act outside DorkOS &mdash; turn on Require login, in Settings under Security, to
          close that door too.
        </p>
      </FieldCardContent>
    </FieldCard>
  );
}

/**
 * Tools tab for agent configuration: per-agent tool group overrides and
 * MCP server overview.
 */
export function ToolsTab({ agent, projectPath }: ToolsTabProps) {
  const relayEnabled = useRelayEnabled();
  const tasksEnabled = useTasksEnabled();
  const { config: globalConfig } = useAgentContextConfig();
  const updateAgent = useUpdateMeshAgent();
  const queryClient = useQueryClient();

  // DorkOS's own tool groups (Scheduling/Messaging/Discovery/Integrations) are
  // injected as an MCP server. A runtime that can't consume MCP (e.g. Codex,
  // `supportsMcp: false`) never receives them, so the toggles would be
  // dishonest. Default to available while capabilities load so Claude never
  // flashes the gated state. See use-runtime-capabilities.
  const caps = useCapabilitiesForRuntime(agent.runtime);
  const supportsDorkTools = caps?.supportsMcp ?? true;

  // **Written through the operator's route, never the agent self-edit route**
  // (DOR-1506) — the same split `TierCeilingCard` and `ManageRoomsCard` below
  // already use, now covering all five keys of the object.
  //
  // `PATCH /api/agents/current` refuses every one of them: a per-agent value
  // BEATS the global `agentContext.*` switch (`resolveToolConfig`), and those
  // four are operator-only at the config seam, so leaving these writable there
  // let an agent undo a narrowing the person had made to its own tool context.
  // The cockpit is the person, so it uses `PATCH /api/mesh/agents/:id`.
  //
  // The whole stored object is sent, `roomsManage` included: the operator's
  // route carries the grant, and `deepMerge` is not in play here — the manifest
  // update REPLACES `enabledToolGroups`, so dropping the key would clear it.
  //
  // The two invalidations are the ones `ManageRoomsCard` explains: the `agent`
  // this tab renders comes from `useCurrentAgent`, which the mesh mutation knows
  // nothing about, so without them a saved toggle snaps straight back.
  const writeToolGroups = useCallback(
    (next: EnabledToolGroups) => {
      updateAgent.mutate(
        { id: agent.id, updates: { enabledToolGroups: next } },
        {
          onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: agentKeys.all });
            void queryClient.invalidateQueries({ queryKey: TEAM_ROSTER_KEY });
          },
        }
      );
    },
    [agent.id, queryClient, updateAgent]
  );

  const handleToolGroupChange = useCallback(
    (key: ToolDomainKey, value: boolean) => {
      writeToolGroups({ ...(agent.enabledToolGroups ?? {}), [key]: value });
    },
    [agent.enabledToolGroups, writeToolGroups]
  );

  const handleToolGroupReset = useCallback(
    (key: ToolDomainKey) => {
      const next = { ...(agent.enabledToolGroups ?? {}) };
      delete next[key];
      writeToolGroups(next);
    },
    [agent.enabledToolGroups, writeToolGroups]
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
            lock &mdash; an agent that asks for one anyway still gets it. Leave a group unset to
            inherit the global default.
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

      {/* Outside the runtime branch above, deliberately: the cap and the grant
          are enforced for every runtime, including the ones that cannot take
          DorkOS tools in-session and reach them over the external MCP server
          instead. */}
      <TierCeilingCard agent={agent} />

      <ManageRoomsCard agent={agent} supportsDorkTools={supportsDorkTools} />

      <AgentMcpServers agent={agent} projectPath={projectPath} />
    </div>
  );
}
