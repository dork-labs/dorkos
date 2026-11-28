/** The writes-back calls send exactly the requests the hand-written ones did (DOR-5473). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answer, firstRequest } from './request-stub';
import { createConnectorWritesBackMethods } from '../connector-writes-back-methods';

afterEach(() => vi.unstubAllGlobals());

describe('createConnectorWritesBackMethods', () => {
  const methods = createConnectorWritesBackMethods('/api');

  it('reads and puts one connection’s setting at its encoded id', async () => {
    let fetchMock = answer({});
    await methods.getConnectorWritesBack('c 1');
    expect(firstRequest(fetchMock)).toEqual({
      url: '/api/connectors/connections/c%201/writes-back',
      method: 'GET',
      body: undefined,
    });

    fetchMock = answer({});
    await methods.setConnectorWritesBack('c/1', {
      writesBackUnasked: true,
      confirmsNoOutsideSync: true,
    });
    expect(firstRequest(fetchMock)).toEqual({
      url: '/api/connectors/connections/c%2F1/writes-back',
      method: 'PUT',
      body: '{"writesBackUnasked":true,"confirmsNoOutsideSync":true}',
    });
  });
});
