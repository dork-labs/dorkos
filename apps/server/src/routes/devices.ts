/**
 * `/api/devices`: a person's own signed-in devices, and signing them out (F4
 * part 2, DOR-2969; plan `2026-10-accounts-and-devices`).
 *
 * - `GET /sessions`: the signed-in person's own sign-ins, how each came in and
 *   when it was last used. Each is named by an opaque id, never its token. A
 *   person at this computer whose gate asked for no password sees the owner's.
 * - `DELETE /sessions/:id`: sign one out. Your own current one from anywhere;
 *   any other only from the owner at this computer or on an encrypted
 *   connection ({@link requirePersonAtThisComputer}, DOR-3172), so a Wi-Fi
 *   sign-in, which anyone on that network can copy, cannot sign the owner's
 *   other devices out. The desk itself never needs a sign-in to undo it.
 * - `POST /sign-out-all`: the same bar. Signs out every sign-in but the one
 *   asking (all of them when the asking person has none).
 *
 * Every sign-out closes what that sign-in had open, through the session-delete
 * hook (`services/core/auth/sessions/live-connections.ts`), which also writes
 * its one audit row ("A device was signed out", never a token).
 * None of it is for programs: an agent, an API key or the relay is refused
 * everywhere here, reads included. The residual is DOR-505's: while this
 * computer asks for no password, a program on it that omits the agent header
 * counts as the person here, so it could sign out other devices.
 *
 * @module routes/devices
 */
import { PERSON_PROOF_HEADER } from '@dorkos/shared/person-session';
import { personProofMatches } from '../services/core/auth/person-proof.js';
import { Hono, type Context } from 'hono';
import type {
  SignedInDeviceList,
  SignOutEverywhereElseResult,
} from '@dorkos/shared/signed-in-devices';
import type { ApiEnv } from '../http/api-chain.js';
import { problem, readJsonBody } from '@dorkos/http-kit';
import { honoRequestFacts } from '../http/request-facts.js';
import type { RequestFacts } from '../http/request-facts.js';
import { requirePersonAtThisComputer } from '../lib/caller-authority.js';
import { runFrontDoorWrite } from './front-door-step-up.js';
import { presentsAgentIdentity } from '../lib/http/agent-identity-header.js';
import { getAuth, readOwnerAccount, type Auth } from '../services/core/auth/index.js';
import { authRequiredBody, verifyRequestAuth } from '../services/core/auth/session-gate.js';
import {
  mayCarrySessionCookie,
  requestSessionRoute,
} from '../services/core/auth/sessions/session-route.js';
import {
  findSignedInDevice,
  listSignedInDevices,
  signOutOtherSessions,
  signOutSession,
} from '../services/core/auth/sessions/signed-in-devices.js';
import { setWifiAgentTurns } from '../services/core/auth/sessions/wifi-agent-turns.js';
import {
  approveWifiSignIn,
  declineWifiSignIn,
  listWifiSignInRequests,
} from '../services/core/auth/sessions/wifi-sign-in-requests.js';
import { passkeyChecked } from '../http/sign-in/passkey-check.js';
import { classifyRequest } from '../lib/request-classifier.js';
import { currentServerRole } from '../lib/server-role.js';
import { recordSignInTrustChange } from '../services/core/auth/auth-audit.js';
import type { WifiSignInRequestList } from '@dorkos/shared/signed-in-devices';
import { isOwnOriginJsonWrite } from '../lib/http/own-origin-write.js';

/** Who is asking, once they are known to be a person. */
interface DevicesCaller {
  /** Whose sign-ins these are. */
  readonly userId: string;
  /** The asking sign-in, when the person has one. */
  readonly sessionId?: string;
  /**
   * Whether they are the owner in person: at this computer, or signed in on an
   * encrypted connection ({@link requirePersonAtThisComputer}).
   */
  readonly atThisComputer: boolean;
}

/**
 * Resolve the person asking, or the response refusing them. `null` is the
 * person at this computer on an install with no owner: nobody has signed in.
 *
 * A gate that asked for no password set no `user`, so a session cookie the
 * app at this computer still carries is read here, from the server store, to
 * know which sign-in is the asking one.
 */
