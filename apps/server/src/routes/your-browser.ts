/** Person-only, tap-only metadata scan. Deliberately absent from the capability registry. */
import { Hono } from 'hono';
import type { YourBrowserScan } from '@dorkos/shared/your-browser';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { presentsProgramCredential, requirePersonAtThisComputer } from '../lib/caller-authority.js';
import { scanBrowserProfiles } from '../services/browser/profile-scan.js';
import { env } from '../env.js';

/** No GET handler: loading the page must never inspect browser metadata. */
export function createYourBrowserRoutes(
  scan: () => Promise<YourBrowserScan> = scanBrowserProfiles,
  enabled: () => boolean = () => env.DORKOS_YOUR_BROWSER_ENABLED
): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  router.post('/scan', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!enabled())
      return c.json(
        { error: 'Browser discovery is off.', code: 'browser_discovery_disabled' },
        404
      );
    const facts = honoRequestFacts(c);
    // Run the existing person bar first so the app can ask for the owner's
    // session even with Require login off. An owner-less open gate proves no
    // person for this private metadata read, so a cookie is mandatory here.
    const refusal = requirePersonAtThisComputer(facts);
    const origin = facts.headers.origin;
    if (
      refusal !== undefined ||
      presentsProgramCredential(facts) ||
      facts.user?.credential !== 'cookie' ||
      (origin !== undefined && !/^https?:\/\//i.test(origin))
    )
      return c.json(
        { error: 'Only you can find your browsers, from DorkOS.', code: 'person_only' },
        403
      );
    return c.json(await scan());
  });
  return router;
}
