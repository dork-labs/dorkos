import { afterEach, describe, expect, it, vi } from 'vitest';

import { createConnectorSpendingMethods } from '../connector-spending-methods';
import { answer, firstRequest } from './request-stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createConnectorSpendingMethods', () => {
  const methods = createConnectorSpendingMethods('/api');

  it('sets the monthly limit with PUT and a JSON `limit`', async () => {
    const fetchMock = answer({});
    await methods.setConnectorSpendingLimit(null);
    expect(firstRequest(fetchMock)).toEqual({
      url: '/api/connectors/spending/limit',
      method: 'PUT',
      body: '{"limit":null}',
    });
  });

  it('sets one app’s price with PUT, the toolkit escaped into the path', async () => {
    const fetchMock = answer({});
    await methods.setConnectorSpendingPrice('my app/x', '1500');
    expect(firstRequest(fetchMock)).toEqual({
      url: '/api/connectors/spending/prices/my%20app%2Fx',
      method: 'PUT',
      body: '{"price":"1500"}',
    });
  });
});
