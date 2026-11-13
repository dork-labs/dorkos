import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(() => undefined) },
}));
vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: { status: { enabled: false, connected: false, url: null } },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../services/core/auth/session-gate.js', async (original) => ({
  ...(await original<object>()),
  decideSessionGate: vi.fn(
    async (_method: string, _path: string, facts: { headers: IncomingHttpHeaders }) =>
      facts.headers.authorization === 'Bearer valid-test-key'
        ? { allowed: true }
        : { allowed: false }
  ),
}));

import { createApiApp } from '../api-chain.js';
import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import { decideSessionGate } from '../../services/core/auth/session-gate.js';
import { env } from '../../env.js';
import { markIngress } from '../../services/core/remote/ingress-mark.js';

beforeEach(() => {
  vi.mocked(decideSessionGate).mockClear();
  env.DORKOS_TRUST_PROXY = false;
});
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const app = createApiApp({ admission: new MainRequestAdmission() });
  app.all('/mcp', (c) => c.json({ ok: true }));
  app.all('/api/test', (c) => c.json({ ok: true }));
  return (
    options: {
      key?: string;
      peer?: string;
      forwarded?: string;
      path?: string;
      /** A request through a marked listener: ngrok forwards it from loopback. */
      ingress?: 'own-tunnel' | 'managed';
    } = {}
  ) => {
    const headers: Record<string, string> = {
      host: options.ingress ? 'example.ngrok.app' : 'localhost:4242',
    };
    if (options.key) headers.authorization = `Bearer ${options.key}`;
    if (options.forwarded) headers['x-forwarded-for'] = options.forwarded;
    const outgoing = Object.assign(new EventEmitter(), { setHeader: vi.fn() });
    const incoming = {
      headers,
      socket: { remoteAddress: options.peer ?? (options.ingress ? '127.0.0.1' : '198.51.100.5') },
      url: options.path ?? '/mcp',
    };
    if (options.ingress) markIngress(incoming as never, options.ingress);
    return app.request(options.path ?? '/mcp', { method: 'POST', headers }, { incoming, outgoing });
  };
}

// DOR-4205, Security's Must on #3667: both marked listeners forward from loopback, so a
// peer-keyed bucket was one bucket for every remote caller, and a stranger could lock the
// owner out. ngrok's edge appends the address it saw to `X-Forwarded-For` (made-up ones here).
describe.each(['own-tunnel', 'managed'] as const)('the throttle through %s', (ingress) => {
  it('keeps a stranger from locking the owner’s valid key out', async () => {
    const send = fixture();
    expect((await send({ ingress, key: 'valid-test-key', forwarded: '203.0.113.20' })).status).toBe(
      200
    );
    for (let i = 0; i < 10; i++)
      expect((await send({ ingress, key: `junk-${i}`, forwarded: '198.51.100.66' })).status).toBe(
        401
      );
    expect((await send({ ingress, key: 'valid-test-key', forwarded: '203.0.113.20' })).status).toBe(
      200
    );
  });

  it('still throttles the stranger, whatever it puts left of the edge’s entry', async () => {
    const send = fixture();
    for (let i = 0; i < 10; i++)
      await send({ ingress, key: `junk-${i}`, forwarded: `192.0.2.${i}, 198.51.100.66` });
    vi.mocked(decideSessionGate).mockClear();
    const blocked = await send({
      ingress,
      key: 'valid-test-key',
      forwarded: '192.0.2.99, 198.51.100.66',
    });
    expect(blocked.status).toBe(401);
    expect(decideSessionGate).not.toHaveBeenCalled();
  });
});

describe('remote /mcp bad-key throttle on the real API chain', () => {
  it('stops verification after ten failures, even with rotating keys and forwarding headers', async () => {
    const send = fixture();
    let first: Response | undefined;
    for (let i = 0; i < 10; i++) {
      const response = await send({ key: `wrong-${i}`, forwarded: `203.0.113.${i + 1}` });
      expect(response.status).toBe(401);
      first ??= response;
    }
    const blocked = await send({ key: 'valid-test-key', forwarded: '203.0.113.99' });
    expect(blocked.status).toBe(401);
    expect(await blocked.text()).toBe(await first!.text());
    expect([...blocked.headers]).toEqual([...first!.headers]);
    expect(decideSessionGate).toHaveBeenCalledTimes(10);
    expect((await send({ key: 'valid-test-key', peer: '198.51.100.6' })).status).toBe(200);
  });

  it('gives successful requests their budget back', async () => {
    const send = fixture();
    for (let i = 0; i < 15; i++) {
      expect((await send({ key: 'valid-test-key' })).status).toBe(200);
    }
    for (let i = 0; i < 9; i++) expect((await send()).status).toBe(401);
    expect((await send({ key: 'valid-test-key' })).status).toBe(200);
  });

  it('expires the failure window after fifteen minutes', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const send = fixture();
    for (let i = 0; i < 10; i++) await send();
    expect((await send({ key: 'valid-test-key' })).status).toBe(401);
    now.mockReturnValue(1_000_000 + 15 * 60_000);
    expect((await send({ key: 'valid-test-key' })).status).toBe(200);
  });

  it('leaves local callers and other API paths outside this throttle', async () => {
    const send = fixture();
    for (let i = 0; i < 12; i++) {
      await send({ peer: '127.0.0.1' });
      await send({ path: '/api/test' });
    }
    expect((await send({ peer: '127.0.0.1', key: 'valid-test-key' })).status).toBe(200);
    expect((await send({ path: '/api/test', key: 'valid-test-key' })).status).toBe(200);
  });
});
