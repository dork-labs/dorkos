/** The permission calls send exactly the requests the hand-written ones did (DOR-5473). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answer, firstRequest } from './request-stub';
import { createPermissionMethods } from '../permission-methods';

afterEach(() => vi.unstubAllGlobals());

describe('createPermissionMethods', () => {
  const methods = createPermissionMethods('/api');

  it('reads one agent’s permissions and level at its encoded id', async () => {
    let fetchMock = answer({});
    await methods.getAgentPermissions('agent 1');
    expect(firstRequest(fetchMock)).toEqual({
      url: '/api/agents/agent%201/permissions',
      method: 'GET',
      body: undefined,
    });

    fetchMock = answer({});
    await methods.getAgentLevel('agent/1');
    expect(firstRequest(fetchMock)).toEqual({
      url: '/api/agents/agent%2F1/level',
      method: 'GET',
      body: undefined,
    });
  });

  // `null` puts an area back to its default, so it must reach the server as `null`.
  it('patches one agent at its encoded id with the body as JSON, nulls kept', async () => {
    const fetchMock = answer({ changes: [], permissions: {} });
    await methods.patchAgentPermissions('agent 1', {
      areas: { files: null, web: 'ask' },
      surface: 'agent-page',
    });
    expect(firstRequest(fetchMock)).toEqual({
      url: '/api/agents/agent%201/permissions',
      method: 'PATCH',
      body: '{"areas":{"files":null,"web":"ask"},"surface":"agent-page"}',
    });
  });
});
