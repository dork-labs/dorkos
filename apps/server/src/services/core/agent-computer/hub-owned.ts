/**
 * What only the hub may do to an agent computer, in one table (DOR-2940,
 * `specs/everything-is-a-space/design-agent-computers.md`).
 *
 * An agent computer runs a hub's agents. Who those agents are, what they may
 * do, what is installed and what is scheduled are the hub's to decide, so an
 * agent working there cannot change them for itself. Two lists say which:
 *
 * - {@link HUB_OWNED_ACTIONS}: capability ids and hand-registered MCP tool
 *   names. Every gate that runs an action asks
 *   {@link agentComputerActionRefusal} first: `registry.invoke` (every
 *   registry capability, trusted callers included) and `runGate` in
 *   `mcp-tool-gate.ts` (every hand-registered tool, on both MCP servers).
 *   Every `destructive` action is refused there too: it waits for a person's
 *   approval, and nobody on an agent computer can give one, so it answers at
 *   once instead of hanging.
 * - {@link HUB_OWNED_ROUTES}: path prefixes whose writes (`POST`, `PUT`,
 *   `PATCH`, `DELETE`) the session gate refuses with a `403`
 *   ({@link agentComputerRouteRefusal}), each listed with the reason it is
 *   there. Reads stay open to agents. This also covers every route that writes
 *   settings (`configManager.set`): `/api/config`, the runtime, tunnel,
 *   remote-access, Wi-Fi, heartbeat-triage, shapes, harness, profile and
 *   onboarding routes are all listed below. Settings writers no route reaches
 *   (boot-time seeding, the cloud link, which its routes cannot reach here)
 *   are not.
 *
 * Left alone on purpose: the terminal (its socket is authorized by an id a
 * gated route mints, and an agent already has a shell here) and A2A (its own
 * authorizer, `middleware/mcp-auth.ts`, decides it as it decides `/mcp`).
 *
 * @module services/core/agent-computer/hub-owned
 */
import type { CapabilityTier } from '@dorkos/shared/capabilities';
import type { TierDeniedPayload } from '../capabilities/tier-enforcement.js';
import { isAgentComputer } from '../server-role/role-checks.js';

/** The refusal code a hub-owned route answers with. */
export const HUB_OWNED_CODE = 'AGENT_COMPUTER_HUB_OWNED';

/**
 * Actions only the hub may take on an agent computer, by capability id or
 * MCP tool name, each with what it changes.
 */
export const HUB_OWNED_ACTIONS: ReadonlyMap<string, string> = new Map([
  ['create_agent', 'agents'],
  ['operator.update_agent', 'agents'],
  ['operator.update_agent_boundaries', 'agents'],
  ['operator.update_agent_execution', 'agents'],
  ['mesh_register', 'agents'],
  ['mesh_unregister', 'agents'],
  ['mesh_deny', 'agents'],
  ['tasks_create', 'schedules'],
  ['tasks_update', 'schedules'],
  ['tasks_delete', 'schedules'],
  ['create_extension', 'extensions'],
  ['reload_extensions', 'extensions'],
  ['marketplace.install', 'packages'],
  ['marketplace.update', 'packages'],
  ['marketplace.uninstall', 'packages'],
  ['marketplace.link', 'packages'],
  ['permissions.change', 'permissions'],
  ['permissions.request_access', 'permissions'],
  ['operator.config_patch', 'settings'],
  ['mcp.signin', 'sign-ins'],
  ['mcp.set_client', 'sign-ins'],
  ['connectors.request_connection', 'connections'],
  ['relay_enable_adapter', 'connections'],
  ['relay_disable_adapter', 'connections'],
  ['relay_reload_adapters', 'connections'],
  ['binding_create', 'connections'],
  ['binding_delete', 'connections'],
]);

/** One hub-owned route prefix: its writes are refused, minus any exception. */
export interface HubOwnedRoute {
  /** The path prefix, lowercased, matched on a segment boundary. */
  readonly prefix: string;
  /** What the hub owns there, for the refusal. */
  readonly what: string;
  /** Writes under the prefix that stay open to agents, as path patterns. */
  readonly except?: readonly RegExp[];
}

