/**
 * `/api/mcp-servers`: the MCP servers a person adds once for every agent, in
 * Connections → MCP servers (DOR-3213).
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
 * **"Confirm it's you" (DOR-3234).** Once this install has an owner, anything
 * that sets what a server runs (POST, PUT) or lets more agents run it (a PATCH
 * that turns it on or takes an agent off its exclusions) is held until the owner
 * confirms with their password. Nothing is written before that, and what the
 * sheet says comes from `routes/mcp-server-step-up.ts`. Turning a server off,
 * keeping an agent from it and removing it only take power away, so they ask for
 * nothing. A held write keeps its secrets in memory only, in its commit, for at
 * most `STEP_UP_TTL_MS`.
 *
 * @module routes/mcp-servers
 */
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  GlobalMcpArgsCheckSchema,
  GlobalMcpServerInputSchema,
  GlobalMcpServerPatchSchema,
  type GlobalMcpServerInput,
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
import { readOwnerAccount } from '../services/core/auth/index.js';
import {
  GlobalMcpStoreError,
  GlobalMcpWidensError,
  type GlobalMcpStore,
} from '../services/mesh/global-mcp/global-mcp-store.js';
import { argsLookSecret } from '../services/mesh/global-mcp/global-mcp-mask.js';
import {
  boundServerInput,
  agentLabel,
  serverNotes,
  serverReason,
  serverWarnings,
  whoGetsIt,
  type AgentNames,
  type ServerChange,
} from './mcp-server-step-up.js';
import { addMcpServerSheetRoutes, type McpServerSheetDeps } from './mcp-server-sheet.js';
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
 * can name a file it read, so it goes to the server log, never to the caller.
 */
const DETAIL_BY_STORE_CODE: Record<GlobalMcpStoreError['code'], string> = {
  not_found: 'There is no MCP server by that name.',
  name_taken: 'A server with that name already exists. Pick another.',
  reserved_name: "That name is one of DorkOS's own. Pick another.",
  oauth_unsupported: "This server needs a sign-in DorkOS can't do yet.",
  unsafe_command: "That command can't run here. Use the full path to the program.",
  unsafe_env: "One of those environment variables isn't allowed.",
  unreadable: "The saved servers couldn't be read. Nothing changed.",
  changed: 'This server changed since you looked. Reload it and try again.',
  secret_left: "The server is removed, but its saved key couldn't be deleted.",
  masked_value: "Type the secret again. A masked value can't be saved.",
};

/** A store refusal as a problem document. */
function storeProblem(err: GlobalMcpStoreError): Problem {
  const [code, status] = PROBLEM_BY_STORE_CODE[err.code];
  logger.info('[mcp-servers] store refused', { code: err.code, error: err.message });
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

/** The bar for reading the list: a person, never an agent. */
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
 * @param sheet - What the server sheet's tools and standing-yes routes need; without it they are not mounted.
 */
export function createMcpServerRoutes(
  store: GlobalMcpStore,
  agentNames: (agentId: string) => AgentNames | undefined = () => undefined,
  ownerExists: () => boolean = () => readOwnerAccount() !== null,
  sheet?: McpServerSheetDeps
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

  /**
   * Hold a POST or PUT, refusing first whatever a password could not change. A
   * PUT's `expect` is bound too, so a resend after the server moved holds afresh.
   */
  const holdInput = (
    c: Context<ApiEnv>,
    change: Extract<ServerChange, 'add' | 'change'>,
    input: GlobalMcpServerInput,
    run: () => Promise<WriteResult>,
    expect?: string
  ): Promise<Response> =>
    runOrHold(
      c,
      {
        target: input.name,
        input:
          expect === undefined
            ? boundServerInput(change, input)
            : { ...(boundServerInput(change, input) as object), expect },
        reason: serverReason(change, input),
        notes: serverNotes(input, change === 'change'),
        warnings: serverWarnings(input),
      },
      run
    );

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

  /**
   * POST /api/mcp-servers/check-args — whether typed arguments look like a secret, so the server
   * holds the one rule. It answers a yes or a no, keeps nothing and logs nothing it was sent.
   */
  router.post('/check-args', (c) => {
    const refusal = refuseRead(c);
    if (refusal) return refusal;
    const parsed = GlobalMcpArgsCheckSchema.safeParse(readJsonBody(c));
    if (!parsed.success)
      return validationProblem(c, parsed.error, { detail: 'Send the arguments to check.' });
    return c.json({ looksSecret: argsLookSecret(parsed.data.args) });
  });

  /** POST /api/mcp-servers — add a server for every agent. */
  router.post('/', async (c) => {
    const refusal = refuseWrite(c);
    if (refusal) return refusal;
    const parsed = GlobalMcpServerInputSchema.safeParse(readJsonBody(c));
    if (!parsed.success)
      return validationProblem(c, parsed.error, { detail: 'That server is not complete.' });
    const input = parsed.data;
    try {
      store.refuseAdd(input);
    } catch (err) {
      return storeRefusal(c, err);
    }
    return holdInput(c, 'add', input, async () => {
      const server = await store.add(input);
      logger.info('[mcp-servers] added a server for every agent', { name: server.name });
      return { status: 201, body: server };
    });
  });

  /** PUT /api/mcp-servers/:name — replace a server; its secrets are typed again. */
  router.put('/:name', async (c) => {
    const refusal = refuseWrite(c);
    if (refusal) return refusal;
    const parsed = GlobalMcpServerInputSchema.safeParse(readJsonBody(c));
    if (!parsed.success)
      return validationProblem(c, parsed.error, { detail: 'That server is not complete.' });
    const input = parsed.data;
    const name = c.req.param('name');
    let expect: string;
    try {
      store.refuseReplace(name, input);
      // The server as the sheet is shown: a change made while it is up, such
      // as keeping an agent from it, refuses the confirm rather than being undone.
      expect = store.fingerprint(name);
    } catch (err) {
      return storeRefusal(c, err);
    }
    return holdInput(
      c,
      'change',
      input,
      async () => {
        const server = await store.replace(name, input, { expect });
        logger.info('[mcp-servers] replaced a server for every agent', { name: server.name });
        return { status: 200, body: server };
      },
      expect
    );
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

  /** DELETE /api/mcp-servers/:name — remove a server and its stored secrets. */
  router.delete('/:name', async (c) => {
    const refusal = refuseWrite(c);
    if (refusal) return refusal;
    try {
      await store.remove(c.req.param('name'));
      logger.info('[mcp-servers] removed a server for every agent', {
        name: c.req.param('name'),
      });
      return c.body(null, 204);
    } catch (err) {
      return storeRefusal(c, err);
    }
  });

  if (sheet)
    addMcpServerSheetRoutes(router, store, { read: refuseRead, write: refuseWrite }, sheet);

  return router;
}
