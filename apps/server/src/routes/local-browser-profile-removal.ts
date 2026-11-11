/** Person-only, profile-wide removal. No site or disk path is accepted. */
import type { Hono, Context } from 'hono';
import { z } from 'zod';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readJsonBody } from '../http/request-body.js';
import { requirePersonAtThisComputer } from '../lib/caller-authority.js';
import { recordAudit } from '../services/audit/audit-trail.js';
import type { LocalBrowserService } from '../services/session/local-browser/service.js';
import type { LocalBrowserProfileRouteDeps } from './local-browser-profiles.js';

/** Mounted inside the owner-on-this-computer router. Each effect requires a person too. */
export function mountLocalBrowserProfileRemoval(
  router: Hono<ApiEnv>,
  service: LocalBrowserService,
  deps?: LocalBrowserProfileRouteDeps
): void {
  const person = (c: Context<ApiEnv>) =>
    requirePersonAtThisComputer(honoRequestFacts(c)) === undefined;
  const refused = (c: Context<ApiEnv>) =>
    c.json({ error: 'Only you can do this, from DorkOS.', code: 'person_only' }, 403);
  const missing = (c: Context<ApiEnv>) =>
    c.json({ error: 'That browser profile no longer exists.', code: 'profile_not_found' }, 404);
  const audit = (id: string, deleted: boolean) =>
    recordAudit({
      action: deleted ? 'local_browser.profile.delete' : 'local_browser.sign_ins.forget',
      operation: 'remove',
      summary: deleted ? 'Deleted Agent browser profile' : 'Forgot Agent browser sign-ins',
      outcome: 'ok',
      source: { surface: 'app' },
      target: { type: 'browser-profile', id },
    });
  router.post('/profiles/:id/forget-sign-ins', async (c) => {
    if (!person(c)) return refused(c);
    z.object({}).strict().default({}).parse(readJsonBody(c));
    const id = z.union([z.literal('default'), z.string().uuid()]).parse(c.req.param('id'));
    if (id !== 'default' && !deps?.profiles.get(id)) return missing(c);
    // The panel's one Saved sign-ins row says every site is signed out, so the default's
    // Forget clears every named profile too, including ones the panel no longer lists.
    if (id === 'default')
      await service.profileRemoval.forgetAll(deps?.profiles.list().map((item) => item.id) ?? []);
    else await service.profileRemoval.forget(id);
    audit(id, false);
    return c.json({ success: true });
  });
  router.delete('/profiles/:id', async (c) => {
    if (!person(c)) return refused(c);
    z.object({}).strict().default({}).parse(readJsonBody(c));
    const id = z.string().uuid().parse(c.req.param('id'));
    if (!deps?.profiles.get(id)) return missing(c);
    await service.profileRemoval.delete(id, deps.profiles);
    audit(id, true);
    return c.json({ success: true });
  });
}
