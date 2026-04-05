import { useCallback, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useRelayAdapters } from '@/layers/entities/relay';
import { useRegisteredAgents, useAgentAccess } from '@/layers/entities/mesh';
import { useBindings } from '@/layers/entities/binding';
import { useAppStore, useTransport } from '@/layers/shared/model';
import type { AgentToolStatus, ChipState } from '@/layers/entities/agent';
import { useMcpConfig } from '@/layers/entities/agent';
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  ScrollArea,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';

interface ConnectionsViewProps {
  toolStatus: AgentToolStatus;
  agentId: string | null | undefined;
  activeSessionId: string | null;
}

const ADAPTER_STATE_COLORS: Record<string, string> = {
  connected: 'bg-green-500',
  disconnected: 'bg-amber-500',
  error: 'bg-red-500',
};

const TOOL_STATUS_COLORS: Record<ChipState, string> = {
  enabled: 'bg-green-500',
  'disabled-by-agent': 'bg-muted-foreground/20',
  'disabled-by-server': 'bg-muted-foreground/20',
};

const MCP_STATUS_COLORS: Partial<Record<string, string>> = {
  connected: 'bg-green-500',
  failed: 'bg-red-500',
  'needs-auth': 'bg-amber-500',
  pending: 'bg-amber-500',
  disabled: 'bg-muted-foreground/20',
};

const DORKOS_TOOLS = [
  { key: 'tasks' as const, label: 'Tasks' },
  { key: 'relay' as const, label: 'Relay' },
  { key: 'mesh' as const, label: 'Mesh' },
] as const;

const AGENT_CAP = 3;
const MCP_CAP = 4;

const EASE_OUT = [0, 0, 0.2, 1] as const;

const overflowCollapseVariants = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
} as const;
const overflowCollapseTransition = { duration: 0.2, ease: EASE_OUT } as const;

const sectionVisibilityVariants = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
} as const;
const sectionVisibilityTransition = { duration: 0.25, ease: EASE_OUT } as const;

const overflowTextVariants = {
  initial: { opacity: 0, y: 3 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -3 },
} as const;
const overflowTextTransition = { duration: 0.12, ease: EASE_OUT } as const;

const emptyStateVariants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
} as const;
const emptyStateTransition = { duration: 0.15, ease: EASE_OUT } as const;

