import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { ComposioEventClient } from '@dorkos/connector-providers/composio';

const state = vi.hoisted(() => ({ login: false }));
vi.mock('../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) => (key === 'auth' ? { enabled: state.login } : undefined)),
    set: vi.fn(),
  },
}));
vi.mock('../services/core/tunnel-manager.js', () => ({
  tunnelManager: { status: { enabled: false, connected: false, url: null } },
}));
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import { createApp } from '../app.js';
import { logger } from '../lib/logger.js';

const target = swappableServer();
const secret = 'literal-signing-secret-fixture';
const verifier = new ComposioEventClient({
  apiKey: 'fixture-no-network',
  serverUserId: 'fixture-user',
  webhookSecret: secret,
});
const accept = vi.fn(async () => 'accepted' as const);
const body =
  '{ "trigger_name":"GMAIL_NEW_MESSAGE", "connection_id":"ca_exact", "trigger_id":"tr_exact", "payload":{"subject":"private sentinel"}, "log_id":"log" }';
function signed(raw = body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const id = 'msg_exact';
  return {
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${createHmac('sha256', secret).update(`${id}.${timestamp}.${raw}`).digest('base64')}`,
  };
}
beforeEach(() => {
  state.login = false;
  vi.clearAllMocks();
});
function mount() {
  const app = createApp({ connectorEventIngress: { verifier: () => verifier, accept } });
  app.get('/api/ordinary-event-test', (_req, res) => res.json({ ordinary: true }));
  target.mount(app);
}

describe('signed events in the real createApp middleware stack', () => {
  it.each([true, false])(
    'preserves exact signed bytes with login=%s and keeps ordinary routes gated',
    async (enabled) => {
      state.login = enabled;
      mount();
      const response = await request(target.server)
        .post('/api/connectors/webhooks/provider-one')
        .set('content-type', 'application/json')
        .set(signed())
        .send(body);
      expect(response.status).toBe(202);
      expect(accept).toHaveBeenCalledTimes(1);
      expect(accept.mock.calls[0]).toMatchObject([
        'provider-one',
        { authenticatedWebhookId: 'msg_exact', payload: { subject: 'private sentinel' } },
      ]);
      const ordinary = await request(target.server).get('/api/ordinary-event-test');
      expect(ordinary.status).toBe(enabled ? 401 : 200);
      expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain('private sentinel');
    }
  );
  it('rejects invalid signature without reaching persistence or the ordinary error logger', async () => {
    state.login = true;
    mount();
    const response = await request(target.server)
      .post('/api/connectors/webhooks/provider-one')
      .set('content-type', 'application/json')
      .set(signed())
      .send(body + ' ');
    expect(response.status).toBe(401);
    expect(accept).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('private sentinel');
  });
  it.each([
    ['text/plain', undefined, 415],
    ['application/json', 'gzip', 415],
  ] as const)('rejects content type %s and encoding %s', async (type, encoding, status) => {
    mount();
    let pending = request(target.server)
      .post('/api/connectors/webhooks/provider-one')
      .set('content-type', type)
      .set(signed());
    if (encoding) pending = pending.set('content-encoding', encoding);
    expect((await pending.send(body)).status).toBe(status);
    expect(accept).not.toHaveBeenCalled();
  });
  it('rejects oversized raw requests before persistence', async () => {
    mount();
    const raw = 'x'.repeat(256 * 1024 + 1);
    const response = await request(target.server)
      .post('/api/connectors/webhooks/provider-one')
      .set('content-type', 'application/json')
      .set(signed(raw))
      .send(raw);
    expect(response.status).toBe(413);
    expect(accept).not.toHaveBeenCalled();
  });
  it('preserves host restrictions ahead of the signature exemption', async () => {
    mount();
    const response = await request(target.server)
      .post('/api/connectors/webhooks/provider-one')
      .set('Host', 'evil.example')
      .set('content-type', 'application/json')
      .set(signed())
      .send(body);
    expect(response.status).toBe(403);
    expect(accept).not.toHaveBeenCalled();
  });
});
