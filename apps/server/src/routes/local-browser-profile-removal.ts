/** Person-only, profile-wide removal. No site or disk path is accepted. */
import type { Hono, Context } from 'hono';
import { z } from 'zod';
import { LocalBrowserProfileIdSchema } from '@dorkos/shared/local-browser';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { problem, readJsonBody } from '@dorkos/http-kit';
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
    problem(c, 'person_only', { detail: 'Only you can do this, from DorkOS.' });
  const missing = (c: Context<ApiEnv>) =>
    problem(c, 'not_found', {
      detail: 'That browser profile no longer exists. Refresh and try again.',
      extensions: { reason: 'profile_not_found' },
    });
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
    const id = LocalBrowserProfileIdSchema.parse(c.req.param('id'));
    if (id !== 'default' && !deps?.profiles.get(id)) return missing(c);
    await service.profileRemoval.forget(id === 'default' ? null : id);
    audit(id, false);
    return c.json({ success: true });
  });
  router.delete('/profiles/:id', async (c) => {
    if (!person(c)) return refused(c);
    z.object({}).strict().default({}).parse(readJsonBody(c));
    const id = LocalBrowserProfileIdSchema.refine((id) => id !== 'default').parse(
      c.req.param('id')
    );
    if (!deps?.profiles.get(id)) return missing(c);
    await service.profileRemoval.delete(id, deps.profiles);
    audit(id, true);
    return c.json({ success: true });
  });
}
