import type { Hono } from 'hono';
import { CommunityWireHostLinksSchema } from '@dorkos/shared/community-wire';
import type { CommunityConfig } from '../config.js';
import { json } from '../http.js';

/**
 * Register the host's public terms, privacy and abuse-report links.
 *
 * These belong to the host, not to any one community, so the route takes no tenant and needs no
 * sign-in: the sign-in page shows them before anyone has an account. The server only returns
 * what the host configured; it never contacts or sends anything to the link targets.
 */
export function registerHostLinkRoutes(
  app: Hono,
  { config }: { config: Pick<CommunityConfig, 'hostLinks'> }
): void {
  app.get('/api/v1/host-links', (c) => {
    // Public and identical for everyone; it only changes when the host redeploys.
    c.header('Cache-Control', 'public, max-age=300');
    return json(c, CommunityWireHostLinksSchema, config.hostLinks);
  });
}
