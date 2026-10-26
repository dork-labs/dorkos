/**
 * Post the owner's password for the one step-up at this computer (DOR-3330).
 *
 * A plain fetch, not `fetchJSON`: a wrong password here must come back as an
 * answer to show, never start another step-up.
 *
 * @module features/auth/model/confirm-its-you
 */
import { PERSON_SESSION_PATH } from '@dorkos/shared/person-session';
import { resolveApiBaseUrl } from '@/layers/shared/lib';

/** How the step-up ended: confirmed, or what to tell the person. */
export type ConfirmItsYouResult = { ok: true } | { ok: false; message: string };

/** `/api` is in both the base URL and the path, so it is said once. */
const STEP_UP_PATH = PERSON_SESSION_PATH.replace(/^\/api/, '');

/**
 * Send the password. On success the browser now holds a session for this
 * computer, set by the server's answer.
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
    return { ok: false, message: 'Couldn’t reach DorkOS. Check that it’s running.' };
  }
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const message = typeof body?.error === 'string' ? body.error : 'That didn’t work. Try again.';
  return { ok: false, message };
}
