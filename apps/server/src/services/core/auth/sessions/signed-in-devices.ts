/**
 * A person's own sign-ins, as the devices list shows them, and signing them
 * out (F4 part 2, DOR-2969; `routes/devices.ts`).
 *
 * Everything goes through Better Auth's own adapter, so a sign-out here fires
 * the same session-delete hook every other sign-out does: it is audited, and
 * it closes what that sign-in had open (`./live-connections.ts`).
 *
 * A sign-in is named outside the server by {@link deviceIdOf}, a keyed hash of
 * its session id under a key made fresh at each start. It is stable while the
 * server runs, means nothing elsewhere, and is never the token.
 *
 * @module services/core/auth/sessions/signed-in-devices
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { SignedInDevice, SignedInDeviceRoute } from '@dorkos/shared/signed-in-devices';

import type { Auth } from '../index.js';
import { markSignedOutFromDevices, unmarkSignedOutFromDevices } from '../auth-audit.js';
import { isDesktopSignIn } from '../desktop-sign-in.js';
import { describeUserAgent, userAgentPlatform } from '../../../../lib/http/user-agent.js';
import { SESSION_ROUTES } from './session-route.js';

/** The session row fields read here. */
interface SessionRow {
  id: string;
  token: string;
  userId: string;
  expiresAt: Date | string;
  createdAt: Date | string;
  updatedAt: Date | string;
  userAgent?: string | null;
  route?: string | null;
}

/** The key device ids are derived under; new at each start. */
const DEVICE_ID_KEY = randomBytes(32);

/**
 * The opaque id the devices list names a sign-in by.
 *
 * @param sessionId - The Better Auth session id.
 */
export function deviceIdOf(sessionId: string): string {
  return createHmac('sha256', DEVICE_ID_KEY).update(sessionId).digest('base64url').slice(0, 22);
}

/**
 * What a sign-in is called in the list: "DorkOS app on Mac" for the one the
 * desktop window's own sign-in made, else its browser and platform ("Chrome
 * on Mac"), or "A web browser" when its user agent says nothing known. The
 * user agent is only ever a label, never trusted: it alone never names the
 * DorkOS app.
 *
 * @param userAgent - The stored user agent.
 * @param fromDesktopApp - Whether the desktop sign-in made this sign-in.
 */
export function deviceNameOf(userAgent: string | null | undefined, fromDesktopApp = false): string {
  const ua = userAgent ?? undefined;
  if (fromDesktopApp) {
    const platform = userAgentPlatform(ua);
    return platform ? `DorkOS app on ${platform}` : 'DorkOS app';
  }
  return describeUserAgent(ua);
}

/** How far apart Better Auth writes an account and the sign-in its sign-up makes. */
const SIGN_UP_SLACK_MS = 1000;

/**
 * Whether this is the sign-in the account's own sign-up made: no user agent,
 * and made the moment the account was. `dorkos auth enable` signed up from the
 * command line and kept that one on every install before DOR-3097, unused by
 * any device. No sign-in can be made at that moment later, so this never
 * hides one a person made.
 */
function isSignUpSignIn(row: SessionRow, accountCreatedAt: number | undefined): boolean {
  if (row.userAgent || accountCreatedAt === undefined) return false;
  return Math.abs(new Date(row.createdAt).getTime() - accountCreatedAt) < SIGN_UP_SLACK_MS;
}

/** When an account was made, in ms, or `undefined` when it is not found. */
async function accountCreatedAtOf(auth: Auth, userId: string): Promise<number | undefined> {
  const context = await auth.$context;
  const account = (await context.internalAdapter.findUserById(userId)) as {
    createdAt: Date | string;
  } | null;
  return account ? new Date(account.createdAt).getTime() : undefined;
}

/** A stored route as the list names it: none recorded means this computer. */
function routeOf(stored: string | null | undefined): SignedInDeviceRoute {
  return (SESSION_ROUTES as readonly string[]).includes(stored ?? '')
    ? (stored as SignedInDeviceRoute)
    : 'local';
}

/** A stored time as ISO 8601. */
function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

/** One person's unexpired session rows. */
async function liveRowsOf(auth: Auth, userId: string): Promise<SessionRow[]> {
  const context = await auth.$context;
  const rows = (await context.internalAdapter.listSessions(userId)) as unknown as SessionRow[];
  const now = Date.now();
  return rows.filter((row) => new Date(row.expiresAt).getTime() > now);
}

/**
 * A person's live sign-ins: the asking one first, then most recently used.
 * The sign-in the account's own sign-up made is left out (DOR-3097): no
 * device holds it. Signing out everywhere else still ends it.
 *
 * @param auth - The Better Auth instance.
 * @param userId - Whose.
 * @param currentSessionId - The asking sign-in, when the caller has one.
 */
