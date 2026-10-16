import { describe, expect, it } from 'vitest';
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
      'https://files.space.example.com',
      'https://files.example-content.net/files',
      'http://files.example-content.net',
    ])
      expect(() => parseUserContentUrl(bad, PUBLIC), bad).toThrow(/COMMUNITY_USER_CONTENT_URL/u);
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
