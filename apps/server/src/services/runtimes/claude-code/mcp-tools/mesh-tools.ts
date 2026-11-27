import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { dorkReferenceOrNull } from '@dorkos/shared/dork-ref';
import { readManifest } from '@dorkos/shared/manifest';
import { AgentRuntimeSchema } from '@dorkos/shared/mesh-schemas';
import {
  INVALID_CURSOR_DETAIL,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  pageCursorInput,
} from '@dorkos/shared/paging';
import {
  agentRosterPage,
  assertAgentRosterCursor,
} from '../../../../lib/paging/agent-roster-page.js';
import { callerReaderKey, type PageCaller } from '../../../../lib/paging/caller-reader-key.js';
import type { KeysetPage } from '../../../../lib/paging/keyset-page.js';
import {
  validateBoundary,
  validateBoundaryOrDorkHome,
  BoundaryError,
} from '../../../../lib/boundary.js';
import { logger } from '../../../../lib/logger.js';
import { createScanBrowserWarner } from '../../../browser/agent-browser-lint.js';
import { notifyAgentCreated } from '../../../core/agent-created-hook.js';
import { resolveNamedAgentIdentity } from '../../../mesh/normalize-agent-identity.js';
import { currentCreatorAccountId } from '../../../heartbeats/reports-to.js';
import type { AgentToolDeps } from '../../../core/agent-tool-kit/agent-tool-kit.js';
import { jsonContent, structuredJsonContent } from '../../../core/agent-tool-kit/agent-tool-kit.js';
import { installedFromOutside } from '../../../marketplace/installed-metadata.js';

/**
 * An agent as `mesh_list` and `mesh_inspect` return it: with its `dork:agent:` reference as `ref`,
 * the target of a `[Name](/r/<ref>)` link (DOR-5046), and with `fromPackage` set when it was
 * installed from a third-party marketplace package, so its manifest is text someone outside the
 * team wrote (DOR-3969).
 */
async function asListedAgent<T extends { id: string }>(
  mesh: NonNullable<AgentToolDeps['meshCore']>,
  agent: T
): Promise<T & { ref: string | null; fromPackage?: true }> {
  const home = mesh.getProjectPath(agent.id);
  const named = { ...agent, ref: dorkReferenceOrNull('agent', agent.id) };
  return home && (await installedFromOutside(home)) ? { ...named, fromPackage: true } : named;
}