async function resolveCaller(c: Context<ApiEnv>): Promise<DevicesCaller | null | Response> {
  const facts = honoRequestFacts(c);
  const peopleOnly = (): Response =>
    problem(c, 'person_only', { detail: 'Only a person can manage signed-in devices.' });
  if (presentsAgentIdentity(facts) || requestSessionRoute(facts) === null) return peopleOnly();
  let user = facts.user;
  if (!user && mayCarrySessionCookie(facts.headers.cookie ?? '')) {
    user = (await verifyRequestAuth(facts, { sessionFreshness: 'server-store' })) ?? undefined;
    // Only beside the app's person proof, as at the gate (DOR-3330).
    const proved =
      user?.sessionId !== undefined &&
      (await personProofMatches(user.sessionId, facts.headers[PERSON_PROOF_HEADER]));
    if (!proved) user = undefined;
  }
  if (user && user.credential !== 'cookie') return peopleOnly();
  const withUser: RequestFacts = { ...facts, user };
  const atThisComputer = requirePersonAtThisComputer(withUser) === undefined;
  if (user) {
    c.set('user', user);
    return { userId: user.userId, sessionId: user.sessionId, atThisComputer };
  }
  if (!atThisComputer) {
    // How to sign in from here (a hub, a network code), as the session gate says it.
    const { signInWith } = authRequiredBody(facts.ingress);
    return problem(c, 'unauthenticated', {
      detail: 'Sign in to manage signed-in devices.',
      ...(signInWith ? { extensions: { signInWith } } : {}),
    });
  }
  // The person at this computer, with no sign-in of their own: the owner's.
  const owner = readOwnerAccount();
  return owner ? { userId: owner.id, atThisComputer } : null;
}

/**
 * Build the routes mounted at `/api/devices`.
 *
 * @param auth - The Better Auth instance, when there is one.
 */
