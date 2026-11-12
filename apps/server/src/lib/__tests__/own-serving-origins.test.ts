import { describe, it, expect, vi } from 'vitest';

// Made-up addresses throughout. Each source is mocked so the test reads exactly
// what this server would answer to beyond loopback, and nothing else.
vi.mock('../../env.js', () => ({ env: { DORKOS_PORT: 4242, NODE_ENV: 'development' } }));
vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: { status: { url: 'https://box.tail.ts.net/' } },
}));
vi.mock('../../services/core/lan-access/lan-trust.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getLanAccessOrigins: () => ['http://192.168.1.20:4242'],
}));
vi.mock('../../services/core/hub/hub-serving.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  hubServingOrigins: () => ['https://hub.example.com'],
}));

import {
  getOwnServingOrigins,
  getStaticLocalOrigins,
  resolveTrustedOrigins,
} from '../trusted-origins.js';

// DOR-4132: the canvas browser reads this list to know this server by every
// name it answers to, so it must be exactly the non-loopback half of the trust list.
describe('getOwnServingOrigins', () => {
  it('names this server’s tunnel, Wi-Fi and hub addresses', () => {
    expect(getOwnServingOrigins()).toEqual([
      'https://box.tail.ts.net',
      'http://192.168.1.20:4242',
      'https://hub.example.com',
    ]);
  });

  it('is the trust list without its loopback origins', () => {
    expect(resolveTrustedOrigins()).toEqual([
      ...getStaticLocalOrigins(),
      ...getOwnServingOrigins(),
    ]);
  });
});
