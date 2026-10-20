import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { createCommunityApp } from '../../app.js';
import { parseConfig } from '../../config.js';
import { CENSUS_ENV } from '../../__tests__/promises/route-census.js';
import { parseUserContentUrl } from '../origin.js';
import { readUserContentLink, signUserContentLink, USER_CONTENT_LINK_TTL_MS } from '../links.js';

const PUBLIC = new URL('https://space.example.com');
const config = {
  authSecret: 'a'.repeat(32),
  publicUrl: 'https://space.example.com',
  userContentUrl: 'https://files.example-content.net',
};
const claim = {
  kind: 'attachment' as const,
  id: 'file-1',
  communityId: 'space-1',
  memberId: 'member-1',
  sessionId: 'session-1',
};

describe('COMMUNITY_USER_CONTENT_URL', () => {
  it('takes another host and refuses the space host, one under it, or anything but an origin', () => {
    // Purpose: fails if a file address could share the space's host, sit under it, or carry
    // a path, any of which would put files back beside the space's sign-in.
    expect(parseUserContentUrl(undefined, PUBLIC)).toBeNull();
    expect(parseUserContentUrl('https://files.example-content.net', PUBLIC)).toBe(
      'https://files.example-content.net'
    );
    for (const bad of [
      'https://space.example.com',
      'https://space.example.com:8443',
      // A trailing dot names the same host.
      'https://space.example.com.',
      'https://files.space.example.com',
      'https://files.space.example.com.',
      // A parent of the space's host could set cookies the space reads.
      'https://example.com',
      'https://example.com.',
      'https://files.example-content.net/files',
      'http://files.example-content.net',
    ])
      expect(() => parseUserContentUrl(bad, PUBLIC), bad).toThrow(/COMMUNITY_USER_CONTENT_URL/u);
    // A space on a dotted address compares the same way.
    expect(() =>
      parseUserContentUrl('https://space.example.com', new URL('https://space.example.com.'))
    ).toThrow(/COMMUNITY_USER_CONTENT_URL/u);
  });

  it('compares IP literals and internationalized names as the browser does', () => {
    // Purpose: fails if an address written another way slips past the checks above: an IDN is
    // compared in its punycode form, and an IP literal is a host of its own.
    expect(parseUserContentUrl('https://192.0.2.10', PUBLIC)).toBe('https://192.0.2.10');
    expect(() => parseUserContentUrl('https://192.0.2.10', new URL('https://192.0.2.10'))).toThrow(
      /COMMUNITY_USER_CONTENT_URL/u
    );
    const idn = new URL('https://bücher.example');
    expect(() => parseUserContentUrl('https://files.xn--bcher-kva.example', idn)).toThrow(
      /COMMUNITY_USER_CONTENT_URL/u
    );
    expect(() => parseUserContentUrl('https://bücher.example', idn)).toThrow(
      /COMMUNITY_USER_CONTENT_URL/u
    );
    expect(parseUserContentUrl('https://dateien.example', idn)).toBe('https://dateien.example');
  });
});

describe('signed download links', () => {
  it('open for their own claim until they expire, and never once edited', () => {
    // Purpose: fails if a link opens past its expiry, or a link edited by hand still opens.
    const now = new Date('2026-10-16T00:00:00Z');
    const { url, expiresAt } = signUserContentLink(config, claim, now);
    expect(url.startsWith('https://files.example-content.net/u/')).toBe(true);
    expect(expiresAt.getTime() - now.getTime()).toBe(USER_CONTENT_LINK_TTL_MS.attachment);
    const token = url.slice(url.lastIndexOf('/') + 1);
    expect(readUserContentLink(config, token, now)).toEqual({
      ...claim,
      expiresAt: expiresAt.getTime(),
    });
    expect(readUserContentLink(config, token, expiresAt)).toBe('expired');
    expect(readUserContentLink({ authSecret: 'b'.repeat(32) }, token, now)).toBe('invalid');
    expect(readUserContentLink(config, `${token}x`, now)).toBe('invalid');
    expect(readUserContentLink(config, 'no-signature', now)).toBe('invalid');
  });

  it('point at the space itself when there is no user-content address', () => {
    // Purpose: fails if a space with no user-content address hands out links that go nowhere.
    const { url } = signUserContentLink({ ...config, userContentUrl: null }, claim, new Date());
    expect(url.startsWith('https://space.example.com/u/')).toBe(true);
  });
});

describe('which host answers a link', () => {
  /** What a host answers for a path: the status, and the refusal's sentence. */
  async function answer(userContent: string | undefined, url: string) {
    const config = parseConfig({
      ...CENSUS_ENV,
      ...(userContent ? { COMMUNITY_USER_CONTENT_URL: userContent } : {}),
    });
    // Never connected: none of these requests reaches the database.
    const pool = new Pool({ connectionString: config.databaseUrl });
    try {
      const response = await createCommunityApp({ config, pool }).request(url);
      const body = (await response.json()) as { message?: string; status?: string };
      return `${response.status} ${body.message ?? body.status}`;
    } finally {
      await pool.end();
    }
  }
  const NOT_FOUND = '404 Not found.';
  const REACHED = '404 This download link is not valid.';

  it('answers links only on the files host, and nothing else there, once one is set', async () => {
    // Purpose: fails if a link opens on the space's own host or any other host, or if the files
    // host answers anything but links, while the space's own routes keep any host.
    const files = 'http://127.0.0.1:6481';
    expect(await answer(files, 'http://127.0.0.1:6481/u/x.y')).toBe(REACHED);
    expect(await answer(files, 'http://localhost:6481/u/x.y')).toBe(NOT_FOUND);
    expect(await answer(files, 'http://203.0.113.9:6481/u/x.y')).toBe(NOT_FOUND);
    expect(await answer(files, 'http://127.0.0.1:6481/health')).toBe(NOT_FOUND);
    expect(await answer(files, 'http://203.0.113.9:6481/health')).toBe('200 ok');
  });

  it('answers links on any host when there is no files host', async () => {
    // Purpose: fails if a self-hosted or local space with no setting cannot serve its links.
    expect(await answer(undefined, 'http://localhost:6481/u/x.y')).toBe(REACHED);
    expect(await answer(undefined, 'http://127.0.0.1:6481/u/x.y')).toBe(REACHED);
  });
});
