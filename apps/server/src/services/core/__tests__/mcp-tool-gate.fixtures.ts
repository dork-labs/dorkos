/**
 * The two servers' gated tools as `mcp-tool-gate.test.ts` drives them: the hand
 * tools from the real composers, and the five `tasks_*` tools through the
 * registry's gate, where they moved gated by these same names (C9a).
 *
 * @module services/core/__tests__/mcp-tool-gate.fixtures
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AgentToolDeps } from '../agent-tool-kit/agent-tool-kit.js';
import type { AgentIdentity } from '../agent-identity/agent-identity-service.js';
import { createExternalMcpServer } from '../mcp-server.js';
import { handRegisteredInSessionTools } from '../../runtimes/claude-code/mcp-tools/index.js';
import { composeDorkOsCapabilityRegistry } from '../self-description/dorkos-registry.js';
import { movedTaskProbeTools } from '../../tasks/agent-tools/__tests__/gated-task-tools.js';

/** A registered tool as both servers expose it to this file. */
export interface ProbeTool {
  name: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: unknown;
  call(args: unknown): Promise<CallToolResult>;
}

/** The in-session `dorkos` server's hand-registered tools, from the real composer. */
export function inSessionProbeTools(
  createDeps: () => AgentToolDeps,
  identity?: AgentIdentity
): Map<string, ProbeTool> {
  const tools = handRegisteredInSessionTools(createDeps(), {
    ...(identity ? { resolveContext: async () => ({ identity }) } : {}),
  }) as unknown as {
    name: string;
    inputSchema: Record<string, unknown>;
    handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
  }[];
  return new Map([
    ...tools.map(
      (tool) =>
        [
          tool.name,
          {
            name: tool.name,
            inputSchema: tool.inputSchema,
            call: (args: unknown) => tool.handler(args, {}),
          },
        ] as const
    ),
    ...movedTaskProbeTools(createDeps(), 'in-session', identity),
  ]);
}

/**
 * The external `/mcp` server's hand-registered tools, from the real composer, with
 * the registry-generated ones removed — those are gated inside `registry.invoke`
 * and are not this file's subject.
 */
export function externalProbeTools(
  createDeps: () => AgentToolDeps,
  identity?: AgentIdentity
): Map<string, ProbeTool> {
  const deps = createDeps();
  const server = createExternalMcpServer(deps, undefined, undefined, identity);
  const registered = (
    server as unknown as {
      _registeredTools: Record<
        string,
        {
          inputSchema?: { shape?: Record<string, unknown> };
          outputSchema?: unknown;
          handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
        }
      >;
    }
  )._registeredTools;
  const capabilityToolNames = new Set(
    composeDorkOsCapabilityRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
      operatorDeps: deps,
    })
      .capabilities.filter((cap) => cap.surfaces.mcp?.servers.includes('external'))
      .map((cap) => cap.surfaces.mcp!.toolName)
  );

  const tools = new Map<string, ProbeTool>(movedTaskProbeTools(deps, 'external', identity));
  for (const [name, tool] of Object.entries(registered)) {
    if (capabilityToolNames.has(name)) continue;
    tools.set(name, {
      name,
      inputSchema: tool.inputSchema?.shape ?? {},
      outputSchema: tool.outputSchema,
      call: (args: unknown) => tool.handler(args, {}),
    });
  }
  return tools;
}
