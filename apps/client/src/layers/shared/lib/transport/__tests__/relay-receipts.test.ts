import { afterEach, expect, it, vi } from 'vitest';
import type { Transport } from '@dorkos/shared/transport';
import type { RelayDeliveryReceipt } from '@dorkos/shared/relay-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { createRelayMethods } from '../relay-methods';
import { HttpTransport } from '../http-transport';

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const receipt: RelayDeliveryReceipt = {
  messageId: ID,
  scope: 'agent_delivery',
  state: 'accepted',
  acceptedAt: '2026-10-02T12:00:00.000Z',
  updatedAt: '2026-10-02T12:00:00.000Z',
  expiresAt: '2026-10-09T12:00:00.000Z',
};
const url = `/api/relay/messages/${ID}/status`;
const methods = createRelayMethods('/api', () => 'fixture-client');
afterEach(() => vi.restoreAllMocks());
function respond(body: unknown, status = 200) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

it('the composed HttpTransport exposes a typed receipt GET at the exact authenticated boundary', async () => {
  const fetch = respond(receipt);
  const transport: Transport = new HttpTransport('/api');
  const result: RelayDeliveryReceipt = await transport.getRelayDeliveryReceipt(ID);
  expect(result).toEqual(receipt);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe(url);
  expect(fetch.mock.calls[0][1]?.credentials).toBe('include');
  expect(fetch.mock.calls[0][1]?.method).toBeUndefined();
});

it('encodes the locator as one path segment without injecting a new route', async () => {
  const fetch = respond(receipt);
  await methods.getRelayDeliveryReceipt('one/two?three');
  expect(fetch.mock.calls[0][0]).toBe('/api/relay/messages/one%2Ftwo%3Fthree/status');
});

it('send keeps the same body/POST and forwards optional receipt and statusUrl', async () => {
  const response = { messageId: ID, deliveredTo: 1, receipt, statusUrl: url };
  const fetch = respond(response);
  const input = {
    subject: 'relay.agent.example',
    payload: { task: 'Example' },
    from: 'relay.human.console',
  };
  expect(await methods.sendRelayMessage(input)).toEqual(response);
  expect(fetch.mock.calls[0][0]).toBe('/api/relay/messages');
  expect(fetch.mock.calls[0][1]).toMatchObject({
    method: 'POST',
    credentials: 'include',
    body: JSON.stringify(input),
  });
});

it('ordinary send results and central full mock stay compatible without fabricated receipts', async () => {
  respond({ messageId: ID, deliveredTo: 0 });
  const input = { subject: 'relay.custom.example', payload: {}, from: 'relay.human.console' };
  expect(await methods.sendRelayMessage(input)).toEqual({ messageId: ID, deliveredTo: 0 });
  const mock = createMockTransport();
  expect(vi.isMockFunction(mock.getRelayDeliveryReceipt)).toBe(true);
  expect(await mock.sendRelayMessage(input)).toEqual({ messageId: 'msg-1', deliveredTo: 0 });
  const configured = createMockTransport({
    getRelayDeliveryReceipt: vi.fn().mockResolvedValue(receipt),
  });
  expect(await configured.getRelayDeliveryReceipt(ID)).toEqual(receipt);
});

it('existing fetchJSON preserves a locator-bearing POST503 under error.body', async () => {
  const body = {
    error: 'Delivery receipt response is unavailable.',
    code: 'RELAY_RECEIPT_RESPONSE_UNAVAILABLE',
    messageId: ID,
    statusUrl: url,
  };
  respond(body, 503);
  await expect(
    methods.sendRelayMessage({
      subject: 'relay.agent.example',
      payload: {},
      from: 'relay.human.console',
    })
  ).rejects.toMatchObject({ status: 503, code: body.code, body });
});

it.each([
  [404, 'RELAY_RECEIPT_NOT_FOUND'],
  [503, 'RELAY_RECEIPT_STORAGE_UNAVAILABLE'],
] as const)('status HTTP%s remains distinct with parsed error data', async (status, code) => {
  const body = { error: 'Safe status error.', code };
  respond(body, status);
  await expect(methods.getRelayDeliveryReceipt(ID)).rejects.toMatchObject({ status, code, body });
});
