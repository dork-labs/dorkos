import { describe, expect, it } from 'vitest';
import { communityBasePath, isCommunityPath, setShortNameRoute, tenantApiPath } from './api.js';

describe('tenantApiPath', () => {
  it('keeps the singleton compatibility API at the host root', () => {
    expect(tenantApiPath('/api/v1/channels', '/')).toBe('/api/v1/channels');
  });

  it('qualifies requests, streams, and downloads from a canonical community path', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(tenantApiPath('/api/v1/channels', `/c/${id}`)).toBe(
      `/api/v1/communities/${id}/channels`
    );
    expect(tenantApiPath('/api/v1/channels/room/events', `/c/${id}/pairing`)).toBe(
      `/api/v1/communities/${id}/channels/room/events`
    );
    expect(tenantApiPath('/api/auth/sign-out', `/c/${id}`)).toBe('/api/auth/sign-out');
  });

  it('preserves an invalid canonical segment so the server rejects it without alias fallback', () => {
    expect(tenantApiPath('/api/v1/community', '/c/not-a-uuid')).toBe(
      '/api/v1/communities/not-a-uuid/community'
    );
  });

  it('qualifies requests from a short address with the UUID it resolved to, and only there', () => {
    // Purpose: fails if a page reached as /<name> sends unqualified requests, or if the
    // remembered name leaks into another path.
    const id = '22222222-2222-4222-8222-222222222222';
    setShortNameRoute({ communityId: id, basePath: '/acme' });
    try {
      expect(tenantApiPath('/api/v1/channels', '/acme')).toBe(`/api/v1/communities/${id}/channels`);
      expect(tenantApiPath('/api/v1/me', '/acme/settings/account')).toBe(
        `/api/v1/communities/${id}/me`
      );
      expect(tenantApiPath('/api/v1/channels', '/acme-labs')).toBe('/api/v1/channels');
      expect(communityBasePath(id)).toBe('/acme');
      expect(communityBasePath('33333333-3333-4333-8333-333333333333')).toBe(
        '/c/33333333-3333-4333-8333-333333333333'
      );
    } finally {
      setShortNameRoute(null);
    }
  });
});

describe('isCommunityPath', () => {
  it('treats the resolved short address as a community page, like /c/<uuid>', () => {
    // Purpose: fails if a page opened at /<name> stays put when its community is not open to
    // this person, where /c/<uuid> would go back to the chooser.
    const id = '22222222-2222-4222-8222-222222222222';
    expect(isCommunityPath('/acme')).toBe(false);
    setShortNameRoute({ communityId: id, basePath: '/acme' });
    try {
      expect(isCommunityPath('/acme')).toBe(true);
      expect(isCommunityPath('/acme/settings')).toBe(true);
      expect(isCommunityPath('/acme-labs')).toBe(false);
      expect(isCommunityPath(`/c/${id}`)).toBe(true);
      expect(isCommunityPath('/')).toBe(false);
      expect(isCommunityPath('/host')).toBe(false);
    } finally {
      setShortNameRoute(null);
    }
  });
});
