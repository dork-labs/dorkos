import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { CommunityWireHostLinksSchema } from '@dorkos/shared/community-wire';
import { parseConfig } from '../config.js';
import { registerHostLinkRoutes } from '../routes/host-links.js';

const base = {
  COMMUNITY_DATABASE_URL: 'postgres://postgres:pass@localhost:5432/community',
  COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
  COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
  COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
  COMMUNITY_PUBLIC_URL: 'http://localhost:6481',
  COMMUNITY_STORAGE_PATH: '/tmp/community-blobs',
};

async function read(env: Record<string, string>) {
  const app = new Hono();
  registerHostLinkRoutes(app, { config: parseConfig({ ...base, ...env }) });
  // No cookie, no tenant: the sign-in page reads this before anyone has an account.
  const response = await app.request('/api/v1/host-links');
  return { status: response.status, body: (await response.json()) as unknown };
}

describe('GET /api/v1/host-links', () => {
  it('answers three nulls to anyone when the host set no links', async () => {
    // Purpose: fails if an unset link is sent as an empty string or placeholder the UI would show.
    expect(await read({})).toEqual({
      status: 200,
      body: { termsUrl: null, privacyUrl: null, reportAbuseUrl: null },
    });
  });

  it('answers exactly the configured links and nothing else', async () => {
    // Purpose: fails if the projection widens past the three links or rewrites one.
    const { status, body } = await read({
      COMMUNITY_TERMS_URL: 'https://example.com/terms',
      COMMUNITY_PRIVACY_URL: 'https://example.com/privacy',
      COMMUNITY_REPORT_ABUSE_URL: 'mailto:abuse@example.com',
    });
    expect(status).toBe(200);
    expect(body).toEqual({
      termsUrl: 'https://example.com/terms',
      privacyUrl: 'https://example.com/privacy',
      reportAbuseUrl: 'mailto:abuse@example.com',
    });
    expect(CommunityWireHostLinksSchema.parse(body)).toEqual(body);
  });

  it('rejects a non-HTTPS link in the wire contract as well as in configuration', () => {
    // Purpose: fails if a client could accept a plain-HTTP or script link from a server.
    const links = { termsUrl: null, privacyUrl: null, reportAbuseUrl: null };
    for (const bad of [
      { ...links, termsUrl: 'http://example.com/terms' },
      { ...links, privacyUrl: 'mailto:privacy@example.com' },
      { ...links, reportAbuseUrl: 'javascript:alert(1)' },
      { ...links, extra: 'https://example.com' },
    ])
      expect(CommunityWireHostLinksSchema.safeParse(bad).success).toBe(false);
  });
});
