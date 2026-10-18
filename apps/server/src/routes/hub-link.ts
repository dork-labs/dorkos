/**
 * `POST /api/hub/link`: a computer redeeming the link code its owner copied
 * from this hub (spec `everything-is-a-space` step B3, DOR-2946). Protocol in
 * `@dorkos/shared/session-relay-link`.
 *
 * **It is not a signed-in caller.** The computer never signs in to the hub;
 * the code is its credential, minted only from the owner's own browser
 * sign-in (`hub-computer-links.ts`). So this one exact path is exempt from the
 * session gate, and only on a hub (`services/core/auth/session-gate.ts`).
 * Every other check the chain runs still runs first: admission and Cloud's
 * front door (`hub/hub-serving.ts`). On top of those it refuses:
 *
 * - on a person's own computer, which links nothing (404);
 * - anything a browser sent (an `Origin` or `Sec-Fetch-Site` header), since a
 *   computer's request sends neither (403);
 * - a body over {@link RELAY_LINK_MAX_BODY_BYTES} (413), or one that is not a
 *   link request (400);
 * - every request while the hub is not serving or has no signing key (503),
 *   checked before the code, so no code is spent on a link that cannot finish;
 * - past too many wrong codes lately, from anywhere (429, `link-codes.ts`);
 * - a computer id already linked under another key (409): a fresh code never
 *   takes over a computer the hub serves, and its live link stays up. The same
 *   key relinks, rotating the secret;
 * - a wrong, expired or used code, and a signature that does not verify with
 *   the key the request carries: the same 401 and sentence for each. A code
 *   is spent the moment it matches, so a bad signature costs the code too.
 *
 * Accepted, it stores the computer (its id, key, name and the hash of its
 * relay secret; never the secret) and answers with the hub's key, and the
 * owner's account when the hub is assigned to one, signed with the hub key
 * over the request it answers.
 *
 * **A cloud agent computer redeems here too** (DOR-2940), with a code the hub
 * minted for it and handed to Cloud rather than one the owner copied. It names
 * itself by its relay id, its cloud computer id behind the reserved `ac:`
 * prefix, so the request is the same signed shape and nothing new crosses the
 * wire. That id sends the redeem to the agent computers' own code book
 * (`services/core/hub-relay/agent-computer-link.ts`), which checks the code
 * is bound to that computer. Its signature is checked before the code, so a
 * bad one spends nothing, and a second redeem of one computer is a security
 * event: the computer is unlinked, a new code is minted, and the redeem is
 * refused (409).
 *
 * @module routes/hub-link
 */
import bodyParser from 'body-parser';
import { Hono, type Context } from 'hono';
import {
  AGENT_COMPUTER_RELAY_ID_PREFIX,
  RELAY_LINK_MAX_BODY_BYTES,
  RELAY_LINK_PATH,
  RelayLinkRequestSchema,
  cloudComputerIdOf,
  normalizeRelayLinkCode,
  type RelayLinkRequest,
  type RelayLinkResponse,
} from '@dorkos/shared/session-relay-link';
import type { AuditActor } from '@dorkos/shared/audit-schemas';
import type { ApiEnv } from '../http/api-chain.js';
import type { BodyRule } from '../http/request-body.js';
import { readJsonBody } from '../http/request-body.js';
import { errorBody } from '../lib/route-utils.js';
import { logger } from '../lib/logger.js';
import { currentServerRole } from '../lib/server-role.js';
import { recordAudit } from '../services/audit/audit-trail.js';
import { hubServingState } from '../services/core/hub/hub-serving.js';
import {
  LinkedComputerKeyMismatchError,
  hubLinkCodes,
  hubLinkSigner,
  linkComputer,
  liveAgentComputerLink,
  liveServingOrigin,
  redeemAgentComputerCode,
  type AgentComputerRedeemOutcome,
  type HubLinkSigner,
  type LinkCodeRedemption,
  type LinkComputerInput,
} from '../services/core/hub-relay/index.js';
import {
  relayLinkAnswerBytes,
  relayLinkCodeHash,
  verifyRelayLinkRequest,
} from '../services/core/session-relay/link-signature.js';

/** What the route reads and writes, injectable for tests. */
export interface HubLinkRouteDeps {
  /** Whether this server is a hub. */
  isHub: () => boolean;
  /** The hub's origin while it serves; `null` otherwise. */
  servingOrigin: () => string | null;
  /** The hub's key, or `null` while it cannot sign. */
  signer: () => HubLinkSigner | null;
  /** The account the hub is assigned to, when it knows it. */
  owner: () => { ownerAccountId: string; issuer: string } | null;
  /** Redeem a code. */
  consume: (code: string) => LinkCodeRedemption;
  /** Store the computer. */
  link: (input: LinkComputerInput) => Promise<unknown>;
  /** Decide a verified redeem by a cloud agent computer, spending its code. */
  redeemAgentComputer: (
    request: RelayLinkRequest,
    cloudComputerId: string
  ) => Promise<AgentComputerRedeemOutcome>;
}

