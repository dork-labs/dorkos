/**
 * The desktop window signs in by itself (F3, DOR-2966).
 *
 * Once the server is up, the shell asks it for a one-time code over the
 * process channel, never an environment variable and never HTTP, and trades
 * the code at `POST /api/desktop/sign-in` through the window's own session.
 * The server answers with the owner's session cookie, with no expiry, so the
 * window's session keeps it in memory only, and every launch signs in afresh.
 * The person at their own Mac never types a password.
 *
 * Nothing here can stop the app: when there is no owner yet, or anything
 * fails, the window opens exactly as it did before, sign-in screen and all.
 * The server side is `apps/server/src/services/core/auth/desktop-sign-in.ts`.
 *
 * @module main/sign-in/window-sign-in
 */
import { session } from 'electron';
import log from 'electron-log';

import type { ServerChild } from '../server-spawn';

/** How long the shell waits for the server to answer with a code. */
export const SIGN_IN_CODE_TIMEOUT_MS = 5_000;

/** What the shell asks the server for. */
export const MINT_SIGN_IN_CODE = 'mint-sign-in-code';

/** What the server answers with. */
export const SIGN_IN_CODE = 'sign-in-code';

/** How a sign-in went. */
export type WindowSignInOutcome = 'signed-in' | 'no-owner' | 'failed';

/** What {@link signInWindow} needs. */
export interface WindowSignInDeps {
  /** The server process, to ask for a code. */
  child: Pick<ServerChild, 'on' | 'send'>;
  /** The port the server listens on. */
  port: number;
  /** Posts through the window's session; the default session unless replaced. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/** Ask the server for a code: the code, `null` with no owner, `undefined` on no answer. */
function askForCode(child: WindowSignInDeps['child']): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve(undefined);
    }, SIGN_IN_CODE_TIMEOUT_MS);
    child.on('message', (msg) => {
      if (settled || !isSignInCode(msg)) return;
      settled = true;
      clearTimeout(timer);
      resolve(msg.code);
    });
    child.send({ type: MINT_SIGN_IN_CODE });
  });
}

/** Is this the server's answer, with a code or `null`? */
function isSignInCode(msg: unknown): msg is { type: string; code: string | null } {
  if (typeof msg !== 'object' || msg === null) return false;
  const { type, code } = msg as { type?: unknown; code?: unknown };
  return type === SIGN_IN_CODE && (typeof code === 'string' || code === null);
}

/**
 * Sign the window's session in as the owner. Never throws.
 *
 * @param deps - See {@link WindowSignInDeps}.
 */
export async function signInWindow(deps: WindowSignInDeps): Promise<WindowSignInOutcome> {
  try {
    const code = await askForCode(deps.child);
    if (code === null) return 'no-owner';
    if (code === undefined) {
      log.warn('[sign-in] The server did not answer with a sign-in code.');
      return 'failed';
    }
    const post = deps.fetch ?? ((url, init) => session.defaultSession.fetch(url, init));
    const res = await post(`http://localhost:${deps.port}/api/desktop/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (res.ok) return 'signed-in';
    log.warn(`[sign-in] The server refused the window's sign-in (${res.status}).`);
    return 'failed';
  } catch (err) {
    log.warn('[sign-in] The window could not sign in by itself.', err);
    return 'failed';
  }
}