/** Guard that returns an error response when Mesh is disabled. */
function requireMesh(deps: AgentToolDeps) {
  if (!deps.meshCore) {
    return jsonContent({ error: 'The agent directory is off', code: 'MESH_DISABLED' }, true);
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
 *
 * @param path - Caller-supplied path to validate
 * @param allowDorkHome - When true, also accept paths under DorkOS's data
 *   directory (the agent-registry seam — mirrors the HTTP mesh register route).
 *   Only `mesh_register` sets this; discovery and denial stay boundary-confined.
 */
async function resolveBoundedPath(
  path: string,
  allowDorkHome = false
): Promise<{ resolved: string } | { error: ReturnType<typeof jsonContent> }> {
  const validate = allowDorkHome ? validateBoundaryOrDorkHome : validateBoundary;
  try {
    return { resolved: await validate(path) };
  } catch (e) {
    if (e instanceof BoundaryError) {
      return { error: jsonContent({ error: e.message, code: e.code }, true) };
    }
    const message = e instanceof Error ? e.message : 'Path validation failed';
    return { error: jsonContent({ error: message, code: 'PATH_INVALID' }, true) };
  }
}

/** Discover agents by scanning directories. */
export function createMeshDiscoverHandler(deps: AgentToolDeps) {
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
      // A folder the scan finds may hold a browser server outside DorkOS's guard (DOR-3957).
      const warnBrowsers = createScanBrowserWarner(logger);
      for await (const event of deps.meshCore!.discover(validatedRoots, {
        maxDepth: args.maxDepth,
      })) {
        if (event.type === 'candidate') {
          candidates.push(event.data);
          warnBrowsers(event.data.path);
        } else if (event.type === 'auto-import') {
          warnBrowsers(event.data.path);
          if (args.includeRegistered) autoImported.push(event.data);
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

/**
 * Register an agent from a filesystem path.
 *
 * `name` is the agent's immutable address, not a label: it is what the agent's
 * `@handle` in a room is derived from (`deriveHandle(name) ?? deriveHandle(displayName)`
 * in `services/rooms/author-registry.ts`). A caller that sends a name with
 * whitespace in it gets it slugified and kept as `displayName`, because the
 * alternative is what actually happened: DorkBot registered an agent as
 * "DorkOS Cloud" and the manifest stored that string, spaces and all (DOR-2054).
 *
 * Every check and every normalisation lives in `resolveAgentIdentity`, which the
 * two HTTP register routes share — three doors, one answer. Read its header for
 * why whitespace is the whole test, and what a wider one would have moved.
 */
export function createMeshRegisterHandler(deps: AgentToolDeps) {
  return async (args: {
    path: string;
    name?: string;
    displayName?: string;
    icon?: string;
    color?: string;
    description?: string;
    runtime?: string;
    capabilities?: string[];
  }) => {
    const err = requireMesh(deps);
    if (err) return err;

    // Boundary-validate the path (external /mcp callers bypass the HTTP guard).
    // Agent-registry seam: allow dork-home so system/marketplace agents under
    // `{dorkHome}/agents/*` are registerable (mirrors the HTTP mesh register route).
    const bounded = await resolveBoundedPath(args.path, true);
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

    // Same reason the runtime is checked here rather than in the schema: the
    // refusal is written for the model that will read it. A caller that already
    // passed a valid slug sees no change — slugifying one is a no-op, so no
    // `displayName` is invented for it.
    const identity = resolveNamedAgentIdentity(
      {
        name: args.name,
        displayName: args.displayName,
        icon: args.icon,
        color: args.color,
      },
      resolvedPath.split('/').pop() || 'unnamed'
    );
    if (!identity.ok) {
      return jsonContent({ error: identity.error, code: identity.code }, true);
    }

    try {
      // Registration adopts rather than overwrites (DOR-1019), so a system
      // agent's manifest is safe from the write either way. This refuses the
      // ADOPTION: `mesh_register` would otherwise hand an agent DorkBot's
      // identity for the asking, and system agents are not re-registerable.
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
          ...identity.identity,
          runtime: runtimeResult.data,
          ...(args.description && { description: args.description }),
          ...(args.capabilities && { capabilities: args.capabilities }),
          // The calling agent (or person), recorded once on a minted manifest
          // (spec `heartbeats` §4.1). An adopted manifest keeps its own.
          createdBy: currentCreatorAccountId(),
        },
        'mcp-tool'
      );

      // The agent-created seam, for the same reason the HTTP mesh register
      // route notifies it: `registerByPath` bypasses `createAgentWorkspace`, so
      // without this an agent registered by another agent only took its #team
      // seat at the next server boot (DOR-1042). Never throws.
      await notifyAgentCreated({
        id: agent.id,
        name: agent.name,
        displayName: agent.displayName,
        path: resolvedPath,
        // Registration, not creation — same as the HTTP mesh register route.
        origin: 'registered',
      });

      return jsonContent({ agent });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Registration failed';
      return jsonContent({ error: message, code: 'REGISTER_FAILED' }, true);
    }
  };
}

/** The refusal for a cursor `mesh_list` did not give, answered as an error result. */
class RosterCursorRefused extends Error {}

/**
 * List registered agents with optional filters, a page at a time (DOR-5480):
 * newest registered first, by the same rule as `GET /api/mesh/agents`
 * (`lib/paging/agent-roster-page.ts`), the filters bound into the cursor and the
 * cursor sealed to the reader, so `{ agents, nextCursor }` reads the same on
 * both doors.
 *
 * Each entry's `id` is what `chat_send` takes as its `to`: that is how one
 * agent messages another. The manifest itself is unchanged — `namespace` stays
 * stripped, as it is on every other public mesh surface. What is added is
 * `relaySubject`: the agent's canonical `relay.agent.{namespace}.{agentId}`
 * endpoint, resolved through `meshCore.getSubject()` (the un-stripped registry
 * entry) so it is byte-identical to what `mesh_inspect` reports and to what
 * Relay registered the endpoint and its access rules under. It is only for
 * Relay and A2A integrations; an agent never needs it to message a peer.
 *
 * A `relaySubject` is omitted, never guessed, when the id resolves to nothing —
 * a row that raced with an unregister has no address, and an invented one would
 * be worse than none.
 *
 * COST: one `AgentRegistry.get` per agent on the page, on top of the list
 * query. The namespace-scoped path goes through `TopologyManager` and gets back
 * manifests with no registry entry attached, so it needs the per-id lookup
 * anyway; the read is an indexed lookup, and only the page's rows pay it.
 *
 * @param deps - Shared MCP tool dependencies.
 * @param reader - Who is asking, for the cursor's seal; the person when absent.
 */
export function createMeshListHandler(deps: AgentToolDeps, reader: () => PageCaller = () => ({})) {
  return async (args: {
    runtime?: string;
    capability?: string;
    callerNamespace?: string;
    cursor?: string;
    limit?: number;
  }) => {
    const err = requireMesh(deps);
    if (err) return err;
    const { cursor, limit = PAGE_LIMIT_DEFAULT, ...filters } = args;
    const mesh = deps.meshCore!;
    const sealedFor = callerReaderKey(reader());
    const refuse = () => new RosterCursorRefused();
    let page: KeysetPage<ReturnType<typeof mesh.list>[number]>;
    try {
      assertAgentRosterCursor(filters, cursor, refuse, sealedFor);
      const hasFilters = filters.runtime || filters.capability || filters.callerNamespace;
      const rows = mesh.list(hasFilters ? (filters as Parameters<typeof mesh.list>[0]) : undefined);
      page = agentRosterPage(rows, filters, { cursor, limit }, refuse, sealedFor);
    } catch (e) {
      if (!(e instanceof RosterCursorRefused)) throw e;
      return jsonContent({ error: INVALID_CURSOR_DETAIL, code: 'INVALID_CURSOR' }, true);
    }
    const agents = await Promise.all(
      page.items.map((agent) => {
        const relaySubject = mesh.getSubject(agent.id);
        return asListedAgent(mesh, { ...agent, ...(relaySubject ? { relaySubject } : {}) });
      })
    );
    return structuredJsonContent({ agents, nextCursor: page.nextCursor });
  };
}

/** Deny a candidate path from future discovery. */
export function createMeshDenyHandler(deps: AgentToolDeps) {
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
export function createMeshUnregisterHandler(deps: AgentToolDeps) {
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
export function createMeshStatusHandler(deps: AgentToolDeps) {
  return async () => {
    const err = requireMesh(deps);
    if (err) return err;
    const status = deps.meshCore!.getStatus();
    return structuredJsonContent(status);
  };
}

/** Inspect a specific agent — manifest, health status, and its Relay endpoint for integrations. */
export function createMeshInspectHandler(deps: AgentToolDeps) {
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
    return structuredJsonContent({
      ...result,
      agent: await asListedAgent(deps.meshCore!, result.agent),
    });
  };
}

/** Query the agent network topology visible to a given namespace. */
export function createMeshQueryTopologyHandler(deps: AgentToolDeps) {
  return async (args: { namespace?: string }) => {
    const err = requireMesh(deps);
    if (err) return err;
    const topology = deps.meshCore!.getTopology(args.namespace ?? '*');
    return structuredJsonContent(topology);
  };
}

/**
 * The mesh tool definitions: name, description, input schema, and handler.
 *
 * The single source for all of that on BOTH MCP servers. The external `/mcp`
 * server projects these through `registerFromDefinitions` rather than typing them
 * out again, which is what stopped the two surfaces describing `mesh_discover`
 * differently (DOR-499). Unguarded on purpose — see {@link getMeshTools} for the
 * in-session guard and `mcp-server.ts` for why the external server registers
 * every tool regardless of feature flags.
 *
 * @param deps - Shared MCP tool dependencies.
 * @param reader - Who is asking, for `mesh_list`'s cursor seal: fixed when this tool set is
 *   built (once per session in session, once per request on `/mcp`); the person when absent.
 */
export function meshToolDefinitions(deps: AgentToolDeps, reader?: () => PageCaller) {
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
      'Register an agent from a filesystem path, and add it to the registry. A directory that ' +
        'already has a .dork/agent.json is ADOPTED, not overwritten: that file is left untouched ' +
        'and the agent it describes is what gets registered, so the returned agent — not the name ' +
        'you passed — is authoritative, and its id may differ from anything you expected. Only a ' +
        'directory with no manifest gets a new one written, and only that case needs name and ' +
        'runtime.',
      {
        path: z.string().describe('Filesystem path to the agent directory'),
        name: z
          .string()
          .optional()
          .describe(
            'The agent address: immutable, and what its @handle in a room is derived ' +
              'from. Not a label — a name with a SPACE in it is read as one, slugified ' +
              '("DorkOS Cloud" becomes "dorkos-cloud") and kept as the displayName. A name ' +
              'with no whitespace is stored exactly as you send it. Defaults to the ' +
              'directory name.'
          ),
        displayName: z
          .string()
          .optional()
          .describe('Human-readable name shown in the app, e.g. "DorkOS Cloud"'),
        description: z.string().optional().describe('Agent description'),
        runtime: z.string().optional().describe('Runtime: claude-code, cursor, codex, or other'),
        capabilities: z.array(z.string()).optional().describe('Agent capabilities'),
        icon: z
          .string()
          .optional()
          .describe('Exactly one emoji for the agent avatar. Omit to have one picked.'),
        color: z
          .string()
          .optional()
          .describe('Hex colour for the agent avatar, e.g. "#ec4899". Omit to have one picked.'),
      },
      createMeshRegisterHandler(deps)
    ),
    tool(
      'mesh_list',
      'List registered agents with optional filters, newest registered first, a page at a ' +
        'time: pass nextCursor back as cursor until it is null, or you see only the first ' +
        'page. To message an agent, pass its id as "to" to the chat send tool. The ' +
        'relaySubject field is only for message-bus and A2A integrations.',
      {
        runtime: z.string().optional().describe('Filter by runtime'),
        capability: z.string().optional().describe('Filter by capability'),
        callerNamespace: z.string().optional().describe('Filter by namespace visibility'),
        cursor: pageCursorInput,
        limit: z
          .number()
          .int()
          .min(1)
          .max(PAGE_LIMIT_MAX)
          .optional()
          .describe(
            `How many this page holds, 1 to ${PAGE_LIMIT_MAX} (default ${PAGE_LIMIT_DEFAULT}).`
          ),
      },
      createMeshListHandler(deps, reader)
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
      'Inspect a specific agent — manifest and health status. Its id is what the chat send ' +
        'tool takes as "to"; the relay endpoint is only for message-bus and A2A integrations.',
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

/**
 * The mesh tools for the in-session server — only when meshCore is provided.
 *
 * @param deps - Shared MCP tool dependencies.
 * @param reader - Who is asking, for `mesh_list`'s cursor seal: fixed when this tool set is
 *   built (once per session in session, once per request on `/mcp`); the person when absent.
 */
export function getMeshTools(deps: AgentToolDeps, reader?: () => PageCaller) {
  if (!deps.meshCore) return [];
  return meshToolDefinitions(deps, reader);
}