const liveDeps: HubLinkRouteDeps = {
  isHub: () => currentServerRole() === 'hub',
  servingOrigin: liveServingOrigin,
  signer: hubLinkSigner,
  owner: () => {
    const state = hubServingState();
    if (state.state !== 'serving') return null;
    const { ownerAccountId, issuer } = state.assignment;
    return { ownerAccountId, issuer };
  },
  consume: (code) => hubLinkCodes.consume(code),
  link: (input) => linkComputer(input),
  redeemAgentComputer: (request, cloudComputerId) =>
    redeemAgentComputerCode(request, cloudComputerId, liveAgentComputerLink()),
};

/** The one answer for a wrong, expired or used code and a bad signature. */
const REFUSED = errorBody('That link code did not work. Make a new one.', 'LINK_REFUSED');

/**
 * The body parser for the link path alone: a small cap, since a link request
 * is a few hundred bytes and the path is open to anyone before the code.
 */
export const hubLinkBodyRule: BodyRule = {
  matches: (method, path) => method === 'POST' && path.toLowerCase() === RELAY_LINK_PATH,
  parse: bodyParser.json({ limit: RELAY_LINK_MAX_BODY_BYTES }),
  answerFailure: (error) => {
    const tooLarge = (error as { type?: unknown }).type === 'entity.too.large';
    return tooLarge
      ? { status: 413, body: errorBody('That request is too large.', 'TOO_LARGE') }
      : { status: 400, body: errorBody('That request is not valid.', 'INVALID') };
  },
};

/** Whether a header a browser sends on every such request is present. */
function fromBrowser(c: Context<ApiEnv>): boolean {
  return c.req.header('origin') !== undefined || c.req.header('sec-fetch-site') !== undefined;
}

/** Record a link, or a link refused after its code matched. */
function auditLink(
  mintedBy: AuditActor | undefined,
  computer: { computerId: string; computerName: string },
  outcome: 'ok' | 'refused' | 'failed',
  error?: string
): void {
  recordAudit({
    action: 'hub.relay.computer.link',
    operation: 'create',
    outcome,
    ...(error ? { error } : {}),
    target: { type: 'computer', id: computer.computerId, name: computer.computerName },
    summary: outcome === 'ok' ? 'Linked a computer' : 'A computer could not be linked',
    ...(mintedBy
      ? {
          actor: mintedBy,
          visibility: 'participants' as const,
          participants: [mintedBy.accountId],
        }
      : {}),
    source: { surface: 'relay' },
  });
}

/** The answer to a request, signed with the hub's key, or `null` when it cannot sign. */
function signedAnswer(
  deps: HubLinkRouteDeps,
  signer: HubLinkSigner,
  request: RelayLinkRequest,
  origin: string,
  codeHash: string
): RelayLinkResponse | null {
  const owner = deps.owner();
  const answer: Omit<RelayLinkResponse, 'signature'> = {
    v: 1,
    hubKey: signer.publicKey,
    ...(owner ?? {}),
  };
  try {
    const bytes = signer.sign(relayLinkAnswerBytes(request, origin, codeHash, answer));
    return { ...answer, signature: Buffer.from(bytes).toString('base64url') };
  } catch (error) {
    logger.warn('[HubRelay] The hub could not sign a link answer', {
      error: (error as Error).name,
    });
    return null;
  }
}

const NOT_READY = errorBody("This hub can't link computers yet.", 'HUB_NOT_READY');

/**
 * Answer a cloud agent computer's redeem: signature first (nothing spent on a
 * bad one), the answer signed before anything is stored, then the code.
 */
