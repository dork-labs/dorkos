/**
 * The MCP servers a person adds once for every agent (DOR-3213), as person-only
 * capabilities the mount serves on `/api/mcp-servers` (ADR 261123-170830,
 * DOR-4978): the secret-looking-arguments check, removing a server, and its
 * sheet's tool check and Undo of a standing yes (DOR-4118).
 *
 * **Person-only, every door** (`http.audience: 'person'`), with no MCP surface:
 * no agent reads or changes the servers every agent gets, and nothing these
 * return enters an agent's context. An agent manages its OWN servers with the
 * `mcp.*` tools (`mcp-capabilities.ts`). Changing anything also takes the
 * owner at this computer (the front-door bar, read from `context.request`),
 * because a global server runs in every agent's session.
 *
 * The rest stay hand routes for now (`routes/mcp-servers.ts`): the two lists
 * until they page by cursor, and adding, replacing and widening a server
 * because they wait on "Confirm it's you" with a sheet built from the server's
 * own state, which the capability confirm-first hold can't express yet.
 *
 * Secret values never come back out: every server answer is a view that
 * carries a secret's name and nothing else.
 *
 * @module services/mesh/global-mcp/global-mcp-person-capabilities
 */
import { z } from 'zod';
import {
  GlobalMcpArgsCheckResultSchema,
  GlobalMcpArgsCheckSchema,
  GlobalMcpToolsCheckSchema,
  isReservedMcpServerName,
} from '@dorkos/shared/global-mcp-schemas';

import {
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
  type CapabilityHandlerContext,
} from '../../core/capabilities/index.js';
import { CapabilityToolError } from '../../core/capabilities/mcp-envelope.js';
import { recordAudit } from '../../audit/audit-trail.js';
import { notify } from '../../notifications/notification-service.js';
import { logger } from '../../../lib/logger.js';
import {
  removeStandingAllow,
  StandingAllowUndoError,
  UNDOABLE_RULE,
} from './global-mcp-allow-undo.js';
import { argsLookSecret } from './global-mcp-mask.js';
import {
  readServerStandingAllows,
  standingAllowBreadth,
  type StandingAllowAgent,
} from './global-mcp-standing-allows.js';
import { GlobalMcpStoreError, type GlobalMcpStore } from './global-mcp-store.js';
import {
  checkServerTools,
  type GlobalMcpToolLedger,
  type ServerToolsCheck,
} from './global-mcp-tools.js';
import {
  GLOBAL_MCP_FRONT_DOOR,
  GLOBAL_MCP_TOOL_REFUSALS,
  GLOBAL_MCP_UNDO,
  NO_SUCH_SERVER,
} from './global-mcp-refusals.js';

/** What the person's MCP server doors read. */
export interface GlobalMcpPersonDeps {
  /** The person's global MCP servers. */
  store: GlobalMcpStore;
  /** Every registered agent, with the folder the registry holds for it. */
  agents: () => readonly StandingAllowAgent[];
  /** Where a server's first-seen tools are kept. */
  ledger: GlobalMcpToolLedger;
  /**
   * Told about tools a server added since its last check, when some agent
   * allows every tool on it. The Inbox line by default.
   */
  onToolsAdded?: (server: string, added: readonly string[], agentNames: string[]) => void;
  /** The check; the real probe by default. A seam for tests. */
  check?: typeof checkServerTools;
}

declare module '../../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** The MCP servers a person adds for every agent (`/api/mcp-servers`). */
    globalMcpPersonDeps?: GlobalMcpPersonDeps;
  }
}

/** The most Inbox lines one check says; the sheet lists the rest as new. */
export const MAX_TOOL_NOTICES_PER_CHECK = 3;

/** The deps, or a fault: the domain is composed only with them. */
function depsOf(deps: CapabilityDeps): GlobalMcpPersonDeps {
  if (!deps.globalMcpPersonDeps) throw new Error('MCP servers for every agent are unavailable.');
  return deps.globalMcpPersonDeps;
}

/**
 * Refuse anyone but the owner at this computer, in the front-door bar's words.
 * The person bar itself is the mount's (`audience: 'person'`).
 */
function assertFrontDoor(context: CapabilityHandlerContext): void {
  const request = context.request;
  if (request?.frontDoorOwner) return;
  throw new CapabilityToolError({
    code: 'GLOBAL_MCP_FRONT_DOOR',
    error: request?.frontDoorElsewhere
      ? GLOBAL_MCP_FRONT_DOOR.elsewhere
      : GLOBAL_MCP_FRONT_DOOR.notTheOwner,
  });
}

/** A server name that names nothing. */
function noSuchServer(): CapabilityToolError {
  return new CapabilityToolError({ code: 'GLOBAL_MCP_NOT_FOUND', error: NO_SUCH_SERVER });
}

/** The tool code each store refusal a removal can meet answers with. */
const STORE_REFUSAL: Partial<Record<GlobalMcpStoreError['code'], string>> = {
  not_found: 'GLOBAL_MCP_NOT_FOUND',
  unreadable: 'GLOBAL_MCP_UNREADABLE',
  changed: 'GLOBAL_MCP_CHANGED',
  secret_left: 'GLOBAL_MCP_SECRET_LEFT',
};

