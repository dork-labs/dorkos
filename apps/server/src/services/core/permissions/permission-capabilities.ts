/**
 * The agent-facing half of the permission model (spec `agent-permissions` D8,
 * D9): asking past a Blocked permission, and reading one's own permissions.
 *
 * ## `permissions.request_access` (`request_permission`)
 *
 * A Blocked action is not in the agent's tool list (D15), so the agent asks for
 * it here, naming the action, the exact arguments it would call it with, and
 * why. This tool mints nothing itself: it re-invokes the named action through
 * the registry with `blockedRequest` set, and the tier gate does the rest. For a
 * Blocked action the gate mints an approval bound to that action and the hash
 * of those exact arguments (the person approves exactly what will run,
 * ADR `260725-133221`), rate-limited from the approvals store BEFORE anything is
 * minted. The approval-required refusal propagates out of this tool, so the
 * in-session hold holds THIS call; on a grant the hold re-invokes it with the
 * token, this tool forwards the token (`forwardsApproval`), the gate consumes it
 * for the named action's binding, and the action's real result comes back in the
 * same turn. On Codex and OpenCode the verdict wakes the session and the agent
 * retries this tool with the token.
 *
 * It never gives an agent more than a direct call would: an action that is not
 * Blocked is gated exactly as if it had been called directly (Allowed runs, Ask
 * raises the ordinary card), and `blockedRequest` changes nothing for it.
 *
 * ### What it can reach in this phase
 *
 * Registry capabilities, by id or MCP tool name. Hand-registered MCP tools
 * (`tasks_create`, `mesh_list`, …) carry no area yet (they are assigned one in
 * phase 3), so none of them can be Blocked and none needs asking for; a request
 * naming one is told to call it directly. Phase 3 extends this to them.
 *
 * ## `permissions.list`
 *
 * The calling agent's own resolved state per area and per action, with the layer
 * that decided it, so it can explain a refusal instead of guessing, and choose an
 * Ask action knowing a card will follow. Reading one's own permissions changes
 * nothing, so it has no area.
 *
 * @module services/core/permissions/permission-capabilities
 */
import { z } from 'zod';
import {
  PERMISSION_AREAS,
  PERMISSION_STATES,
  PermissionAreaIdSchema,
  PermissionSourceSchema,
  resolvePermission,
  type AgentPermissions,
  type PermissionAreaId,
} from '@dorkos/shared/permissions';
import { APPROVAL_REQUEST_REASON_MAX_LENGTH } from '@dorkos/shared/approval-schemas';
import type { McpServerId } from '@dorkos/shared/capabilities';

import {
  CapabilityToolError,
  defineCapability,
  permissionGateSources,
  REQUEST_PERMISSION_TOOL,
  type CapabilityDeps,
  type CapabilityDefinition,
  type CapabilityDomain,
  type CapabilityHandlerContext,
  type CapabilityRegistry,
} from '../capabilities/index.js';
import { titleForMcpTool } from '../mcp-tool-tiers.js';

/** The request tool's own capability id, which it may never be asked to run. */
export const REQUEST_ACCESS_ID = 'permissions.request_access';

/**
 * The composed registry, back-written onto the deps bag after composition
 * (`composeDorkOsCapabilityRegistry`). The request tool re-invokes an action
 * through it, so the action meets the same gate a direct call would.
 *
 * @param deps - The registry's shared dependency bag.
 */
function requireRegistry(deps: CapabilityDeps): CapabilityRegistry {
  if (!deps.registry) {
    throw new Error(`${REQUEST_ACCESS_ID} invoked before the registry was back-written.`);
  }
  return deps.registry;
}

/** A refusal the model reads, in the envelope every capability error uses. */
function refuse(code: string, message: string): never {
  throw new CapabilityToolError({ error: message, code });
}

/**
 * Find the action an agent named, by capability id or by the MCP tool name it
 * saw (with or without a runtime's `mcp__server__` prefix), among the actions
 * the CALLING surface lists (spec `agent-permissions` D8).
 *
 * On an MCP server that is the capabilities that server advertises: a request
 * is a way to ask for something the agent could otherwise call there, never a
 * door to an action no tool list offers it. The principal-bound connector
 * tools and other surface-less capabilities are reached only through their
 * own dedicated servers, so they are out of reach here even though the call
 * carries a server principal. A call over HTTP or the CLI (`dorkos call`)
 * already reaches any capability by id, so it may name any.
 *
 * @param registry - The composed registry.
 * @param named - What the agent passed as `action`.
 * @param surface - The MCP server the request arrived on, or `null` for HTTP
 *   and the CLI.
 */
