import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { readManifest } from '@dorkos/shared/manifest';
import { AgentRuntimeSchema } from '@dorkos/shared/mesh-schemas';
import { validateBoundary, BoundaryError } from '../../../../lib/boundary.js';
import type { McpToolDeps } from './types.js';
import { jsonContent, structuredJsonContent } from './types.js';

/** Guard that returns an error response when Mesh is disabled. */
function requireMesh(deps: McpToolDeps) {
  if (!deps.meshCore) {
    return jsonContent({ error: 'Mesh is not enabled', code: 'MESH_DISABLED' }, true);
  }
  return null;
}

/**
 * Validate a caller-supplied path against the server directory boundary.
 *
 * These mesh tools are also exposed on the external `/mcp` endpoint, where the
 * HTTP mesh routes' `validateBoundary` guard would otherwise be bypassed. On
 * success returns the resolved canonical path; on violation returns the MCP
 * error response to send back to the caller.
 */
async function resolveBoundedPath(
  path: string
): Promise<{ resolved: string } | { error: ReturnType<typeof jsonContent> }> {
  try {
    return { resolved: await validateBoundary(path) };
  } catch (e) {
    if (e instanceof BoundaryError) {
      return { error: jsonContent({ error: e.message, code: e.code }, true) };
    }
    const message = e instanceof Error ? e.message : 'Path validation failed';
    return { error: jsonContent({ error: message, code: 'PATH_INVALID' }, true) };
  }
}

/** Discover agents by scanning directories. */
export function createMeshDiscoverHandler(deps: McpToolDeps) {
  return async (args: { roots: string[]; maxDepth?: number; includeRegistered?: boolean }) => {
    const err = requireMesh(deps);
    if (err) return err;

    // Boundary-validate every scan root — external /mcp callers bypass the HTTP
    // route guard otherwise.
    const validatedRoots: string[] = [];
    for (const root of args.roots) {
      const bounded = await resolveBoundedPath(root);
      if ('error' in bounded) return bounded.error;
      validatedRoots.push(bounded.resolved);
    }

    try {
      const candidates = [];
      const autoImported = [];
      for await (const event of deps.meshCore!.discover(validatedRoots, {
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

    // Boundary-validate the path (external /mcp callers bypass the HTTP guard).
    const bounded = await resolveBoundedPath(args.path);
    if ('error' in bounded) return bounded.error;
    const resolvedPath = bounded.resolved;

    // Validate runtime against the real enum — a force-cast let callers write a
    // schema-invalid manifest that readManifest then safeParses to null forever.
    const runtimeResult = AgentRuntimeSchema.safeParse(args.runtime ?? 'claude-code');
    if (!runtimeResult.success) {
      return jsonContent(
        {
          error: `Invalid runtime "${String(args.runtime)}". Valid values: ${AgentRuntimeSchema.options.join(', ')}.`,
          code: 'INVALID_RUNTIME',
        },
        true
      );
    }

    try {
      // Prevent overwriting a system agent's manifest
      const existing = await readManifest(resolvedPath);
      if (existing?.isSystem) {
        return jsonContent(
          { error: 'Cannot re-register over a system agent', code: 'SYSTEM_AGENT' },
          true
        );
      }
      const agent = await deps.meshCore!.registerByPath(
        resolvedPath,
        {
          name: args.name ?? resolvedPath.split('/').pop() ?? 'unnamed',
          runtime: runtimeResult.data,
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
    return structuredJsonContent({ agents, count: agents.length });
  };
}

/** Deny a candidate path from future discovery. */
export function createMeshDenyHandler(deps: McpToolDeps) {
  return async (args: { path: string; reason?: string }) => {
    const err = requireMesh(deps);
    if (err) return err;

    // Boundary-validate the path (external /mcp callers bypass the HTTP guard).
    const bounded = await resolveBoundedPath(args.path);
    if ('error' in bounded) return bounded.error;
    const resolvedPath = bounded.resolved;

    try {
      await deps.meshCore!.deny(resolvedPath, args.reason, 'mcp-tool');
      return jsonContent({ success: true, path: resolvedPath });
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
      if (agent.isSystem) {
        return jsonContent(
          { error: 'System agents cannot be unregistered', code: 'SYSTEM_AGENT' },
          true
        );
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
    return structuredJsonContent(status);
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
    return structuredJsonContent(result);
  };
}

/** Query the agent network topology visible to a given namespace. */
export function createMeshQueryTopologyHandler(deps: McpToolDeps) {
  return async (args: { namespace?: string }) => {
    const err = requireMesh(deps);
    if (err) return err;
    const topology = deps.meshCore!.getTopology(args.namespace ?? '*');
    return structuredJsonContent(topology);
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
