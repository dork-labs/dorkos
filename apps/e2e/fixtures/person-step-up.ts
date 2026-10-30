/**
 * Act as the person at this computer once an owner exists (DOR-3330).
 *
 * At this computer DorkOS asks for no password by default, but once an owner
 * account exists, every person-only change needs the owner's session beside
 * the person proof only the app's own page holds. The app gets both the same
 * way every time: the owner types their password once, it posts it to
 * `/api/person-session`, keeps the cookie that answer sets, and sends the proof
 * it answers with in `x-dorkos-person` on every API call after.
 *
 * These helpers take exactly that route, so a spec that needs an owner proves
 * the person the way the real app does and never around the server's bar.
 *
 * **An owner is server-global.** `personSessionRequired` reads "an owner
 * exists" live from the auth `user` table, so an owner one test registers turns
 * every later test on the same test-mode server (every project in the shard,
 * not only this spec) into one that must step up first. A test that registers
 * an owner therefore removes it again with {@link removeTestOwner} before it
 * ends, the same throwaway-database lever `expireReview` uses.
 *
 * @module fixtures/person-step-up
 */
import Database from 'better-sqlite3';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  PERSON_PROOF_HEADER,
  PERSON_PROOF_STORAGE_KEY,
  PERSON_SESSION_PATH,
  PersonSessionResponseSchema,
} from '@dorkos/shared/person-session';

/** The owner a spec registers on the throwaway test-mode server. */
export interface TestOwner {
  email: string;
  password: string;
  name: string;
}

/**
 * Register the owner on the test-mode server, or confirm it is already there.
 * Sign-up refuses a second owner, so a retry after a failed run that left this
 * one behind goes on to the step-up, which proves the password matches.
 *
 * @param request - Any request context; sign-up's own cookie is not used.
 * @param apiUrl - The test-mode API origin.
 * @param owner - The owner to register.
 */
export async function ensureTestOwner(
  request: APIRequestContext,
  apiUrl: string,
  owner: TestOwner
): Promise<void> {
  await request.post(`${apiUrl}/api/auth/sign-up/email`, {
    headers: { origin: apiUrl },
    data: owner,
  });
}

/**
 * The owner's one password step-up, through the real route. The session cookie
 * it sets lands in `request`'s own cookie jar.
 *
 * @param request - The context that will act as the person.
 * @param apiUrl - The test-mode API origin, which is also a trusted origin.
 * @param password - The owner's password.
 * @returns The person proof to send in `x-dorkos-person`.
 */
export async function stepUpAsPerson(
  request: APIRequestContext,
  apiUrl: string,
  password: string
): Promise<string> {
  const response = await request.post(`${apiUrl}${PERSON_SESSION_PATH}`, {
    headers: { origin: apiUrl },
    data: { password },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return PersonSessionResponseSchema.parse(await response.json()).proof;
}

/**
 * The header a request context that stepped up sends with each person-only
 * change, as the app's `fetch` does.
 *
 * @param proof - The proof {@link stepUpAsPerson} answered with.
 */
export function personHeaders(proof: string): Record<string, string> {
  return { [PERSON_PROOF_HEADER]: proof };
}

/**
 * Make a page the owner's app window: step up through the page's own browser
 * context, so the session cookie is the one the page sends, and keep the proof
 * where the app's page keeps it. Call before the page's next navigation.
 *
 * @param page - The page to act as the person.
 * @param apiUrl - The test-mode API origin.
 * @param password - The owner's password.
 */
export async function actAsPersonInPage(
  page: Page,
  apiUrl: string,
  password: string
): Promise<void> {
  const proof = await stepUpAsPerson(page.context().request, apiUrl, password);
  await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [
    PERSON_PROOF_STORAGE_KEY,
    proof,
  ] as const);
}

/**
 * Remove an owner a test registered, with its sessions, sign-in and API keys,
 * so the test-mode server is owner-less again for every test after it.
 *
 * @param apiUrl - The test-mode API origin, whose port names its data folder.
 * @param email - The owner's email.
 */
export function removeTestOwner(apiUrl: string, email: string): void {
  const port = new URL(apiUrl).port;
  const db = new Database(`/tmp/dorkos-test-mode-${port}/dork.db`);
  try {
    const owner = db.prepare('SELECT id FROM user WHERE email = ?').get(email) as
      { id: string } | undefined;
    if (!owner) return;
    db.transaction(() => {
      for (const table of ['apikey', 'session', 'account']) {
        const column = table === 'apikey' ? 'reference_id' : 'user_id';
        db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(owner.id);
      }
      db.prepare('DELETE FROM user WHERE id = ?').run(owner.id);
    })();
  } finally {
    db.close();
  }
}
