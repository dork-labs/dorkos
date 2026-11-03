/** Person-only, tap-only metadata scan. Deliberately absent from the capability registry. */
import { Hono } from 'hono';
import type { YourBrowserScan } from '@dorkos/shared/your-browser';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { presentsProgramCredential, requirePersonAtThisComputer } from '../lib/caller-authority.js';
import { scanBrowserProfiles } from '../services/browser/profile-scan.js';

/** No GET handler: loading the page must never inspect browser metadata. */
export function createYourBrowserRoutes(
  scan: () => Promise<YourBrowserScan> = scanBrowserProfiles
): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  router.post('/scan', async (c) => {
    c.header('Cache-Control', 'no-store');
    const facts = honoRequestFacts(c);
    if (presentsProgramCredential(facts) || requirePersonAtThisComputer(facts) !== undefined)
      return c.json(
        { error: 'Only you can find your browsers, from DorkOS.', code: 'person_only' },
        403
      );
    return c.json(await scan());
  });
  return router;
}