export function findRequestedAction(
  registry: CapabilityRegistry,
  named: string,
  surface: McpServerId | null
): CapabilityDefinition | undefined {
  const reachable = (capability: CapabilityDefinition) =>
    surface === null || capability.surfaces.mcp?.servers.includes(surface) === true;
  const byId = registry.get(named);
  if (byId) return reachable(byId) ? byId : undefined;
  const bare = bareToolName(named);
  return registry.capabilities.find(
    (capability) => capability.surfaces.mcp?.toolName === bare && reachable(capability)
  );
}

/**
 * The surface a request arrived on. A server principal only ever arrives
 * through an MCP listener, so a principal without a named server is read as the
 * in-session one, failing toward the narrower list rather than the whole
 * registry.
 *
 * @param context - The request tool's own handler context.
 */
function callingSurface(context: CapabilityHandlerContext): McpServerId | null {
  if (context.mcpServer) return context.mcpServer;
  return context.serverPrincipal ? 'in-session' : null;
}

/**
 * A tool name without a runtime's prefix: `mcp__dorkos__create_room` is
 * `create_room`. The last segment is the tool's own name on every runtime.
 *
 * @param named - A tool name as an agent saw it.
 */
function bareToolName(named: string): string {
  return named.includes('__') ? named.slice(named.lastIndexOf('__') + 2) : named;
}

/** The request tool's input. `catchall`, never `z.record` (see the TSDoc below). */
const RequestAccessInputSchema = z.object({
  action: z
    .string()
    .min(1)
    .max(200)
    .describe('The action you want, by the tool name you were told about'),
  // `catchall`, not `z.record`: a record in an in-session tool schema empties
  // `tools/list` on claude-agent-sdk >= 0.3.257 with zod >= 4.5.3
  // (`runtimes/claude-code/mcp-tools/tool-exposure.ts`).
  arguments: z
    .object({})
    .catchall(z.unknown())
    .describe('The exact arguments you would call it with'),
  reason: z
    .string()
    .min(1)
    .max(APPROVAL_REQUEST_REASON_MAX_LENGTH)
    .describe('One or two sentences: why you need it now'),
});

/** What the permissions list reports for one area. */
const ListedAreaSchema = z.object({
  id: PermissionAreaIdSchema,
  label: z.string(),
  state: z.enum(PERMISSION_STATES),
  source: PermissionSourceSchema,
});

/** What the permissions list reports for one action. */
const ListedActionSchema = z.object({
  id: z.string(),
  toolName: z.string().optional(),
  area: PermissionAreaIdSchema,
  state: z.enum(PERMISSION_STATES),
  source: PermissionSourceSchema,
});

/** `permissions.list` output. */
const ListPermissionsOutputSchema = z.object({
  /** Whether the answer is for you, or the defaults (DorkOS could not tell who asked). */
  scope: z.enum(['agent', 'defaults']),
  areas: z.array(ListedAreaSchema),
  actions: z.array(ListedActionSchema),
  /** How to ask for something that is blocked or asks. */
  note: z.string(),
});

/**
 * Resolve what the caller may do, per area and per action, the way the gate
 * resolves each call.
 *
 * @param context - The caller, when a surface resolved one.
 */
async function listOwnPermissions(
  context: CapabilityHandlerContext
): Promise<z.infer<typeof ListPermissionsOutputSchema>> {
  const sources = permissionGateSources();
  const config = sources.readConfig();
  const identity = context.identity;
  const inactive = identity?.inactive !== undefined;
  let agent: AgentPermissions | undefined;
  if (identity && !inactive) {
    try {
      agent = await sources.readAgentPermissions(identity.agentPath);
    } catch {
      refuse(
        'PERMISSIONS_UNREADABLE',
        "DorkOS could not read this agent's permissions. Ask the person to check its settings."
      );
    }
  }
  const resolve = (
    area: PermissionAreaId,
    actionId: string,
    tier: 'act' | 'observe' | 'destructive'
  ) =>
    resolvePermission({
      area,
      actionId,
      tier,
      config,
      ...(agent ? { agent } : {}),
      ...(inactive ? { inactive: true } : {}),
    });
  const areas = PERMISSION_AREAS.filter((area) => area.kind === 'state').map((area) => {
    const id = area.id as PermissionAreaId;
    // The empty id no action entry names: the area's own answer.
    const resolved = resolve(id, '', 'act');
    return { id, label: area.label, state: resolved.state, source: resolved.source };
  });
  const actions = sources.listActions().flatMap((action) => {
    if (action.area === null) return [];
    const resolved = resolve(action.area, action.id, action.tier);
    return [
      {
        id: action.id,
        ...(action.toolName ? { toolName: action.toolName } : {}),
        area: action.area,
        state: resolved.state,
        source: resolved.source,
      },
    ];
  });
  return {
    scope: identity ? 'agent' : 'defaults',
    areas,
    actions,
    note:
      'Allowed runs. Ask runs after the person says yes on a card. Blocked is not in your tool ' +
      `list; ask for it with the tool ending in \`${REQUEST_PERMISSION_TOOL}\`, and say why.`,
  };
}

