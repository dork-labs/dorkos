/** The mini-app access calls send exactly the requests the hand-written ones did (DOR-5473). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answer, firstRequest } from './request-stub';
import { createMiniAppAccessMethods } from '../mini-app-access-methods';

afterEach(() => vi.unstubAllGlobals());

describe('createMiniAppAccessMethods', () => {
  const methods = createMiniAppAccessMethods('/api');

  it('lists the access and revokes one at its encoded id with an empty object', async () => {
    let fetchMock = answer({ approvals: [] });
    await methods.getMiniAppAccess();
    expect(firstRequest(fetchMock)).toEqual({
      url: '/api/connectors/mini-app-access',
      method: 'GET',
      body: undefined,
    });

    fetchMock = answer({ revoked: true });
    await methods.revokeMiniAppAccess('a 1');
    expect(firstRequest(fetchMock)).toEqual({
      url: '/api/connectors/mini-app-access/a%201/revoke',
      method: 'POST',
      body: '{}',
    });
  });
});