export function createDevicesRoutes(auth: () => Auth | undefined = getAuth): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  router.get('/sessions', async (c) => {
    const instance = auth();
    const empty: SignedInDeviceList = { sessions: [], canSignOutOthers: false };
    if (!instance) return c.json(empty);
    const caller = await resolveCaller(c);
    if (caller instanceof Response) return caller;
    if (!caller) return c.json(empty);
    const body: SignedInDeviceList = {
      sessions: await listSignedInDevices(instance, caller.userId, caller.sessionId),
      canSignOutOthers: caller.atThisComputer,
    };
    return c.json(body);
  });

  router.delete('/sessions/:id', async (c) => {
    const instance = auth();
    const notFound = (): Response =>
      problem(c, 'not_found', { detail: 'That sign-in has already ended.' });
    if (!instance) return notFound();
    const caller = await resolveCaller(c);
    if (caller instanceof Response) return caller;
    if (!caller) return notFound();
    const sessionId = await findSignedInDevice(instance, caller.userId, c.req.param('id'));
    if (!sessionId) return notFound();
    const own = sessionId === caller.sessionId;
    if (!own && !caller.atThisComputer) {
      return problem(c, 'operator_only', {
        detail: 'Sign out other devices on the computer DorkOS runs on.',
      });
    }
    const run = async () => {
      if (!(await signOutSession(instance, caller.userId, sessionId))) return notFound();
      return c.body(null, 204);
    };
    if (own) return run();
    return runFrontDoorWrite(c, {
      kind: 'devices.sign-out-one',
      target: c.req.param('id'),
      input: { deviceId: c.req.param('id'), userId: caller.userId },
      reason: 'Sign this other device out of DorkOS.',
      subject: 'signed-in devices',
      run,
    });
  });

  /**
   * The bar for approving a Wi-Fi device or letting one run agents: the owner,
   * signed in, at this computer by the classifier's verdict (never an
   * encrypted route, never a header), from one of this server's own pages.
   */
  const ownerAtTheMac = async (
    c: Context<ApiEnv>,
    write: boolean
  ): Promise<{ userId: string; sessionId: string } | Response> => {
    const facts = honoRequestFacts(c);
    if (write && !isOwnOriginJsonWrite(facts.headers)) {
      return problem(c, 'origin_not_allowed', { detail: 'Do this in the DorkOS app.' });
    }
    const caller = await resolveCaller(c);
    if (caller instanceof Response) return caller;
    // The classifier's own verdict, never a container port or an address.
    const atTheMac = classifyRequest(facts, currentServerRole()).kind === 'this-computer';
    if (!caller || !caller.atThisComputer || !atTheMac || caller.sessionId === undefined) {
      return problem(c, 'operator_only', { detail: 'Do this on the computer DorkOS runs on.' });
    }
    return { userId: caller.userId, sessionId: caller.sessionId };
  };

  router.put('/sessions/:id/runs-agents', async (c) => {
    const instance = auth();
    const notFound = (): Response =>
      problem(c, 'not_found', { detail: 'That sign-in has already ended.' });
    if (!instance) return notFound();
    const owner = await ownerAtTheMac(c, true);
    if (owner instanceof Response) return owner;
    const body = (readJsonBody(c) ?? null) as { on?: unknown; passkey?: unknown } | null;
    if (typeof body?.on !== 'boolean') {
      return problem(c, 'invalid_request', { detail: 'Say whether this device may run agents.' });
    }
    const on = body.on;
    const deviceId = c.req.param('id');
    const sessionId = await findSignedInDevice(instance, owner.userId, deviceId);
    if (!sessionId) return notFound();
    // Turning it on needs a fresh passkey check; turning it off only takes power away.
    if (on) {
      const checked = await passkeyChecked(c, owner, `wifi-runs-agents:${deviceId}`, body.passkey);
      if (checked !== true) return checked;
    }
    if (!setWifiAgentTurns(owner.userId, sessionId, on)) return notFound();
    recordSignInTrustChange(owner.userId, on ? 'device-runs-agents-on' : 'device-runs-agents-off');
    return c.body(null, 204);
  });

  router.get('/sign-in-requests', async (c) => {
    const owner = await ownerAtTheMac(c, false);
    if (owner instanceof Response) return owner;
    return c.json({ requests: listWifiSignInRequests() } satisfies WifiSignInRequestList);
  });

  router.post('/sign-in-requests/:id/approve', async (c) => {
    const owner = await ownerAtTheMac(c, true);
    if (owner instanceof Response) return owner;
    const viewId = c.req.param('id');
    const gone = (): Response =>
      problem(c, 'not_found', { detail: 'That request has ended. Ask the device to try again.' });
    if (!listWifiSignInRequests().some((request) => request.id === viewId && !request.approved)) {
      return gone();
    }
    const body = (readJsonBody(c) ?? null) as { passkey?: unknown } | null;
    const checked = await passkeyChecked(c, owner, `wifi-sign-in-approve:${viewId}`, body?.passkey);
    if (checked !== true) return checked;
    const approved = approveWifiSignIn(viewId, owner.userId);
    if (!approved) return gone();
    recordSignInTrustChange(owner.userId, 'wifi-sign-in-approved');
    c.header('Cache-Control', 'no-store');
    return c.json(approved);
  });

  router.post('/sign-in-requests/:id/decline', async (c) => {
    const owner = await ownerAtTheMac(c, true);
    if (owner instanceof Response) return owner;
    declineWifiSignIn(c.req.param('id'));
    return c.body(null, 204);
  });

  router.post('/sign-out-all', async (c) => {
    const instance = auth();
    const caller = instance ? await resolveCaller(c) : null;
    if (caller instanceof Response) return caller;
    if (caller && !caller.atThisComputer) {
      return problem(c, 'operator_only', {
        detail: 'Sign out everywhere on the computer DorkOS runs on.',
      });
    }
    if (!instance || !caller) return c.json({ signedOut: 0 } satisfies SignOutEverywhereElseResult);
    return runFrontDoorWrite(c, {
      kind: 'devices.sign-out-others',
      target: 'other-sessions',
      input: { userId: caller.userId, keepSessionId: caller.sessionId ?? null },
      reason: 'Sign every other device out of DorkOS.',
      subject: 'signed-in devices',
      run: async () =>
        c.json({
          signedOut: await signOutOtherSessions(instance, caller.userId, caller.sessionId),
        } satisfies SignOutEverywhereElseResult),
    });
  });

  return router;
}
