import { expect, it, vi } from 'vitest';
import { fixture, turns } from './broker-fixture.js';
import { FakeSocket } from './fake-transport.js';
import { EgressPolicyError, originalEgressPolicyRefusal } from '../../errors.js';
import type { OriginalConnectDenial } from '../connect-denial.js';

it.each([false, undefined])(
  'original policy denial enters client close before a faulted observer %s',
  async (failure) => {
    const client = new FakeSocket();
    const rows: OriginalConnectDenial[] = [];
    const observe = vi.fn((row: OriginalConnectDenial) => {
      expect(client.observedClosed).toBe(true);
      rows.push(row);
      throw failure;
    });
    const f = await fixture(undefined, observe);
    vi.mocked(f.resolver).mockResolvedValue({ a: ['127.0.0.1'], aaaa: [], cname: [] });
    f.fake.accept(client, f.request());
    await turns();
    expect(f.fake.transport.dial).not.toHaveBeenCalled();
    expect(client.writes).toEqual([]);
    expect(rows).toEqual([
      {
        browserId: 'browser',
        browserGeneration: 1,
        authority: 'example.test:443',
        outcome: 'denied',
        beforeDial: true,
        reason: 'ADDRESS_DENIED',
      },
    ]);
    expect(await f.broker.close()).toBe(true);
  }
);

it('reentrant observer retires the genuine broker without producing origin bytes', async () => {
  let originalClose: Promise<boolean> | undefined;
  const observe = vi.fn(() => {
    originalClose = f.broker.close();
  });
  const f = await fixture(undefined, observe);
  vi.mocked(f.resolver).mockResolvedValue({ a: ['127.0.0.1'], aaaa: [], cname: [] });
  const client = new FakeSocket();
  f.fake.accept(client, f.request());
  await turns();
  expect(observe).toHaveBeenCalledTimes(1);
  expect(f.fake.transport.dial).not.toHaveBeenCalled();
  expect(client.observedClosed).toBe(true);
  expect(await originalClose).toBe(true);
});

it('credential rejection and non-CONNECT policy rejection cannot fabricate CONNECT observations', async () => {
  const observe = vi.fn();
  const f = await fixture(undefined, observe);
  const request = f.request();
  request.raw.rawHeaders[3] = 'Bearer invalid';
  f.fake.accept(new FakeSocket(), request);
  f.fake.accept(new FakeSocket(), {
    raw: {
      method: 'GET',
      target: 'http://admin.example/',
      head: new Uint8Array(),
      rawHeaders: [
        'Host',
        'admin.example',
        'Proxy-Authorization',
        'Bearer ' + f.descriptor.credential,
      ],
    },
    body: f.request().body,
  });
  await turns();
  expect(f.fake.transport.dial).not.toHaveBeenCalled();
  expect(observe).not.toHaveBeenCalled();
  expect(await f.broker.close()).toBe(true);
});

it('only original minted policy errors expose a code without reading unknown getters', () => {
  const get = vi.fn(() => {
    throw false;
  });
  const unknown = new Proxy({}, { get });
  expect(originalEgressPolicyRefusal(unknown)).toBeUndefined();
  expect(originalEgressPolicyRefusal({ code: 'ADDRESS_DENIED' })).toBeUndefined();
  expect(originalEgressPolicyRefusal(new EgressPolicyError('ADDRESS_DENIED'))).toBe(
    'ADDRESS_DENIED'
  );
  expect(get).not.toHaveBeenCalled();
});
