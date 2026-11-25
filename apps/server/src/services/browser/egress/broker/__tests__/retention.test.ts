import { it, expect } from 'vitest';
import { fixture, turns } from './broker-fixture.js';
import { FakeSocket, fakeTransport } from './fake-transport.js';
it('global circuit capacity is shared across two private brokers, including held cleanup', async () => {
  const f = await fixture({ globalCircuits: 1 }),
    g = fakeTransport(),
    second = f.create(g.transport);
  const descriptor = await second.start();
  const a = new FakeSocket(),
    b = new FakeSocket();
  f.fake.accept(a, f.request());
  await turns();
  a.closeHeld = true;
  const request = f.request();
  request.raw.rawHeaders[3] = 'Bearer ' + descriptor.credential;
  g.accept(b, request);
  await turns();
  expect(g.transport.dial).not.toHaveBeenCalled();
  expect(b.observedClosed).toBe(true);
  expect(f.fake.transport.dial).toHaveBeenCalledTimes(1);
  a.closed();
});
it('oversized CONNECT buffered head refuses before authority resolver/dial', async () => {
  const f = await fixture({ queueBytes: 3 }),
    client = new FakeSocket(),
    request = f.request();
  request.raw.head = Buffer.from('1234');
  f.fake.accept(client, request);
  await turns();
  expect(f.resolver).not.toHaveBeenCalled();
  expect(f.fake.transport.dial).not.toHaveBeenCalled();
  expect(client.writes).toEqual([]);
});
it('predecessor/copied credential never authorizes current broker', async () => {
  const f = await fixture(),
    client = new FakeSocket(),
    request = f.request();
  request.raw.rawHeaders[3] = 'Bearer predecessor';
  f.fake.accept(client, request);
  await turns();
  expect(f.resolver).not.toHaveBeenCalled();
  expect(client.observedClosed).toBe(true);
});
