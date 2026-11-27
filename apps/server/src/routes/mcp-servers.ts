/**
 * `/api/mcp-servers`: listing and widening the MCP servers a person adds once
 * for every agent, in Connections → MCP servers (DOR-3213).
 *
 * The arguments check, adding, replacing and removing a server, its tool check
 * and an Undo of a standing yes are person-only capabilities the mount serves
 * (`services/mesh/global-mcp/global-mcp-person-capabilities.ts`, DOR-4978);
 * adding and replacing are confirm-first behind the front-door bar. The two
 * lists here stay hand routes until they page by cursor; widening because its
 * store decides inside its write queue whether a change widens, so its hold is
 * raised mid-write.
 *
 * **Person-only, every route.** These are not capabilities, so no agent tool,
 * capability call or approval token reaches them. Reading takes a person
 * ({@link clearsTheAgentBar}); changing takes the owner at this computer
 * ({@link refuseFrontDoorChange}), the bar for every setting that decides what
 * code DorkOS runs and which credentials it holds, because a global server
 * runs in every agent's session.
 *
 * Secret env and header values go in here, typed by the person, and never come
 * back out: every answer is a {@link GlobalMcpServerView}, which carries a
 * secret's name and nothing else.
 *
 * **"Confirm it's you" (DOR-3234).** Once this install has an owner, a PATCH
 * that lets more agents run a server (turns it on or takes an agent off its
 * exclusions) is held until the owner confirms with their password. Nothing is
 * written before that, and what the sheet says comes from
 * `services/mesh/global-mcp/global-mcp-sheet.ts`. Turning a server off and
 * keeping an agent from it only take power away, so they ask for nothing.
 * A held write keeps its secrets in memory only, in its commit, for at most
 * `STEP_UP_TTL_MS`.
 *
 * @module routes/mcp-servers
 */
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  GlobalMcpServerPatchSchema,
  type GlobalMcpServerPatch,
} from '@dorkos/shared/global-mcp-schemas';
import type { ApiEnv } from '../http/api-chain.js';
import {
  problem,
  problemBody,
  readJsonBody,
  sendProblem,
  validationProblem,
  type ProblemStatus,
} from '@dorkos/http-kit';
import type { Problem, ProblemCode } from '@dorkos/shared/problem';
import { honoRequestFacts } from '../http/request-facts.js';
import { clearsTheAgentBar, refuseFrontDoorChange } from '../lib/caller-authority.js';
import { logger } from '../lib/logger.js';
import {
  readServerStandingAllows,
  type StandingAllowAgent,
} from '../services/mesh/global-mcp/global-mcp-standing-allows.js';
import { readOwnerAccount } from '../services/core/auth/index.js';
import {
  GlobalMcpStoreError,
  GlobalMcpWidensError,
  type GlobalMcpStore,
} from '../services/mesh/global-mcp/global-mcp-store.js';
import {
  boundServerInput,
  agentLabel,
  serverNotes,
  serverReason,
  serverWarnings,
  whoGetsIt,
  type AgentNames,
  type ServerChange,
} from '../services/mesh/global-mcp/global-mcp-sheet.js';
import {
  GLOBAL_MCP_STORE,
  NO_SUCH_SERVER,
} from '../services/mesh/global-mcp/global-mcp-refusals.js';
import { noOwnerRefusal } from './relay-adapter-http.js';
import { holdForStepUp } from './step-up-guard.js';

/**
 * How each store refusal answers: its problem code and status. A server that
 * changed since it was read is `precondition_failed`, and a removal that left
 * a saved key behind is `secret_left`, which the app tells apart.
 */
const PROBLEM_BY_STORE_CODE = {
  not_found: ['not_found', 404],
  name_taken: ['conflict', 409],
  reserved_name: ['conflict', 409],
  oauth_unsupported: ['invalid_request', 422],
  unsafe_command: ['invalid_request', 422],
  unsafe_env: ['invalid_request', 422],
  unreadable: ['temporarily_unavailable', 503],
  changed: ['precondition_failed', 412],
  secret_left: ['secret_left', 500],
  masked_value: ['invalid_request', 422],
} as const satisfies Record<GlobalMcpStoreError['code'], readonly [ProblemCode, ProblemStatus]>;

/**
 * The fixed sentence each store refusal answers with. The store's own message
 * can name a command, a folder or a setting, so only its code is logged.
 */
const DETAIL_BY_STORE_CODE: Record<GlobalMcpStoreError['code'], string> = {
  not_found: NO_SUCH_SERVER,
  name_taken: GLOBAL_MCP_STORE.nameTaken,
  reserved_name: GLOBAL_MCP_STORE.reservedName,
  oauth_unsupported: GLOBAL_MCP_STORE.oauthUnsupported,
  unsafe_command: GLOBAL_MCP_STORE.unsafeCommand,
  unsafe_env: GLOBAL_MCP_STORE.unsafeEnv,
  unreadable: GLOBAL_MCP_STORE.unreadable,
  changed: GLOBAL_MCP_STORE.changed,
  secret_left: GLOBAL_MCP_STORE.secretLeft,
  masked_value: GLOBAL_MCP_STORE.maskedValue,
};

/** A store refusal as a problem document. */
function storeProblem(err: GlobalMcpStoreError): Problem {
  const [code, status] = PROBLEM_BY_STORE_CODE[err.code];
  logger.info('[mcp-servers] store refused', { code: err.code });
  return problemBody(code, { detail: DETAIL_BY_STORE_CODE[err.code], status });
}

/** What the change bar names, in its refusal. */
const WRITE_SUBJECT = 'MCP servers for every agent';

