/** Host assembly supplies resources and tools; the standalone engine owns execution. */
import {
  DeferredToolRegistry,
  createLocalTools,
  createSkillTool,
  createToolSearch,
  createWebFetchTool,
  type ExecutionPolicy,
  type DoeEvent,
  type WebFetchOptions,
} from '@dorkos/doe';
import type {
  MessageOpts,
  ManagedMcpServerResolver,
  AgentRegistryPort,
} from '@dorkos/shared/agent-runtime';
import { homeOf, resolveAgentHome, type AgentHome } from '../../core/agent-identity/index.js';
import type { ConnectorRuntimeMcpInjection } from '../connector-tools.js';
import { assembleDoeMcp } from './mcp.js';
import { assembleDoeResources } from './resources.js';
import { buildDoeContext } from './context.js';
import { doeBuilderTool, type DoeBuilderLifecycle } from './builder.js';
/** Facade-owned turn binding and explicit child execution/network policies. */
export interface DoeHostOptions extends DoeBuilderLifecycle {
  sessionId: string;
  cwd: string;
  opts?: MessageOpts;
  signal: AbortSignal;
  agentPath?: AgentHome;
  managedMcp?: ManagedMcpServerResolver;
  connectorInjection?: ConnectorRuntimeMcpInjection | null;
  mesh?: AgentRegistryPort;
  relayWired?: boolean;
  builderExecutionPolicy?: ExecutionPolicy;
  onEvent?: (event: DoeEvent) => void;
  webFetchPolicy?: WebFetchOptions;
}
/** Assemble a new turn with no retained routing or directory grants. Caller owns token revocation. */
export async function assembleDoeHost(options: DoeHostOptions) {
  options.signal.throwIfAborted();
  const resolution = resolveAgentHome(options.cwd, options.opts?.forAgent);
  if (resolution.kind === 'refused') throw new Error('This turn cannot act as that agent.');
  const agentPath = options.agentPath ?? homeOf(resolution);
  const agentToAgent = !!(agentPath && options.mesh?.getByPath(agentPath) && options.relayWired);
  const mcp = await assembleDoeMcp({
    agentPath,
    connectorInjection: options.connectorInjection,
    servers: agentPath ? options.managedMcp?.injectableServersForCwd(agentPath) : undefined,
    signal: options.signal,
    agentToAgent,
  });
  try {
    const context = await buildDoeContext({
      cwd: options.cwd,
      agentPath,
      opts: options.opts,
      hostConnected: mcp.hostConnected,
      agentToAgent,
    });
    const { resources, pathPolicy } = await assembleDoeResources({
      cwd: options.cwd,
      agentPath,
      additionalDirectories: options.opts?.additionalDirectories,
      context,
    });
    const registry = new DeferredToolRegistry();
    for (const tool of createLocalTools({ workingDirectory: options.cwd, resources, pathPolicy }))
      registry.register(tool);
    registry.register(createSkillTool(resources));
    registry.register(createWebFetchTool(options.webFetchPolicy ?? { allowUrl: () => false }));
    registry.register(
      doeBuilderTool({
        cwd: options.cwd,
        resources,
        pathPolicy,
        executionPolicy: options.builderExecutionPolicy,
        onChildStart: options.onChildStart,
        onChildEnd: options.onChildEnd,
      })
    );
    for (const tool of mcp.tools) registry.register(tool);
    registry.register(createToolSearch(registry));
    options.signal.throwIfAborted();
    return {
      resources,
      registry,
      pathPolicy,
      agentPath,
      roomToolsPosture: mcp.hostConnected,
      dispose: mcp.dispose,
      mcpNames: mcp.names,
      trustedHostToolNames: mcp.trustedHostToolNames,
      mcpStatus: mcp.statuses,
      mcpServerConfigs: mcp.serverConfigs,
    };
  } catch (error) {
    await mcp.dispose();
    throw error;
  }
}

/** Complete turn-owned host assembly handed to the runtime facade. */
export type DoeHostAssembly = Awaited<ReturnType<typeof assembleDoeHost>>;
