import { describe, expect, it } from 'vitest';
import { tenantApiPath } from './api.js';

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
});
