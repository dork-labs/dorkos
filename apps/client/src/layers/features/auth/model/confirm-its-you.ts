/**
 * Post the owner's password for the one step-up at this computer (DOR-3330).
 *
 * A plain fetch, not `fetchJSON`: a wrong password here must come back as an
 * answer to show, never start another step-up.
 *
 * @module features/auth/model/confirm-its-you
 */
import { PERSON_SESSION_PATH, PersonSessionResponseSchema } from '@dorkos/shared/person-session';
import { resolveApiBaseUrl, writePersonProof } from '@/layers/shared/lib';

/** How the step-up ended: confirmed, or what to tell the person. */
export type ConfirmItsYouResult =
  | { ok: true }
  | {
      ok: false;
      /** Why, as the dialog shows it. `offline`: DorkOS could not be reached. */
      reason: 'wrong-password' | 'too-many-attempts' | 'no-password' | 'offline' | 'other';
      /** The server's own words, for `other`. */
      message: string;
      /** For `too-many-attempts`: how long until it is checked again. */
      retryAfterSeconds?: number;
    };

/** `/api` is in both the base URL and the path, so it is said once. */
const STEP_UP_PATH = PERSON_SESSION_PATH.replace(/^\/api/, '');

/**
 * Send the password. On success the browser holds a session for this
 * computer, set by the server's answer, and this page keeps its person proof.
 *
 * @param password - What the person typed.
 * @param baseUrl - The `/api` base URL; the app's own by default.
 */
export async function confirmItsYou(
  password: string,
  baseUrl: string = resolveApiBaseUrl()
): Promise<ConfirmItsYouResult> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${STEP_UP_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ password }),
    });
  } catch {
    return {
      ok: false,
      reason: 'offline',
      message: 'Couldn’t reach DorkOS. Check that it’s running.',
    };
  }
  if (res.ok) {
    const answer = PersonSessionResponseSchema.safeParse(await res.json().catch(() => null));
    if (!answer.success) {
      return { ok: false, reason: 'other', message: 'That didn’t work. Try again.' };
    }
    // Kept in this page only: the cookie alone stands for nobody here.
    writePersonProof(answer.data.proof);
    return { ok: true };
  }
  const body = (await res.json().catch(() => null)) as {
    error?: unknown;
    code?: unknown;
    retryAfterSeconds?: unknown;
  } | null;
  const message = typeof body?.error === 'string' ? body.error : 'That didn’t work. Try again.';
  const known = ['wrong-password', 'too-many-attempts', 'no-password'] as const;
  const reason = known.find((code) => code === body?.code) ?? 'other';
  const retryAfterSeconds =
    typeof body?.retryAfterSeconds === 'number' ? body.retryAfterSeconds : undefined;
  return { ok: false, reason, message, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) };
}