/**
 * A store refusal as a tool refusal carrying its code's fixed sentence. The
 * store's own message can name a file it read, so it goes to the debug log
 * only, never into the error, which the audit observer records.
 */
function storeRefusal(err: unknown): never {
  const code = err instanceof GlobalMcpStoreError ? STORE_REFUSAL[err.code] : undefined;
  const refusal = code ? GLOBAL_MCP_TOOL_REFUSALS[code] : undefined;
  if (!code || !refusal) throw err;
  logger.debug('[mcp-servers] store refused', {
    code: (err as GlobalMcpStoreError).code,
    error: (err as Error).message,
  });
  throw new CapabilityToolError({ code, error: refusal.detail });
}

/** One Inbox line per added tool; the dedupe key makes each one say it once. */
function sayToolsAdded(server: string, added: readonly string[], agentNames: string[]): void {
  for (const tool of added) void notify('mcp-server.tool_added', { server, tool, agentNames });
}

/** One server's standing yeses. */
function allowsFor(mcp: GlobalMcpPersonDeps, name: string) {
  return readServerStandingAllows(mcp.store, name, mcp.agents());
}

/** The server a path names. */
const ServerName = z.string().min(1).max(200).describe('The server’s name.');
/** Why these doors are closed to agents, for the catalog. */
const PERSON_ONLY_NOTE =
  'a person’s MCP servers for every agent; agents manage their own with mcp.*';

/** `mcp.check_global_args`: whether typed arguments look like a secret. */
export const checkGlobalArgsCapability = defineCapability({
  id: 'mcp.check_global_args',
  title: 'Check whether arguments look secret',
  description:
    'Whether arguments typed for a server look like a secret, so the server holds the one rule. ' +
    'It answers yes or no, keeps nothing and logs nothing it was sent.',
  tier: 'observe',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: GlobalMcpArgsCheckSchema,
  output: GlobalMcpArgsCheckResultSchema,
  surfaces: {
    http: { method: 'post', path: '/api/mcp-servers/check-args', audience: 'person' },
  },
  invoke: async (_deps, input) => ({ looksSecret: argsLookSecret(input.args) }),
});

/** `mcp.remove_global_server`: remove a server and its stored secrets. */
export const removeGlobalServerCapability = defineCapability({
  id: 'mcp.remove_global_server',
  title: 'Remove an MCP server every agent gets',
  description:
    'Remove a server from every agent, with its stored secrets. Only the owner, at this computer.',
  tier: 'act',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: z.object({ name: ServerName }),
  // Nothing: the route answers 204 with no body.
  output: z.unknown(),
  surfaces: {
    http: { method: 'delete', path: '/api/mcp-servers/{name}', success: 204, audience: 'person' },
  },
  invoke: async (deps, { name }, context) => {
    assertFrontDoor(context);
    try {
      await depsOf(deps).store.remove(name);
    } catch (err) {
      storeRefusal(err);
    }
    logger.info('[mcp-servers] removed a server for every agent', { name });
  },
});

/** `mcp.check_global_tools`: what a server can do, checked now. */
export const checkGlobalToolsCapability = defineCapability({
  id: 'mcp.check_global_tools',
  title: 'Check an MCP server’s tools',
  description:
    'Start a server every agent gets and list its tools, naming the ones it added since its ' +
    'last check. A server that is off, or that would not reach an agent, is never started.',
  tier: 'act',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: z.object({ name: ServerName }),
  output: GlobalMcpToolsCheckSchema,
  surfaces: {
    http: { method: 'post', path: '/api/mcp-servers/{name}/tools', audience: 'person' },
  },
  invoke: async (deps, { name }) => {
    const mcp = depsOf(deps);
    if (!mcp.store.has(name)) throw noSuchServer();
    const check = mcp.check ?? checkServerTools;
    const checked: ServerToolsCheck = await check(
      mcp.store.connectionToCheck(name),
      name,
      mcp.ledger
    );
    // A name that is one of DorkOS's own never reaches an agent (DOR-3600), so
    // its check is never `ok`, and no agent is told about a tool it can't get.
    const result: ServerToolsCheck =
      checked.status === 'ok' && isReservedMcpServerName(name)
        ? { ...checked, status: 'reserved-name' }
        : checked;
    if (result.status === 'ok' && result.added.length > 0) {
      const wide = (await allowsFor(mcp, name))
        .filter((allow) => allow.breadth === 'server')
        .map((allow) => allow.agentName);
      if (wide.length > 0) {
        const said = result.added.slice(0, MAX_TOOL_NOTICES_PER_CHECK);
        (mcp.onToolsAdded ?? sayToolsAdded)(name, said, wide);
      }
    }
    return result;
  },
});

