/**
 * The window's sign-in, as the main process's own requests carry it (DOR-4691).
 *
 * The shell holds no credential of its own. The window signs in, by itself
 * (`window-sign-in.ts`) or with the person's password when they ask for one
 * on this computer too, and its session keeps the cookie the server set. A
 * plain `node:http` request from the main process sends none of that, so with
 * the password setting on, the session gate refused the event stream with
 * `401` on every try, and the tray and notifications went quiet.
 *
 * This reads the cookies the window's session holds for the server's origin,
 * fresh on every call, so a request always carries the current sign-in: a new
 * one after the window signs in again, none after it signs out. It sends the
 * cookie alone, never the window's person proof: the stream only reads, and a
 * request without the proof is never taken for the person at this computer.
 *
 * @module main/sign-in/server-cookies
 */
import { session } from 'electron';

import { serverDialHost, serverOrigin } from '../../shared/server-address';

/** How long a read of the cookie store may take before the request goes without one. */
export const COOKIE_READ_TIMEOUT_MS = 2_000;

/**
 * A cookie that can go in a `Cookie` header as it is. Node refuses a header
 * with a character outside Latin-1 by throwing, and a page can store any
 * value with `document.cookie`, so anything outside printable ASCII is left
 * out rather than allowed to stop the request.
 */
const HEADER_SAFE = /^[\x21-\x7e]*$/;

/**
 * The `Cookie` header the window's session would send to the server, or
 * `null` when it holds none. Never throws, and never waits longer than
 * {@link COOKIE_READ_TIMEOUT_MS}: a store that cannot be read sends nothing,
 * and the server's answer says what that means.
 *
 * @param port - The port the server listens on.
 */
export async function serverCookieHeader(port: number): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), COOKIE_READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([readCookieHeader(port), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function readCookieHeader(port: number): Promise<string | null> {
  try {
    const cookies = await session.defaultSession.cookies.get({ url: serverOrigin(port) });
    const pairs = cookies
      .filter((cookie) => HEADER_SAFE.test(cookie.name) && HEADER_SAFE.test(cookie.value))
      .map((cookie) => `${cookie.name}=${cookie.value}`);
    return pairs.length > 0 ? pairs.join('; ') : null;
  } catch {
    return null;
  }
}

/** The fields of an Electron cookie-change event this module reads. */
interface ChangedCookie {
  domain?: string;
}

/** Whether a cookie's domain is the server's host; a cookie with none could be. */
function isServerCookie(cookie: ChangedCookie): boolean {
  if (!cookie.domain) return true;
  const bare = (host: string) => host.replace(/^\./, '').replace(/^\[|\]$/g, '');
  return bare(cookie.domain) === bare(serverDialHost());
}

/**
 * Call `listener` when a cookie for the server changes in the window's
 * session: a sign-in, a sign-out, a refreshed session. Cookies for other
 * hosts are ignored, and so is the removal half of an overwrite, which
 * Electron reports just before the new value.
 *
 * @param listener - What to run.
 * @returns A function that stops listening.
 */
export function onServerCookiesChanged(listener: () => void): () => void {
  // Held so the stop function removes the listener from the store it was
  // added to, even if `defaultSession` is replaced in between (tests do).
  const { cookies } = session.defaultSession;
  const onChanged = (
    _event: unknown,
    cookie: ChangedCookie,
    cause: string,
    removed: boolean
  ): void => {
    if (removed && cause === 'overwrite') return;
    if (isServerCookie(cookie)) listener();
  };
  cookies.on('changed', onChanged);
  return () => {
    cookies.removeListener('changed', onChanged);
  };
}
