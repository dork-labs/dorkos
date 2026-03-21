import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';

/** Guard that returns an error response when Mesh is disabled. */
function requireMesh(deps: McpToolDeps) {
  if (!deps.meshCore) {
    return jsonContent({ error: 'Mesh is not enabled', code: 'MESH_DISABLED' }, true);
  }
  return null;
}

/** Discover agents by scanning directories. */
export function createMeshDiscoverHandler(deps: McpToolDeps) {
  return async (args: { roots: string[]; maxDepth?: number; includeRegistered?: boolean }) => {
    const err = requireMesh(deps);
    if (err) return err;
    try {
      const candidates = [];
      const autoImported = [];
      for await (const event of deps.meshCore!.discover(args.roots, {
        maxDepth: args.maxDepth,
      })) {
        if (event.type === 'candidate') {
          candidates.push(event.data);
        } else if (event.type === 'auto-import' && args.includeRegistered) {
          autoImported.push(event.data);
        }
      }
      return jsonContent({
        candidates,
        count: candidates.length,
        ...(args.includeRegistered && {
          registered: autoImported,
          registeredCount: autoImported.length,
        }),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Discovery failed';
      return jsonContent({ error: message, code: 'DISCOVER_FAILED' }, true);
    }
  };
}

/** Register an agent from a filesystem path. */
export function createMeshRegisterHandler(deps: McpToolDeps) {
  return async (args: {
    path: string;
    name?: string;
    description?: string;
    runtime?: string;
    capabilities?: string[];
  }) => {
    const err = requireMesh(deps);
    if (err) return err;
    try {
      const agent = await deps.meshCore!.registerByPath(
        args.path,
        {
          name: args.name ?? args.path.split('/').pop() ?? 'unnamed',
          runtime: (args.runtime ?? 'claude-code') as 'claude-code' | 'cursor' | 'codex' | 'other',
          ...(args.description && { description: args.description }),
          ...(args.capabilities && { capabilities: args.capabilities }),
        },
        'mcp-tool'
      );
      return jsonContent({ agent });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Registration failed';
      return jsonContent({ error: message, code: 'REGISTER_FAILED' }, true);
    }
  };
}

/** List registered agents with optional filters. */
export function createMeshListHandler(deps: McpToolDeps) {
  return async (args: { runtime?: string; capability?: string; callerNamespace?: string }) => {
    const err = requireMesh(deps);
    if (err) return err;
    const hasFilters = args.runtime || args.capability || args.callerNamespace;
    const agents = deps.meshCore!.list(
      hasFilters
        ? {
            runtime: args.runtime as 'claude-code' | 'cursor' | 'codex' | 'other' | undefined,
            capability: args.capability,
            callerNamespace: args.callerNamespace,
          }
        : undefined
    );
    return jsonContent({ agents, count: agents.length });
  };
}

/** Deny a candidate path from future discovery. */
export function createMeshDenyHandler(deps: McpToolDeps) {
  return async (args: { path: string; reason?: string }) => {
    const err = requireMesh(deps);
    if (err) return err;
    try {
      await deps.meshCore!.deny(args.path, args.reason, 'mcp-tool');
      return jsonContent({ success: true, path: args.path });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Deny failed';
      return jsonContent({ error: message, code: 'DENY_FAILED' }, true);
    }
  };
}

/** Unregister an agent by ID. */
export function createMeshUnregisterHandler(deps: McpToolDeps) {
  return async (args: { agentId: string }) => {
    const err = requireMesh(deps);
    if (err) return err;
    try {
      const agent = deps.meshCore!.get(args.agentId);
      if (!agent) {
        return jsonContent({ error: `Agent ${args.agentId} not found` }, true);
      }
      await deps.meshCore!.unregister(args.agentId);
      return jsonContent({ success: true, agentId: args.agentId });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unregister failed';
      return jsonContent({ error: message, code: 'UNREGISTER_FAILED' }, true);
    }
  };
}

/** Get aggregate mesh health status. */
export function createMeshStatusHandler(deps: McpToolDeps) {
  return async () => {
    const err = requireMesh(deps);
    if (err) return err;
    const status = deps.meshCore!.getStatus();
    return jsonContent(status);
  };
}

/** Inspect a specific agent — manifest, health status, relay endpoint. */
export function createMeshInspectHandler(deps: McpToolDeps) {
  return async (args: { agentId: string }) => {
    const err = requireMesh(deps);
    if (err) return err;
    const result = deps.meshCore!.inspect(args.agentId);
    if (!result) {
      return {
        content: [{ type: 'text' as const, text: `Agent ${args.agentId} not found` }],
        isError: true,
      };
    }
    return jsonContent(result);
  };
}

/** Query the agent network topology visible to a given namespace. */
export function createMeshQueryTopologyHandler(deps: McpToolDeps) {
  return async (args: { namespace?: string }) => {
    const err = requireMesh(deps);
    if (err) return err;
    const topology = deps.meshCore!.getTopology(args.namespace ?? '*');
    return jsonContent(topology);
  };
}

/** Returns the mesh tool definitions — only when meshCore is provided. */
export function getMeshTools(deps: McpToolDeps) {
  if (!deps.meshCore) return [];

  return [
    tool(
      'mesh_discover',
      'Scan directories for agent candidates. By default returns only unregistered agents (candidates). Set includeRegistered to also see already-registered agents found during the scan.',
      {
        roots: z.array(z.string()).describe('Root directories to scan for agents'),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Maximum directory depth (default: 5)'),
        includeRegistered: z
          .boolean()
          .optional()
          .describe(
            'Include already-registered agents in results (default: false — unregistered candidates only)'
          ),
      },
      createMeshDiscoverHandler(deps)
    ),
    tool(
      'mesh_register',
      'Register an agent from a filesystem path. Creates a .dork/agent.json manifest and adds the agent to the registry.',
      {
        path: z.string().describe('Filesystem path to the agent directory'),
        name: z.string().optional().describe('Display name override'),
        description: z.string().optional().describe('Agent description'),
        runtime: z.string().optional().describe('Runtime: claude-code, cursor, codex, or other'),
        capabilities: z.array(z.string()).optional().describe('Agent capabilities'),
      },
      createMeshRegisterHandler(deps)
    ),
    tool(
      'mesh_list',
      'List all registered agents with optional filters.',
      {
        runtime: z.string().optional().describe('Filter by runtime'),
        capability: z.string().optional().describe('Filter by capability'),
        callerNamespace: z.string().optional().describe('Filter by namespace visibility'),
      },
      createMeshListHandler(deps)
    ),
    tool(
      'mesh_deny',
      'Deny a candidate path from future discovery scans.',
      {
        path: z.string().describe('Path to deny'),
        reason: z.string().optional().describe('Reason for denial'),
      },
      createMeshDenyHandler(deps)
    ),
    tool(
      'mesh_unregister',
      'Unregister an agent by ID, removing it from the registry.',
      {
        agentId: z.string().describe('Agent ID to unregister'),
      },
      createMeshUnregisterHandler(deps)
    ),
    tool(
      'mesh_status',
      'Get aggregate mesh health status — total agents, active/inactive/stale counts, by runtime, by project.',
      {},
      createMeshStatusHandler(deps)
    ),
    tool(
      'mesh_inspect',
      'Inspect a specific agent — manifest, health status, relay endpoint.',
      {
        agentId: z.string().describe('The agent ULID to inspect'),
      },
      createMeshInspectHandler(deps)
    ),
    tool(
      'mesh_query_topology',
      'Query the agent network topology visible to a given namespace. Returns namespaces, agents, and access rules.',
      {
        namespace: z.string().optional().describe('Caller namespace (omit for admin view)'),
      },
      createMeshQueryTopologyHandler(deps)
    ),
  ];
}
