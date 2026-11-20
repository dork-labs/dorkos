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
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import type { RequestFacts } from '../http/request-facts.js';
import {
  NEEDS_PERSON_AT_THIS_COMPUTER,
  requirePersonAtThisComputer,
} from '../lib/caller-authority.js';
import { errorBody } from '../lib/route-utils.js';
import { runFrontDoorWrite } from './front-door-step-up.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
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
import {
  finishPasskeyCheck,
  startPasskeyCheck,
} from '../services/core/auth/factors/owner-passkeys.js';
import { classifyRequest } from '../lib/request-classifier.js';
import { currentServerRole } from '../lib/server-role.js';
import { recordSignInTrustChange } from '../services/core/auth/auth-audit.js';
import {
  PASSKEY_CHECK_CODE,
  PASSKEY_NEEDED_CODE,
  type WifiSignInRequestList,
} from '@dorkos/shared/signed-in-devices';
import { isOwnOriginJsonWrite, NOT_FROM_OWN_PAGE } from '../lib/http/own-origin-write.js';

/** Refusal code for an agent, an API key or the relay. */
export const DEVICES_PEOPLE_ONLY = 'DEVICES_PEOPLE_ONLY';

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
    c.json(errorBody('Only a person can manage signed-in devices.', DEVICES_PEOPLE_ONLY), 403);
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
  if (!atThisComputer) return c.json(authRequiredBody(facts.ingress), 401);
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
      c.json(errorBody('That sign-in has already ended.', 'DEVICE_NOT_FOUND'), 404);
    if (!instance) return notFound();
    const caller = await resolveCaller(c);
    if (caller instanceof Response) return caller;
    if (!caller) return notFound();
    const sessionId = await findSignedInDevice(instance, caller.userId, c.req.param('id'));
    if (!sessionId) return notFound();
    const own = sessionId === caller.sessionId;
    if (!own && !caller.atThisComputer) {
      return c.json(
        errorBody(
          'Sign out other devices on the computer DorkOS runs on.',
          NEEDS_PERSON_AT_THIS_COMPUTER
        ),
        403
      );
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
      return c.json(errorBody('Do this in the DorkOS app.', NOT_FROM_OWN_PAGE), 403);
    }
    const caller = await resolveCaller(c);
    if (caller instanceof Response) return caller;
    // The classifier's own verdict, never a container port or an address.
    const atTheMac = classifyRequest(facts, currentServerRole()).kind === 'this-computer';
    if (!caller || !caller.atThisComputer || !atTheMac || caller.sessionId === undefined) {
      return c.json(
        errorBody('Do this on the computer DorkOS runs on.', NEEDS_PERSON_AT_THIS_COMPUTER),
        403
      );
    }
    return { userId: caller.userId, sessionId: caller.sessionId };
  };

  /**
   * A fresh passkey check for one action, done by the person at this computer
   * (DOR-4744). The first call answers `428` with the check; the second sends
   * the browser's response in `passkey`. Each check covers this one action
   * once. Never a password: with no passkey here, `409` says to add one.
   *
   * @returns `true` once checked, otherwise the answer to send.
   */
  const passkeyChecked = async (
    c: Context<ApiEnv>,
    owner: { userId: string; sessionId: string },
    action: string,
    passkey: unknown
  ): Promise<true | Response> => {
    const purpose = { kind: 'confirm', ...owner, action } as const;
    if (passkey === undefined) {
      const options = await startPasskeyCheck(purpose, String(c.req.header('origin')));
      if (options === 'no-passkey') {
        return c.json(errorBody('Add a passkey on this computer first.', PASSKEY_NEEDED_CODE), 409);
      }
      if (typeof options === 'string') {
        return c.json(errorBody('Do this in the DorkOS app.', NOT_FROM_OWN_PAGE), 403);
      }
      c.header('Cache-Control', 'no-store');
      return c.json({ code: PASSKEY_CHECK_CODE, options }, 428);
    }
    const checked = await finishPasskeyCheck(
      purpose,
      passkey as Parameters<typeof finishPasskeyCheck>[1]
    );
    if (typeof checked === 'string') {
      return c.json(
        errorBody('That passkey check didn’t work. Try again.', 'PASSKEY_REFUSED'),
        401
      );
    }
    return true;
  };

  router.put('/sessions/:id/runs-agents', async (c) => {
    const instance = auth();
    const notFound = (): Response =>
      c.json(errorBody('That sign-in has already ended.', 'DEVICE_NOT_FOUND'), 404);
    if (!instance) return notFound();
    const owner = await ownerAtTheMac(c, true);
    if (owner instanceof Response) return owner;
    const body = (readJsonBody(c) ?? null) as { on?: unknown; passkey?: unknown } | null;
    if (typeof body?.on !== 'boolean') {
      return c.json(errorBody('Say whether this device may run agents.', 'INVALID_BODY'), 400);
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
      c.json(
        errorBody('That request has ended. Ask the device to try again.', 'REQUEST_ENDED'),
        404
      );
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
      return c.json(
        errorBody(
          'Sign out everywhere on the computer DorkOS runs on.',
          NEEDS_PERSON_AT_THIS_COMPUTER
        ),
        403
      );
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
