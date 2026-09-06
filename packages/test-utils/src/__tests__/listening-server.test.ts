import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import request from '@dorkos/test-utils/supertest';

const target = swappableServer();

it('keeps one listener while routing the unmapped state and two explicit mounts', async () => {
  const port = (target.server.address() as AddressInfo).port;

  const unmapped = await request(target.server).get('/probe');
  expect(unmapped.status).toBe(500);
  expect(unmapped.text).toBe('swappableServer: no app mounted — call mount(app) before requesting');

  const mountedA = target.mount((_req, res) => {
    res.end('app-a');
  });
  expect(mountedA).toBe(target.server);
  expect((await request(target.server).get('/probe')).text).toBe('app-a');

  const mountedB = target.mount((_req, res) => {
    res.end('app-b');
  });
  expect(mountedB).toBe(target.server);
  expect((await request(target.server).get('/probe')).text).toBe('app-b');

  expect(target.server.listening).toBe(true);
  expect((target.server.address() as AddressInfo).port).toBe(port);
});