async function redeemForAgentComputer(
  c: Context<ApiEnv>,
  deps: HubLinkRouteDeps,
  request: RelayLinkRequest,
  origin: string,
  signer: HubLinkSigner
) {
  const cloudComputerId = cloudComputerIdOf(request.computerId);
  if (cloudComputerId === null) {
    return c.json(errorBody('That request is not valid.', 'INVALID'), 400);
  }
  const code = normalizeRelayLinkCode(request.code);
  const codeHash = relayLinkCodeHash(code ?? '');
  if (code === null || !verifyRelayLinkRequest(request, origin, codeHash)) {
    logger.warn('[HubRelay] Refused an agent computer link request with a bad signature');
    return c.json(REFUSED, 401);
  }
  const answer = signedAnswer(deps, signer, request, origin, codeHash);
  if (!answer) return c.json(NOT_READY, 503);
  let outcome: AgentComputerRedeemOutcome;
  try {
    outcome = await deps.redeemAgentComputer(request, cloudComputerId);
  } catch (error) {
    // Never a bare 500: the book or the store failed under it.
    logger.warn('[HubRelay] An agent computer`s redeem could not be decided', {
      error: (error as Error).name,
    });
    auditLink(undefined, request, 'failed', 'redeem_failed');
    return c.json(NOT_READY, 503);
  }
  switch (outcome.kind) {
    case 'linked':
      auditLink(undefined, request, 'ok');
      c.header('Cache-Control', 'no-store');
      return c.json(answer satisfies RelayLinkResponse);
    case 'throttled':
      return c.json(errorBody('Too many tries. Wait a few minutes.', 'TOO_MANY_ATTEMPTS'), 429);
    case 'invalid':
      logger.warn('[HubRelay] Refused an agent computer link request with a wrong or used code');
      return c.json(REFUSED, 401);
    case 'reset':
      auditLink(undefined, request, 'refused', 'second_redeem');
      return c.json(
        errorBody('That code was used twice. A new one is on its way.', 'LINK_RESET'),
        409
      );
    case 'limit':
      auditLink(undefined, request, 'refused', 'store_refused');
      return c.json(errorBody("This hub can't link another computer.", 'LINK_LIMIT'), 409);
  }
}

/**
 * The `/api/hub/link` route.
 *
 * @param deps - Override for tests; defaults to the live hub.
 */
export function createHubLinkRoutes(deps: HubLinkRouteDeps = liveDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.post('/', async (c) => {
    if (!deps.isHub()) return c.json(errorBody('Not found', 'API_NOT_FOUND'), 404);
    if (fromBrowser(c)) {
      return c.json(errorBody('Link from the DorkOS app on your computer.', 'FORBIDDEN'), 403);
    }
    const parsed = RelayLinkRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return c.json(errorBody('That request is not valid.', 'INVALID'), 400);
    }
    const request = parsed.data;
    // Before the code: a link that cannot be answered must not spend one.
    const origin = deps.servingOrigin();
    const signer = origin ? deps.signer() : null;
    if (!origin || !signer) return c.json(NOT_READY, 503);
    if (request.computerId.startsWith(AGENT_COMPUTER_RELAY_ID_PREFIX)) {
      return redeemForAgentComputer(c, deps, request, origin, signer);
    }
    const code = normalizeRelayLinkCode(request.code);
    const redeemed = deps.consume(request.code);
    if (!redeemed.ok) {
      if (redeemed.reason === 'throttled') {
        return c.json(errorBody('Too many tries. Wait a few minutes.', 'TOO_MANY_ATTEMPTS'), 429);
      }
      logger.warn('[HubRelay] Refused a link request with a wrong or used code');
      return c.json(REFUSED, 401);
    }
    const codeHash = relayLinkCodeHash(code ?? '');
    if (!verifyRelayLinkRequest(request, origin, codeHash)) {
      auditLink(redeemed.mintedBy, request, 'refused', 'bad_signature');
      return c.json(REFUSED, 401);
    }
    // Signed before the computer is stored, so a hub that stopped serving in
    // between stores nothing it cannot vouch for.
    const answer = signedAnswer(deps, signer, request, origin, codeHash);
    if (!answer) {
      auditLink(redeemed.mintedBy, request, 'failed', 'hub_cannot_sign');
      return c.json(NOT_READY, 503);
    }
    try {
      await deps.link({
        computerId: request.computerId,
        secretHash: request.secretHash,
        computerKey: request.computerKey,
        computerName: request.computerName,
      });
    } catch (error) {
      logger.warn('[HubRelay] A computer could not be linked', { error: (error as Error).name });
      if (error instanceof LinkedComputerKeyMismatchError) {
        // The code is spent; the computer already linked keeps its link.
        auditLink(redeemed.mintedBy, request, 'refused', 'already_linked');
        return c.json(
          errorBody('That computer is already linked. Remove it first.', 'ALREADY_LINKED'),
          409
        );
      }
      auditLink(redeemed.mintedBy, request, 'refused', 'store_refused');
      return c.json(errorBody("This hub can't link another computer.", 'LINK_LIMIT'), 409);
    }
    auditLink(redeemed.mintedBy, request, 'ok');
    c.header('Cache-Control', 'no-store');
    return c.json(answer satisfies RelayLinkResponse);
  });

  return router;
}
