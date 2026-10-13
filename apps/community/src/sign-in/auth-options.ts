import type { Hono } from 'hono';
import { CommunityWireAuthOptionsSchema } from '@dorkos/shared/community-wire';
import type { CommunityConfig } from '../config.js';
import { json } from '../http.js';

/**
 * Register `GET /auth-options`: what the sign-in page offers and asks. The provider buttons
 * (never their client IDs or secrets), the sign-up rules a new account must confirm (minimum age,
 * allowed countries), and whether this space mails links. Never the trusted proxy's header.
 */
export function registerAuthOptionsRoute(
  api: Hono,
  { config, linksOn }: { config: CommunityConfig; linksOn: boolean }
): void {
  api.get('/auth-options', (c) =>
    json(c, CommunityWireAuthOptionsSchema, {
      google: Boolean(config.oauth.google),
      github: Boolean(config.oauth.github),
      oidc: config.oidc ? { label: config.oidc.label, mark: config.oidc.mark } : null,
      minimumAge: config.minimumAge,
      allowedCountries: config.allowedCountries,
      emailLinks: linksOn,
    })
  );
}