/** Route prefixes whose writes only the hub may make on an agent computer. */
export const HUB_OWNED_ROUTES: readonly HubOwnedRoute[] = [
  { prefix: '/api/admin', what: 'setup' },
  {
    prefix: '/api/agents',
    what: 'agents',
    // Reading an agent by path, pausing or resuming one (anyone may stop any
    // agent) and an agent's own commitments stay open.
    except: [
      /^\/api\/agents\/resolve\/?$/,
      /^\/api\/agents\/[^/]+\/(pause|resume|commitments)\/?$/,
    ],
  },
  {
    prefix: '/api/mesh',
    what: 'agents',
    except: [/^\/api\/mesh\/discover\/?$/, /^\/api\/mesh\/agents\/[^/]+\/heartbeat\/?$/],
  },
  { prefix: '/api/tasks', what: 'schedules' },
  { prefix: '/api/extensions', what: 'extensions' },
  { prefix: '/api/marketplace', what: 'packages' },
  { prefix: '/api/permissions', what: 'permissions' },
  { prefix: '/api/harness', what: 'packages' },
  { prefix: '/api/config', what: 'settings' },
  { prefix: '/api/runtimes', what: 'sign-ins' },
  { prefix: '/api/tunnel', what: 'remote access' },
  { prefix: '/api/remote-access', what: 'remote access' },
  { prefix: '/api/lan-access', what: 'remote access' },
  { prefix: '/api/session-relay', what: 'remote access' },
  { prefix: '/api/heartbeats', what: 'settings' },
  { prefix: '/api/shapes', what: 'settings' },
  { prefix: '/api/profile', what: 'settings' },
  { prefix: '/api/onboarding', what: 'settings' },
  { prefix: '/api/push', what: 'settings' },
];

/** The methods that write. */
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The sentence every hub-owned refusal carries. */
function hubOwnedMessage(what: string): string {
  return `This is an agent computer. Only its hub changes its ${what}.`;
}

/** The `403` body of a refused hub-owned route. */
export interface HubOwnedRouteRefusal {
  /** One plain sentence. */
  readonly error: string;
  /** Always {@link HUB_OWNED_CODE}. */
  readonly code: typeof HUB_OWNED_CODE;
}

/**
 * The refusal for a request to a hub-owned route on an agent computer, or
 * `null` when it may go on (another role, a read, or an exception).
 *
 * @param method - The request method.
 * @param path - The lowercased request path, without its query.
 */
export function agentComputerRouteRefusal(
  method: string,
  path: string
): HubOwnedRouteRefusal | null {
  if (!isAgentComputer() || !WRITES.has(method.toUpperCase())) return null;
  const collapsed = path.replace(/\/{2,}/g, '/');
  const owned = HUB_OWNED_ROUTES.find(
    (route) =>
      (collapsed === route.prefix || collapsed.startsWith(`${route.prefix}/`)) &&
      !route.except?.some((pattern) => pattern.test(collapsed))
  );
  return owned ? { error: hubOwnedMessage(owned.what), code: HUB_OWNED_CODE } : null;
}

/** The facts about an action {@link agentComputerActionRefusal} reads. */
export interface SealableAction {
  /** Capability id or MCP tool name. */
  readonly id: string;
  /** Human-facing title. */
  readonly title: string;
  /** Permission tier. */
  readonly tier: CapabilityTier;
}

/**
 * The refusal for an action on an agent computer, or `null` when it may go
 * on. Refused: every hub-owned action, and every `destructive` one, since
 * nobody there can approve it. Never approvable, so an agent does not ask
 * again.
 *
 * Carried as a `permission_blocked` denial, the shape every surface already
 * renders (a `403` over HTTP, an error result over MCP).
 *
 * @param action - The action about to run.
 */
export function agentComputerActionRefusal(action: SealableAction): TierDeniedPayload | null {
  if (!isAgentComputer()) return null;
  const what = HUB_OWNED_ACTIONS.get(action.id);
  if (what === undefined && action.tier !== 'destructive') return null;
  return {
    status: 'denied',
    capabilityId: action.id,
    capabilityTitle: action.title,
    tier: action.tier,
    reason: 'permission_blocked',
    approvable: false,
    message:
      what === undefined
        ? 'This is an agent computer. Nobody here can approve this, so it does not run.'
        : hubOwnedMessage(what),
  };
}