/**
 * Re-invoke the action the agent asked for, through the registry, as a
 * deliberate request past Blocked.
 *
 * @param deps - The boot dependency bag (for the registry).
 * @param input - The action, its exact arguments, and the reason.
 * @param context - The caller, with any token presented on a retry.
 */
async function requestAccess(
  deps: CapabilityDeps,
  input: z.infer<typeof RequestAccessInputSchema>,
  context: CapabilityHandlerContext
): Promise<unknown> {
  const identity = context.identity;
  // No agent to scope the request or its rate limit to (spec D11).
  if (!identity) {
    refuse(
      'UNIDENTIFIED_CALLER',
      'DorkOS does not know which agent is asking, so it cannot ask the person for you. ' +
        'Ask the person directly.'
    );
  }
  if (identity.inactive) {
    refuse(
      'IDENTITY_INACTIVE',
      "This agent's access was turned off or ran out, so it cannot ask for more. Ask the person."
    );
  }
  const registry = requireRegistry(deps);
  const target = findRequestedAction(registry, input.action, callingSurface(context));
  if (!target) {
    if (titleForMcpTool(bareToolName(input.action)) !== undefined) {
      refuse(
        'CALL_IT_DIRECTLY',
        `"${input.action}" is not something you need to ask for: it is not blocked. Call it directly.`
      );
    }
    refuse(
      'UNKNOWN_ACTION',
      `There is no action called "${input.action}". Name the tool you were told about.`
    );
  }
  if (target.id === REQUEST_ACCESS_ID) {
    refuse('UNKNOWN_ACTION', 'Name the action you want, not this tool.');
  }
  // Checked here, before the gate, so a mismatch is named rather than thrown
  // out of the gate as a bare schema error. The registry parses again on
  // invoke, which is the value the approval binds to.
  const parsed = target.input.safeParse(input.arguments);
  if (!parsed.success) {
    refuse(
      'INVALID_ARGUMENTS',
      `Those arguments do not fit "${target.title}": ${z.prettifyError(parsed.error)}`
    );
  }
  return registry.invoke(target.id, input.arguments, {
    identity,
    ...(context.agentIdentityPresented ? { agentIdentityPresented: true } : {}),
    ...(context.userId ? { userId: context.userId } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.cwd ? { cwd: context.cwd } : {}),
    ...(context.serverPrincipal ? { serverPrincipal: context.serverPrincipal } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
    ...(context.approvalToken ? { approvalToken: context.approvalToken } : {}),
    retryChannel: context.retryChannel ?? 'mcp-argument',
    blockedRequest: { reason: input.reason },
  });
}

/** The `permissions` capability domain. */
export const permissionsDomain: CapabilityDomain = {
  name: 'permissions',
  capabilities: [
    defineCapability({
      id: REQUEST_ACCESS_ID,
      title: 'Ask for permission',
      description:
        'Ask the person to let you do something that is blocked for you. Name the action by the ' +
        'tool name you were told about, pass the exact arguments you would call it with, and say ' +
        'in one or two sentences why you need it now. A card goes to the person, who can allow ' +
        'it once, allow it always, or deny it. If they allow it, the action runs with exactly ' +
        'those arguments and you get its result. Ask once and wait: while one request is ' +
        'waiting you cannot ask again in the same area, after a no you cannot ask for the same ' +
        'thing for a day, and you can ask at most five times an hour.',
      tier: 'act',
      area: null,
      areaNote: 'the way to ask past Blocked',
      forwardsApproval: true,
      approvalDisplayFields: ['action', 'reason'],
      input: RequestAccessInputSchema,
      output: z.unknown(),
      surfaces: {
        mcp: { toolName: REQUEST_PERMISSION_TOOL, servers: ['in-session', 'external'] },
      },
      invoke: requestAccess,
    }),
    defineCapability({
      id: 'permissions.list',
      title: 'List my permissions',
      description:
        'See what you are allowed to do: each area (Rooms, Tasks, and so on) and each action in it, ' +
        'as Allowed, Ask, or Blocked, with where that setting came from. Use it to explain a ' +
        'refusal, or to know that an action will ask the person first.',
      tier: 'observe',
      area: null,
      areaNote: 'an agent may read its own permissions',
      input: z.object({}),
      output: ListPermissionsOutputSchema,
      surfaces: {
        mcp: {
          toolName: 'list_my_permissions',
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: true },
        },
      },
      invoke: async (_deps, _input, context) => listOwnPermissions(context),
    }),
  ],
};