export async function listSignedInDevices(
  auth: Auth,
  userId: string,
  currentSessionId: string | undefined
): Promise<SignedInDevice[]> {
  const rows = await liveRowsOf(auth, userId);
  const accountCreatedAt = await accountCreatedAtOf(auth, userId);
  return rows
    .filter((row) => row.id === currentSessionId || !isSignUpSignIn(row, accountCreatedAt))
    .map((row): SignedInDevice & { sort: number } => ({
      id: deviceIdOf(row.id),
      route: routeOf(row.route),
      createdAt: iso(row.createdAt),
      lastSeenAt: iso(row.updatedAt),
      current: row.id === currentSessionId,
      name: deviceNameOf(row.userAgent, isDesktopSignIn(row.token)),
      sort: new Date(row.updatedAt).getTime(),
    }))
    .sort((a, b) => Number(b.current) - Number(a.current) || b.sort - a.sort)
    .map(({ sort: _sort, ...device }) => device);
}

/**
 * The session a device id names, among one person's live sign-ins.
 *
 * @param auth - The Better Auth instance.
 * @param userId - Whose.
 * @param deviceId - The id from the list.
 * @returns Its session id, or `null` when it is none of theirs.
 */
export async function findSignedInDevice(
  auth: Auth,
  userId: string,
  deviceId: string
): Promise<string | null> {
  const rows = await liveRowsOf(auth, userId);
  return rows.find((row) => deviceIdOf(row.id) === deviceId)?.id ?? null;
}

/**
 * Sign out one of a person's sign-ins. Fires the session-delete hook, which
 * audits it and closes what it had open.
 *
 * @param auth - The Better Auth instance.
 * @param userId - Whose.
 * @param sessionId - The sign-in to end.
 * @returns Whether it was theirs and is now gone.
 */
export async function signOutSession(
  auth: Auth,
  userId: string,
  sessionId: string
): Promise<boolean> {
  const row = (await liveRowsOf(auth, userId)).find((candidate) => candidate.id === sessionId);
  if (!row) return false;
  const context = await auth.$context;
  markSignedOutFromDevices(row.id);
  try {
    await context.internalAdapter.deleteSession(row.token);
  } finally {
    // Taken by the delete's audit row; still here only when nothing was deleted.
    unmarkSignedOutFromDevices(row.id);
  }
  return true;
}

/**
 * Sign out every one of a person's sign-ins except `keepSessionId`.
 *
 * @param auth - The Better Auth instance.
 * @param userId - Whose.
 * @param keepSessionId - The sign-in to keep, when there is one.
 * @returns How many ended.
 */
export async function signOutOtherSessions(
  auth: Auth,
  userId: string,
  keepSessionId: string | undefined
): Promise<number> {
  const context = await auth.$context;
  const othersOf = async () =>
    (await liveRowsOf(auth, userId)).filter((row) => row.id !== keepSessionId);
  let ended = 0;
  // A read returns at most a page of rows (Better Auth's find limit), so read
  // again until only the kept one is left, counting only rows really gone. A
  // pass that deletes nothing stops it.
  let others = await othersOf();
  for (let page = 0; page < MAX_SIGN_OUT_PAGES && others.length > 0; page++) {
    for (const row of others) markSignedOutFromDevices(row.id);
    await context.internalAdapter.deleteSessions(others.map((row) => row.token));
    const left = await othersOf();
    for (const row of left) unmarkSignedOutFromDevices(row.id);
    const remaining = new Set(left.map((row) => row.id));
    const deleted = others.filter((row) => !remaining.has(row.id)).length;
    if (deleted === 0) break;
    ended += deleted;
    others = left;
  }
  return ended;
}

/** Most pages of sign-ins one sign-out-everywhere reads. */
const MAX_SIGN_OUT_PAGES = 50;

/**
 * Which of `ids` are sessions that still exist unexpired, for the live
 * connection sweep.
 *
 * @param auth - The Better Auth instance.
 * @param ids - Session ids that hold something open.
 */
export async function liveSessionIds(
  auth: Auth,
  ids: readonly string[]
): Promise<ReadonlySet<string>> {
  const context = await auth.$context;
  const rows = (await context.adapter.findMany({
    model: 'session',
    where: [{ field: 'id', operator: 'in', value: [...ids] }],
    limit: ids.length,
  })) as SessionRow[];
  const now = Date.now();
  return new Set(
    rows.filter((row) => new Date(row.expiresAt).getTime() > now).map((row) => row.id)
  );
}
