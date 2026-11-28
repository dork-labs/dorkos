/**
 * The tasks tools as an agent reaches them now: the capabilities, through the
 * real registry and its gate, on one MCP server (C9a). The tests that drove the
 * hand gate drive this instead; it answers with the same MCP envelope.
 *
 * @module services/tasks/agent-tools/__tests__/gated-task-tools
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { noopLogger } from '@dorkos/shared/logger';
import type { AgentToolDeps } from '../../../core/agent-tool-kit/agent-tool-kit.js';
import type { AgentIdentity } from '../../../core/agent-identity/agent-identity-service.js';
import {
  composeRegistry,
  type CapabilityInvocationObserver,
  type CapabilityRegistry,
} from '../../../core/capabilities/registry.js';
import {
  capabilityMcpInputObject,
  invokeCapabilityAsMcpResult,
  type InSessionSurface,
} from '../../../core/capabilities/mcp-projection.js';
import { createCapabilityAttributionObserver } from '../../../core/agent-identity/capability-attribution.js';
import { tasksAgentToolsDomain } from '../task-agent-capabilities.js';
import { getTasksTools, type TaskToolDefinition } from '../task-tool-definitions.js';
import { createTaskToolReach } from '../../../../startup/task-tool-reach.js';

/** Who calls, and over which server. */
export interface TaskToolCaller {
  identity?: AgentIdentity;
  sessionId?: string;
  cwd?: string;
  turnSessionIds?: string[];
  narrowedReads?: true;
  /** Defaults to the in-session server. */
  mcpServer?: 'in-session' | 'external';
  /** The in-session hold, when the test watches one. */
  surface?: InSessionSurface;
}

/** One gated tool, shaped as the tests already call a tool. */
export interface GatedTaskTool {
  name: string;
  handler: (args: Record<string, unknown>, extra?: unknown) => Promise<CallToolResult>;
}

/**
 * The deps with the live reach wired in, as boot wires it.
 *
 * @param deps - The test's tool deps.
 */
export function withTaskReach(deps: AgentToolDeps): AgentToolDeps {
  return deps.tasksReach ? deps : { ...deps, tasksReach: createTaskToolReach() };
}

/**
 * A registry holding the tasks capabilities over `deps`.
 *
 * @param deps - The test's tool deps.
 * @param onInvocation - The observer, when the test reads the audit rows.
 */
export function taskToolRegistry(
  deps: AgentToolDeps,
  onInvocation?: CapabilityInvocationObserver
): CapabilityRegistry {
  return composeRegistry(
    [tasksAgentToolsDomain],
    { logger: noopLogger, operatorDeps: withTaskReach(deps) },
    onInvocation
  );
}

/**
 * The five tools by name, each run through the registry as `caller`.
 *
 * @param deps - The test's tool deps.
 * @param caller - Who calls, and over which server.
 * @param registry - A registry to reuse, when the test holds one.
 */
export function gatedTaskTools(
  deps: AgentToolDeps,
  caller: TaskToolCaller = {},
  registry: CapabilityRegistry = taskToolRegistry(deps)
): Record<string, GatedTaskTool> {
  const { surface, mcpServer = 'in-session', ...facts } = caller;
  const context = { ...facts, mcpServer };
  return Object.fromEntries(
    tasksAgentToolsDomain.capabilities.map((capability) => {
      const name = capability.surfaces.mcp!.toolName;
      const tool: GatedTaskTool = {
        name,
        handler: (args) =>
          invokeCapabilityAsMcpResult(registry, capability.id, args, context, surface),
      };
      return [name, tool];
    })
  );
}

/**
 * The five tools with no gate in front, as nothing in DorkOS registers them: for
 * the cases that prove a handler refuses on its own.
 *
 * @param deps - The test's tool deps.
 * @param provenance - The calling chat, as the in-session server reads it.
 */
export function ungatedTaskTools(
  deps: AgentToolDeps,
  provenance: { sessionId?: string; agentPath?: string; cwd?: string }
): Record<string, GatedTaskTool> {
  return Object.fromEntries(
    getTasksTools(withTaskReach(deps), () => provenance).map((t) => [
      t.name,
      { name: t.name, handler: (args) => t.handler(args as never) as Promise<CallToolResult> },
    ])
  );
}

/**
 * Call one tool and read its single JSON block.
 *
 * @param tool - The tool.
 * @param args - Its arguments.
 */
export async function callTaskTool(
  tool: { handler: (args: never, extra?: unknown) => Promise<unknown> },
  args: Record<string, unknown>
) {
  const result = (await tool.handler(args as never, undefined)) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return {
    result,
    isError: result.isError === true,
    payload: JSON.parse(result.content[0]!.text) as Record<string, unknown>,
  };
}

/**
 * The five plain definitions by name, over `deps` with the live reach wired in.
 *
 * @param deps - The test's tool deps.
 * @param resolvers - The caller, as `getTasksTools` takes it.
 */
export function taskToolsByName(
  deps: AgentToolDeps,
  ...resolvers: Parameters<typeof getTasksTools> extends [unknown, ...infer R] ? R : never
): Record<string, TaskToolDefinition> {
  return Object.fromEntries(
    getTasksTools(withTaskReach(deps), ...resolvers).map((t) => [t.name, t])
  );
}

/** The five moved tools' capabilities, by their MCP names. */
export const MOVED_TASK_TOOLS = new Map(
  tasksAgentToolsDomain.capabilities.map((cap) => [cap.surfaces.mcp!.toolName, cap] as const)
);

/**
 * The five tools through the registry's gate on one server, with the attribution
 * observer boot composes (it writes their `mcp.<name>` rows), shaped as the hand
 * gate's tests read a tool: its listed input and a way to call it.
 *
 * @param deps - The test's tool deps.
 * @param mcpServer - Which server.
 * @param identity - The caller, when it presented one.
 */
export function movedTaskProbeTools(
  deps: AgentToolDeps,
  mcpServer: 'in-session' | 'external',
  identity?: AgentIdentity
): [
  string,
  {
    name: string;
    inputSchema: Record<string, unknown>;
    call(args: unknown): Promise<CallToolResult>;
  },
][] {
  const registry = taskToolRegistry(
    deps,
    createCapabilityAttributionObserver({ emit() {} } as never)
  );
  const tools = gatedTaskTools(deps, { ...(identity ? { identity } : {}), mcpServer }, registry);
  return [...MOVED_TASK_TOOLS].map(([name, cap]) => [
    name,
    {
      name,
      inputSchema: capabilityMcpInputObject(cap).shape,
      call: (args: unknown) => tools[name]!.handler(args as Record<string, unknown>),
    },
  ]);
}