/** Read-only channel and agent summary for the sidebar Connections tab. */
export function ConnectionsView({ toolStatus, agentId, activeSessionId }: ConnectionsViewProps) {
  const { setRelayOpen, setMeshOpen, setAgentDialogOpen, selectedCwd } = useAppStore();
  const relayEnabled = toolStatus.relay !== 'disabled-by-server';
  const meshEnabled = toolStatus.mesh !== 'disabled-by-server';
  const { data: adapters = [] } = useRelayAdapters(relayEnabled);
  const { data: bindings = [] } = useBindings();
  const { data: agentsData } = useRegisteredAgents(undefined, meshEnabled);
  const agents = useMemo(() => agentsData?.agents ?? [], [agentsData?.agents]);
  const { data: mcpConfig } = useMcpConfig(selectedCwd);
  const mcpServers = mcpConfig?.servers ?? [];
  const cappedMcpServers = mcpServers.slice(0, MCP_CAP);
  const mcpOverflow = Math.max(0, mcpServers.length - MCP_CAP);

  // Fetch agents reachable by the current agent. Only enabled when an agentId
  // is present and mesh is not disabled-by-server.
  // agentId ?? '' satisfies the string parameter; the enabled flag prevents
  // the query from firing when agentId is absent.
  const { data: accessData, isLoading: accessLoading } = useAgentAccess(
    agentId ?? '',
    meshEnabled && !!agentId
  );

  // Show only adapters that are either the built-in CCA (serves all agents) or
  // have a binding to the currently viewed agent.
  // Note: `builtin` means loaded from @dorkos/relay; only claude-code type serves all agents.
  const visibleAdapters = useMemo(() => {
    const isCca = (a: (typeof adapters)[number]) =>
      a.config.type === 'claude-code' && a.config.builtin === true;
    if (!agentId) return adapters.filter(isCca);
    const boundAdapterIds = new Set(
      bindings.filter((b) => b.agentId === agentId).map((b) => b.adapterId)
    );
    return adapters.filter((a) => isCca(a) || boundAdapterIds.has(a.config.id));
  }, [adapters, bindings, agentId]);

  // Filter agents to those reachable from the current agent. While loading or
  // on error (data undefined), fall back to showing all agents to avoid flicker
  // and fail-open gracefully.
  const visibleAgents = useMemo(() => {
    if (!agentId || accessLoading || !accessData) return agents;
    const reachableIds = new Set(accessData.agents.map((a) => a.id));
    return agents.filter((a) => reachableIds.has(a.id));
  }, [agents, agentId, accessData, accessLoading]);

  const cappedAgents = visibleAgents.slice(0, AGENT_CAP);
  const agentOverflow = Math.max(0, visibleAgents.length - AGENT_CAP);

  const [agentsExpanded, setAgentsExpanded] = useState(false);
  const [mcpExpanded, setMcpExpanded] = useState(false);
  const [reloading, setReloading] = useState(false);

  const transport = useTransport();
  const queryClient = useQueryClient();

  const handleReloadPlugins = useCallback(async () => {
    if (!activeSessionId || reloading) return;
    setReloading(true);
    try {
      const result = await transport.reloadPlugins(activeSessionId);
      await queryClient.invalidateQueries({ queryKey: ['mcp-config'] });
      if (result.errorCount > 0) {
        toast.warning(`Plugins reloaded with ${result.errorCount} error(s)`);
      } else {
        toast.success(
          `Reloaded ${result.pluginCount} plugin(s), ${result.commandCount} command(s)`
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to reload plugins');
    } finally {
      setReloading(false);
    }
  }, [activeSessionId, reloading, transport, queryClient]);

  const showRelaySection = relayEnabled;
  const showMeshSection = meshEnabled;

  return (
    <ScrollArea type="scroll" className="h-full">
      <div className="pr-1">
        {/* Adapters section */}
        <AnimatePresence initial={false}>
          {showRelaySection && (
            <motion.div
              variants={sectionVisibilityVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={sectionVisibilityTransition}
              className="overflow-hidden"
            >
              <SidebarGroup>
                <SidebarGroupLabel className="text-2xs text-muted-foreground/70 font-medium tracking-wider uppercase">
                  Channels
                </SidebarGroupLabel>
                <SidebarGroupAction
                  aria-label="Open Relay panel"
                  onClick={() => setRelayOpen(true)}
                >
                  <ArrowUpRight />
                </SidebarGroupAction>

                <AnimatePresence mode="wait" initial={false}>
                  {toolStatus.relay === 'disabled-by-agent' ? (
                    <motion.div
                      key="relay-disabled"
                      variants={emptyStateVariants}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      transition={emptyStateTransition}
                      className="px-3 py-2"
                    >
                      <p className="text-muted-foreground/60 text-sm">
                        Channels disabled for this agent
                      </p>
                    </motion.div>
                  ) : visibleAdapters.length === 0 ? (
                    <motion.div
                      key="relay-empty"
                      variants={emptyStateVariants}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      transition={emptyStateTransition}
                      className="px-3 py-2"
                    >
                      <p className="text-muted-foreground/60 text-sm">No channels configured</p>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="relay-list"
                      variants={emptyStateVariants}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      transition={emptyStateTransition}
                    >
                      <SidebarMenu>
                        {visibleAdapters.map((adapter) => (
                          <SidebarMenuItem key={adapter.config.id}>
                            <SidebarMenuButton
                              onClick={() => setRelayOpen(true)}
                              className="text-sm"
                            >
                              <span
                                className={cn(
                                  'size-2 shrink-0 rounded-full',
                                  ADAPTER_STATE_COLORS[adapter.status.state] ??
                                    'bg-muted-foreground/20',
                                  adapter.status.state === 'connected' && 'animate-tasks'
                                )}
                              />
                              <span className="truncate">{adapter.status.displayName}</span>
                              <span className="text-muted-foreground/50 ml-auto text-xs capitalize">
                                {adapter.status.state}
                              </span>
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        ))}
                      </SidebarMenu>
                    </motion.div>
                  )}
                </AnimatePresence>
              </SidebarGroup>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Agents section */}
        <AnimatePresence initial={false}>
          {showMeshSection && (
            <motion.div
              variants={sectionVisibilityVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={sectionVisibilityTransition}
              className="overflow-hidden"
            >
              <SidebarGroup>
                <SidebarGroupLabel className="text-2xs text-muted-foreground/70 font-medium tracking-wider uppercase">
                  Agents
                </SidebarGroupLabel>
                <SidebarGroupAction aria-label="Open Mesh panel" onClick={() => setMeshOpen(true)}>
                  <ArrowUpRight />
                </SidebarGroupAction>

                <AnimatePresence mode="wait" initial={false}>
                  {toolStatus.mesh === 'disabled-by-agent' ? (
                    <motion.div
                      key="mesh-disabled"
                      variants={emptyStateVariants}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      transition={emptyStateTransition}
                      className="px-3 py-2"
                    >
                      <p className="text-muted-foreground/60 text-sm">
                        Mesh disabled for this agent
                      </p>
                    </motion.div>
                  ) : visibleAgents.length === 0 ? (
                    <motion.div
                      key="mesh-empty"
                      variants={emptyStateVariants}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      transition={emptyStateTransition}
                      className="px-3 py-2"
                    >
                      <p className="text-muted-foreground/60 text-sm">No agents registered</p>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="mesh-list"
                      variants={emptyStateVariants}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      transition={emptyStateTransition}
                    >
                      {/* Always-visible capped agents */}
                      <SidebarMenu>
                        {cappedAgents.map((agent) => (
                          <SidebarMenuItem key={agent.id}>
                            <SidebarMenuButton
                              onClick={() => setMeshOpen(true)}
                              className="text-sm"
                            >
                              {/* Registered agents show a neutral dot — health status requires a separate topology query */}
                              <span className="bg-muted-foreground/40 size-2 shrink-0 rounded-full" />
                              <span className="truncate">{agent.name}</span>
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        ))}
                      </SidebarMenu>

                      {/* Overflow agents — height-collapse on expand/collapse */}
                      <AnimatePresence initial={false}>
                        {agentsExpanded && (
                          <motion.div
                            variants={overflowCollapseVariants}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                            transition={overflowCollapseTransition}
                            className="overflow-hidden"
                          >
                            <SidebarMenu>
                              {visibleAgents.slice(AGENT_CAP).map((agent) => (
                                <SidebarMenuItem key={agent.id}>
                                  <SidebarMenuButton
                                    onClick={() => setMeshOpen(true)}
                                    className="text-sm"
                                  >
                                    <span className="bg-muted-foreground/40 size-2 shrink-0 rounded-full" />
                                    <span className="truncate">{agent.name}</span>
                                  </SidebarMenuButton>
                                </SidebarMenuItem>
                              ))}
                            </SidebarMenu>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </motion.div>
                  )}
                </AnimatePresence>

                {agentOverflow > 0 && (
                  <div className="px-3 py-1">
                    <button
                      onClick={() => setAgentsExpanded((prev) => !prev)}
                      className="text-muted-foreground hover:text-foreground relative text-xs transition-colors"
                    >
                      <AnimatePresence mode="wait" initial={false}>
                        <motion.span
                          key={agentsExpanded ? 'less' : 'more'}
                          variants={overflowTextVariants}
                          initial="initial"
                          animate="animate"
                          exit="exit"
                          transition={overflowTextTransition}
                          className="block"
                        >
                          {agentsExpanded
                            ? 'Show less'
                            : `+ ${agentOverflow} more ${agentOverflow === 1 ? 'agent' : 'agents'} reachable →`}
                        </motion.span>
                      </AnimatePresence>
                    </button>
                  </div>
                )}
              </SidebarGroup>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Tools section */}
        <SidebarGroup>
          <SidebarGroupLabel className="text-2xs text-muted-foreground/70 font-medium tracking-wider uppercase">
            Tools
          </SidebarGroupLabel>
          <SidebarGroupAction
            aria-label="Edit capabilities"
            onClick={() => setAgentDialogOpen(true)}
          >
            <ArrowUpRight />
          </SidebarGroupAction>

          {/* Block 1: DorkOS built-in tools */}
          <SidebarMenu>
            {DORKOS_TOOLS.map(({ key, label }) => {
              const state = toolStatus[key];
              return (
                <SidebarMenuItem key={key}>
                  <SidebarMenuButton className="text-sm" onClick={() => setAgentDialogOpen(true)}>
                    <span
                      className={cn('size-2 shrink-0 rounded-full', TOOL_STATUS_COLORS[state])}
                    />
                    <span className="truncate">{label}</span>
                    <span className="text-muted-foreground/50 ml-auto text-xs">
                      {state === 'enabled' ? 'enabled' : 'off'}
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>

          {/* Block 2: Always-visible capped MCP servers */}
          <SidebarMenu>
            {cappedMcpServers.map((server) => (
              <SidebarMenuItem key={server.name}>
                <SidebarMenuButton className="text-sm">
                  <span
                    className={cn(
                      'size-2 shrink-0 rounded-full',
                      MCP_STATUS_COLORS[server.status ?? ''] ?? 'bg-muted-foreground/40',
                      server.status === 'connected' && 'animate-tasks'
                    )}
                  />
                  <span className="truncate">{server.name}</span>
                  <span className="text-muted-foreground/50 ml-auto text-xs">mcp</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}

            {/* Reload plugins action */}
            {activeSessionId && (
              <SidebarMenuItem>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <SidebarMenuButton
                      className="text-muted-foreground hover:text-foreground text-xs"
                      onClick={handleReloadPlugins}
                      disabled={reloading}
                      aria-label="Reload plugins"
                    >
                      <RefreshCw className={cn('size-3 shrink-0', reloading && 'animate-spin')} />
                      <span>Reload plugins</span>
                    </SidebarMenuButton>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    Reload MCP servers and commands from disk
                  </TooltipContent>
                </Tooltip>
              </SidebarMenuItem>
            )}
          </SidebarMenu>

          {/* Block 3: Overflow MCP servers — height-collapse on expand/collapse */}
          <AnimatePresence initial={false}>
            {mcpExpanded && (
              <motion.div
                variants={overflowCollapseVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={overflowCollapseTransition}
                className="overflow-hidden"
              >
                <SidebarMenu>
                  {mcpServers.slice(MCP_CAP).map((server) => (
                    <SidebarMenuItem key={server.name}>
                      <SidebarMenuButton className="text-sm">
                        <span
                          className={cn(
                            'size-2 shrink-0 rounded-full',
                            MCP_STATUS_COLORS[server.status ?? ''] ?? 'bg-muted-foreground/40',
                            server.status === 'connected' && 'animate-tasks'
                          )}
                        />
                        <span className="truncate">{server.name}</span>
                        <span className="text-muted-foreground/50 ml-auto text-xs">mcp</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </motion.div>
            )}
          </AnimatePresence>

          {mcpOverflow > 0 && (
            <div className="px-3 py-1">
              <button
                onClick={() => setMcpExpanded((prev) => !prev)}
                className="text-muted-foreground hover:text-foreground relative text-xs transition-colors"
              >
                <AnimatePresence mode="wait" initial={false}>
                  <motion.span
                    key={mcpExpanded ? 'less' : 'more'}
                    variants={overflowTextVariants}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    transition={overflowTextTransition}
                    className="block"
                  >
                    {mcpExpanded
                      ? 'Show less'
                      : `+ ${mcpOverflow} more ${mcpOverflow === 1 ? 'server' : 'servers'} →`}
                  </motion.span>
                </AnimatePresence>
              </button>
            </div>
          )}
        </SidebarGroup>
      </div>
    </ScrollArea>
  );
}
