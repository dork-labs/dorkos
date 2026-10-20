/**
 * `/api/devices`: a person's own signed-in devices, and signing them out (F4
 * part 2, DOR-2969; plan `2026-10-accounts-and-devices`).
 *
 * - `GET /sessions`: the signed-in person's own sign-ins, how each came in and
 *   when it was last used. Each is named by an opaque id, never its token. A
 *   person at this computer whose gate asked for no password sees the owner's.
 * - `DELETE /sessions/:id`: sign one out. Your own current one from anywhere;
 *   any other only from a person at this computer
 *   ({@link requirePersonAtThisComputer}), so a stolen Wi-Fi or tunnel sign-in
 *   cannot lock the owner out of their other devices.
 * - `POST /sign-out-all`: at this computer only. Signs out every sign-in but
 *   the one asking (all of them when the asking person has none).
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
import { Hono, type Context } from 'hono';
import type {
  SignedInDeviceList,
  SignOutEverywhereElseResult,
} from '@dorkos/shared/signed-in-devices';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import type { RequestFacts } from '../http/request-facts.js';
import {
  NEEDS_PERSON_AT_THIS_COMPUTER,
  requirePersonAtThisComputer,
} from '../lib/caller-authority.js';
import { errorBody } from '../lib/route-utils.js';
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

/** Refusal code for an agent, an API key or the relay. */
export const DEVICES_PEOPLE_ONLY = 'DEVICES_PEOPLE_ONLY';

/** Who is asking, once they are known to be a person. */
interface DevicesCaller {
  /** Whose sign-ins these are. */
  readonly userId: string;
  /** The asking sign-in, when the person has one. */
  readonly sessionId?: string;
  /** Whether they are the person at this computer. */
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
  }
  if (user && user.credential !== 'cookie') return peopleOnly();
  const withUser: RequestFacts = { ...facts, user };
  const atThisComputer = requirePersonAtThisComputer(withUser) === undefined;
  if (user) return { userId: user.userId, sessionId: user.sessionId, atThisComputer };
  if (!atThisComputer) return c.json(authRequiredBody(), 401);
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
    if (!(await signOutSession(instance, caller.userId, sessionId))) return notFound();
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
    const signedOut =
      instance && caller
        ? await signOutOtherSessions(instance, caller.userId, caller.sessionId)
        : 0;
    const body: SignOutEverywhereElseResult = { signedOut };
    return c.json(body);
  });

  return router;
}