/** `mcp.undo_global_allow`: take back one agent's standing yes for a server. */
export const undoGlobalAllowCapability = defineCapability({
  id: 'mcp.undo_global_allow',
  title: 'Undo an agent’s standing yes for an MCP server',
  description:
    'Remove one standing yes for a server every agent gets from the folder the registry names ' +
    'for that agent, so it asks again. Only the owner, at this computer; recorded in the audit log.',
  tier: 'act',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: z.object({
    name: ServerName,
    agentId: z.string().min(1).max(200).describe('The agent whose standing yes this is.'),
    rule: z.string().min(1).max(400).describe('The exact rule to remove, as the list gave it.'),
  }),
  // Nothing: the route answers 204 with no body.
  output: z.unknown(),
  surfaces: {
    http: {
      method: 'delete',
      path: '/api/mcp-servers/{name}/allows',
      success: 204,
      audience: 'person',
    },
  },
  invoke: async (deps, { name, agentId, rule }, context) => {
    assertFrontDoor(context);
    const mcp = depsOf(deps);
    if (!mcp.store.has(name)) throw noSuchServer();
    const names = mcp.store.list().map((server) => server.name);
    if (!UNDOABLE_RULE.test(rule) || standingAllowBreadth(rule, name, names) === null) {
      throw new CapabilityToolError({
        code: 'GLOBAL_MCP_UNDO_REFUSED',
        error: GLOBAL_MCP_UNDO.badRequest,
      });
    }
    // The folder comes from the registry, never from the request.
    const agent = mcp.agents().find((candidate) => candidate.id === agentId);
    if (!agent) {
      throw new CapabilityToolError({
        code: 'GLOBAL_MCP_NOT_FOUND',
        error: GLOBAL_MCP_UNDO.noAgent,
      });
    }
    await undoOne(agent, rule);
    logger.info('[mcp-servers] undid a standing yes', { server: name, agentId, rule });
  },
});

/** Remove one rule from an agent's folder, and record what happened. */
async function undoOne(agent: StandingAllowAgent, rule: string): Promise<void> {
  const target = { type: 'agent', id: agent.id, name: agent.name } as const;
  let outcome: 'removed' | 'not-found';
  try {
    outcome = await removeStandingAllow(agent.home, rule);
  } catch (err) {
    if (!(err instanceof StandingAllowUndoError)) throw err;
    recordAudit({
      action: 'mcp-server.allow-undone',
      operation: 'remove',
      target,
      outcome: 'refused',
      error: err.message,
      summary: `Couldn't undo ${rule} for ${agent.name}`,
    });
    if (err.code === 'bad-rule') {
      throw new CapabilityToolError({
        code: 'GLOBAL_MCP_UNDO_REFUSED',
        error: GLOBAL_MCP_UNDO.badRule,
      });
    }
    throw new CapabilityToolError({
      code: 'GLOBAL_MCP_UNDO_CONFLICT',
      error:
        err.code === 'not-a-real-file' ? GLOBAL_MCP_UNDO.notAPlainFile : GLOBAL_MCP_UNDO.unreadable,
    });
  }
  if (outcome === 'not-found') {
    throw new CapabilityToolError({ code: 'GLOBAL_MCP_NOT_FOUND', error: GLOBAL_MCP_UNDO.noRule });
  }
  recordAudit({
    action: 'mcp-server.allow-undone',
    operation: 'remove',
    target,
    outcome: 'ok',
    change: [{ field: 'permissions.allow', before: rule, after: null }],
    reason: `${agent.home}/.claude/settings.local.json`,
    summary: `Undid ${rule} for ${agent.name}`,
  });
}

/** The roster the standing yeses are read against: what `MeshCore.listWithPaths` gives. */
interface AgentRoster {
  listWithPaths(): ReadonlyArray<{
    id: string;
    name: string;
    displayName?: string;
    projectPath: string;
  }>;
}

/**
 * The deps for these doors, from what boot built: the store and the tool
 * ledger (`startup/steps/mcp-tasks-skills.ts`), and the agent registry for who
 * holds a standing yes. Nothing when either is missing, so the doors answer
 * that they are not on this computer.
 *
 * @param built - The store and the ledger the route deps carry.
 * @param roster - The agent registry, when the mesh started.
 */
export function globalMcpPersonDepsFor(
  built: { mcpServers?: GlobalMcpStore; mcpServerTools?: GlobalMcpToolLedger },
  roster: () => AgentRoster | undefined
): Pick<CapabilityDeps, 'globalMcpPersonDeps'> {
  const { mcpServers: store, mcpServerTools: ledger } = built;
  if (!store || !ledger) return {};
  const agents = () =>
    (roster()?.listWithPaths() ?? []).map((agent) => ({
      id: agent.id,
      name: agent.displayName ?? agent.name,
      home: agent.projectPath,
    }));
  return { globalMcpPersonDeps: { store, ledger, agents } };
}

/** The person's MCP server doors; on every server that keeps MCP servers for every agent. */
export const globalMcpPersonDomain: CapabilityDomain = {
  name: 'mcp',
  assertDeps: depsOf,
  capabilities: [
    checkGlobalArgsCapability,
    removeGlobalServerCapability,
    checkGlobalToolsCapability,
    undoGlobalAllowCapability,
  ],
};