/** What a write answered: its own status and body, held or not. */
interface WriteResult {
  status: number;
  body: unknown;
}

/** What a held write shows and binds. */
interface HeldWrite {
  target: string;
  input: unknown;
  reason: string;
  notes: readonly string[];
  warnings: readonly string[];
}

/** The bar for reading the lists: a person, never an agent. */
function refuseRead(c: Context<ApiEnv>): Response | undefined {
  if (clearsTheAgentBar(honoRequestFacts(c))) return undefined;
  return problem(c, 'person_only', { detail: 'Only a person can see these servers, in the app.' });
}

/** The bar for changing it: the owner, at this computer. */
function refuseWrite(c: Context<ApiEnv>): Response | undefined {
  const refusal = refuseFrontDoorChange(honoRequestFacts(c), WRITE_SUBJECT);
  return refusal ? problem(c, 'operator_only', { detail: refusal.error }) : undefined;
}

/** A store refusal as an answer; anything else is rethrown. */
function storeRefusal(c: Context<ApiEnv>, err: unknown): Response {
  if (err instanceof GlobalMcpStoreError) {
    return sendProblem(c, storeProblem(err));
  }
  throw err;
}

/** A write's answer: a store refusal as its status and body; anything else is rethrown. */
async function writeResult(run: () => Promise<WriteResult>): Promise<WriteResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof GlobalMcpStoreError) {
      const body = storeProblem(err);
      return { status: body.status, body };
    }
    throw err;
  }
}

/**
 * Build the routes mounted at `/api/mcp-servers`.
 *
 * @param store - The person's global MCP servers.
 * @param agentNames - What an agent is called, for the sheet; nothing by default.
 * @param ownerExists - Whether this install has an owner yet; the owner account by default.
 * @param agents - Every registered agent with its folder, for who holds a standing yes; none by default.
 */
export function createMcpServerRoutes(
  store: GlobalMcpStore,
  agentNames: (agentId: string) => AgentNames | undefined = () => undefined,
  ownerExists: () => boolean = () => readOwnerAccount() !== null,
  agents: () => readonly StandingAllowAgent[] = () => []
): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  /**
   * Run a write, or hold it for "Confirm it's you". With no owner yet there is
   * no password to ask for, so the person at this computer goes on with no sheet.
   */
  const runOrHold = async (
    c: Context<ApiEnv>,
    held: HeldWrite,
    run: () => Promise<WriteResult>
  ): Promise<Response> => {
    if (!ownerExists()) {
      const refused = noOwnerRefusal(c, 'Only a person can change these servers, in the app.');
      if (refused) return refused;
      const { status, body } = await writeResult(run);
      if (status >= 400) return sendProblem(c, body as Problem);
      return c.json(body as object, status as ContentfulStatusCode);
    }
    return holdForStepUp(c, {
      kind: 'mcp-server.allow-global',
      ...held,
      // Re-checked on the request that confirmed it: still the owner, still allowed here.
      commit: async (confirming) => {
        const stale = refuseFrontDoorChange(confirming, WRITE_SUBJECT);
        if (stale)
          return { status: 403, body: problemBody('operator_only', { detail: stale.error }) };
        return writeResult(run);
      },
    });
  };

  /** Hold a PATCH that lets more agents run a server, as it stands right now. */
  const holdWidening = (
    c: Context<ApiEnv>,
    name: string,
    patch: GlobalMcpServerPatch
  ): Promise<Response> => {
    const before = store.shapeOf(name);
    const after = {
      ...before,
      enabled: patch.enabled ?? before.enabled,
      excludedAgents: patch.excludedAgents ?? before.excludedAgents,
    };
    const expect = store.fingerprint(name);
    const added = before.excludedAgents
      .filter((agentId) => !after.excludedAgents.includes(agentId))
      .map((agentId) => {
        const names = agentNames(agentId);
        return names && agentLabel(names);
      });
    const change: ServerChange = before.enabled ? 'let-more' : 'turn-on';
    return runOrHold(
      c,
      {
        target: name,
        input: { ...(boundServerInput(change, after) as object), expect },
        reason: serverReason(change, after, added),
        notes: [...serverNotes(after), whoGetsIt(after, change === 'turn-on' ? [] : added)],
        warnings: serverWarnings(after),
      },
      async () => ({ status: 200, body: await store.patch(name, patch, { expect }) })
    );
  };

  /** GET /api/mcp-servers — every server, secrets by name only. */
  router.get('/', (c) => refuseRead(c) ?? c.json({ servers: store.list() }));

  /** GET /api/mcp-servers/:name/allows — who may use it without asking. */
  router.get('/:name/allows', async (c) => {
    const refusal = refuseRead(c);
    if (refusal) return refusal;
    const name = c.req.param('name');
    if (!store.has(name)) {
      return problem(c, 'not_found', { detail: NO_SUCH_SERVER });
    }
    return c.json({ allows: await readServerStandingAllows(store, name, agents()) });
  });

  /** PATCH /api/mcp-servers/:name — `{ enabled?, excludedAgents? }`. */
  router.patch('/:name', async (c) => {
    const refusal = refuseWrite(c);
    if (refusal) return refusal;
    const parsed = GlobalMcpServerPatchSchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return validationProblem(c, parsed.error, { detail: 'Send enabled or excludedAgents.' });
    }
    const name = c.req.param('name');
    try {
      // Decided in the store's write queue, so no other write can change the answer.
      return c.json(await store.patch(name, parsed.data, { narrowOnly: ownerExists() }));
    } catch (err) {
      if (err instanceof GlobalMcpWidensError) return holdWidening(c, name, parsed.data);
      return storeRefusal(c, err);
    }
  });

  return router;
}
