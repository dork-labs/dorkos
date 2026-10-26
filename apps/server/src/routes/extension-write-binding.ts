/**
 * Who may write an extension's data, secrets and settings (DOR-3066, the
 * interim Security agreed).
 *
 * These routes take the extension id from the URL, and nothing tied a write to
 * the extension that made it: any page code, or with login off any local
 * program, could write another extension's blob or secrets. Two bars now:
 *
 * - **An extension speaks for itself only.** The extension API stamps every
 *   write with {@link EXTENSION_ID_HEADER}. A write carrying it must name the
 *   extension in the URL, or it is refused.
 * - **Every write needs a person or an agent.** The Settings UI and an
 *   agent that identifies itself (DOR-1801: agents may set an extension's
 *   secrets) send no stamp; an extension's own write runs in the person's page
 *   and carries their cookie. So with login on a write needs a session cookie
 *   or an agent identity, stamp or no stamp, and a bare local call with only a
 *   key is refused even if it names an extension. With login off nothing can
 *   tell the cockpit from a local program (DOR-505); turning on login closes
 *   that.
 *
 * **What this does not stop, said plainly:** extension bundles run as
 * same-origin script on the cockpit page, so a bundle that drops the header is
 * indistinguishable from the host UI. The header stops an honest extension
 * from reaching another's data by mistake, and a stray caller that names the
 * wrong extension; real separation needs isolated bundles (DOR-3293).
 *
 * @module routes/extension-write-binding
 */
import type { Context } from 'hono';
import { honoRequestFacts, type RequestFactsEnv } from '../http/request-facts.js';
import { requireOperatorCookieUnderLogin } from '../lib/caller-authority.js';

/** The header the extension API stamps on every write it makes for an extension. */
export const EXTENSION_ID_HEADER = 'x-dorkos-extension';

/** The code a refused write answers with. */
export const EXTENSION_WRITE_REFUSED = 'extension_write_refused';

/**
 * Decide whether this caller may write extension `id`'s data, secrets or
 * settings.
 *
 * @param c - The request's context.
 * @param id - The extension id from the URL.
 * @param isLoginEnabled - Optional login-state lookup for tests.
 * @returns The refusal to answer with, or `undefined` when the write may go on.
 */
export function refusedExtensionWrite(
  c: Context<RequestFactsEnv>,
  id: string,
  isLoginEnabled?: () => boolean
): Response | undefined {
  const facts = honoRequestFacts(c);
  const claimed = facts.headers[EXTENSION_ID_HEADER];
  if (claimed !== undefined && claimed !== id) {
    return c.json(
      {
        error: 'An extension can only change its own data',
        code: EXTENSION_WRITE_REFUSED,
        message: `This write came from a different extension than "${id}", so it was not saved.`,
      },
      403
    );
  }
  // A VERIFIED agent identity, not merely the header: a key holder who adds a
  // made-up `X-DorkOS-Agent` must not step around the cookie bar.
  if (facts.agentIdentity !== undefined) return undefined;
  const refusal = requireOperatorCookieUnderLogin(
    facts,
    'an extension’s data, secrets or settings',
    isLoginEnabled
  );
  if (!refusal) return undefined;
  return c.json(
    { error: refusal.error, code: EXTENSION_WRITE_REFUSED, message: refusal.error },
    refusal.status as 403
  );
}
