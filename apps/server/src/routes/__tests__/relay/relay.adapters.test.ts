import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import type { RelayCore } from '@dorkos/relay';
import type { StreamEvent } from '@dorkos/shared/types';
import { relayRoutesListener } from '../relay-routes-listener.js';
import { AdapterError, type AdapterManager } from '../../../services/relay/adapter-manager.js';
import { withStrangerMarkFlag } from '../../../services/rooms/__tests__/stranger-mark-flag.js';
import { countWhileRunning } from '../../../services/core/turn-power/live-outsider-turns.js';
import {
  createMockAdapterManager,
  createMockRelayCore,
  relayApp,
  server,
  target,
  useLoginOffConfig,
  type MockAdapterManager,
} from './relay.fixtures.js';

useLoginOffConfig();

describe('Adapter routes', () => {
  let relayCore: RelayCore;
  let adapterManager: MockAdapterManager;

  beforeEach(() => {
    relayCore = createMockRelayCore();
    adapterManager = createMockAdapterManager();
    target.mount(relayApp(relayCore, adapterManager));
  });

  it('returns a single adapter status', async () => {
    const res = await request(server).get('/api/relay/adapters/tg-main');

    expect(res.status).toBe(200);
    expect(res.body.config.id).toBe('tg-main');
  });

  it('does not mount the adapter routes without an adapter manager', async () => {
    target.mount(relayApp(relayCore));
    const res = await request(server).get('/api/relay/adapters');

    expect(res.status).toBe(404);
  });

  describe('enable, disable, reload', () => {
    it('enables an adapter', async () => {
      vi.mocked(adapterManager.getAdapter).mockReturnValueOnce({
        config: { id: 'tg-main', type: 'telegram', enabled: false, config: {} },
        status: { state: 'disabled' },
      } as unknown as ReturnType<AdapterManager['getAdapter']>);
      const res = await request(server).post('/api/relay/adapters/tg-main/enable');

      expect(res.status).toBe(200);
      expect(vi.mocked(adapterManager.enable)).toHaveBeenCalledWith('tg-main');
    });

    it('disables an adapter', async () => {
      const res = await request(server).post('/api/relay/adapters/tg-main/disable');

      expect(res.status).toBe(200);
      expect(vi.mocked(adapterManager.disable)).toHaveBeenCalledWith('tg-main');
    });

    it('reloads the config', async () => {
      const res = await request(server).post('/api/relay/adapters/reload');

      expect(res.status).toBe(200);
      expect(vi.mocked(adapterManager.reload)).toHaveBeenCalledOnce();
    });

    it.each([
      ['getCatalog', 'get', '/api/relay/adapters/catalog', 500],
      ['reload', 'post', '/api/relay/adapters/reload', 500],
      ['testConnection', 'post', '/api/relay/adapters/test', 500],
    ] as const)(
      'answers %s throwing with %i and a fixed sentence, never its message',
      async (method, verb, path, status) => {
        vi.mocked(adapterManager[method]).mockImplementation(() => {
          throw new Error('Unexpected failure');
        });

        const res = await request(server)
          [verb](path)
          .send({ type: 'telegram', config: { token: 'x' } });

        expect(res.status).toBe(status);
        expect(res.headers['content-type']).toContain('application/problem+json');
        expect(res.body.code).toBe('internal_error');
        expect(res.body.detail).toMatch(/^Couldn’t .*Try again\.$/);
        expect(JSON.stringify(res.body)).not.toContain('Unexpected failure');
      }
    );

    // Security S7 on DOR-4355 M3: an agent never turns a chat connection back on
    // over HTTP, and a marked turn is no exception. The owner's hold is in
    // `relay-adapter-enable-step-up.test.ts`.
    it('refuses a marked agent turn turning a connection back on', async () => {
      const agentPath = '/made-up/agents/porter';
      vi.mocked(adapterManager.getAdapter).mockReturnValue({
        config: { id: 'tg-off', type: 'telegram', enabled: false, config: {} },
        status: { state: 'disabled' },
      } as unknown as ReturnType<AdapterManager['getAdapter']>);
      target.mount(
        relayRoutesListener(
          { relayCore, adapterManager },
          {
            before: async (c, next) => {
              c.set('agentIdentity', {
                agentPath,
                displayName: 'Porter',
                createdAt: '2026-11-01T00:00:00.000Z',
              });
              await next();
            },
          }
        )
      );
      const turn = countWhileRunning(
        { cwd: agentPath },
        { outsider: true },
        (async function* () {
          yield { type: 'done', data: {} } as StreamEvent;
        })()
      );
      await turn.next();
      try {
        const res = await request(server)
          .post('/api/relay/adapters/tg-off/enable')
          .set('X-DorkOS-Agent', 'agent-1');
        expect(res.status).toBe(403);
        expect(vi.mocked(adapterManager.enable)).not.toHaveBeenCalled();
      } finally {
        await turn.return(undefined);
      }
    });
  });

  describe('POST /api/relay/webhooks/:adapterId', () => {
    it('routes a valid webhook to the adapter and returns 200', async () => {
      const res = await request(server)
        .post('/api/relay/webhooks/wh-github')
        .set('Content-Type', 'application/json')
        .set('X-Signature', 'test-sig')
        .set('X-Timestamp', String(Math.floor(Date.now() / 1000)))
        .set('X-Nonce', 'test-nonce')
        .send(JSON.stringify({ event: 'push', repo: 'test' }));

      expect(res.status).toBe(200);
      expect(adapterManager._mockWebhookAdapter.handleInbound).toHaveBeenCalled();
    });

    // DOR-3650: a non-webhook connection answers exactly as a missing one, so
    // the route never says which ids exist.
    it('answers a non-webhook adapter with the flat 401 (DOR-3650)', async () => {
      const res = await request(server)
        .post('/api/relay/webhooks/tg-main')
        .set('Content-Type', 'application/json')
        .send('{}');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_signature');
    });

    it('returns 401 when signature verification fails', async () => {
      vi.mocked(adapterManager._mockWebhookAdapter.handleInbound).mockResolvedValue({
        ok: false,
        error: 'Invalid signature',
      });

      const res = await request(server)
        .post('/api/relay/webhooks/wh-github')
        .set('Content-Type', 'application/json')
        .send('{}');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_signature');
    });

    // A refusal that runs before the signature (an address DorkOS keeps) must
    // look like every other unverified refusal, so it tells a stranger nothing.
    it('answers a refused address with the same flat 401, before any signature check', async () => {
      vi.mocked(adapterManager._mockWebhookAdapter.handleInbound).mockResolvedValue({
        ok: false,
        error: 'reserved',
        status: 403,
      });

      const res = await request(server)
        .post('/api/relay/webhooks/wh-github')
        .set('Content-Type', 'application/json')
        .send('{}');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_signature');
    });

    it.each([
      [503, 'temporarily_unavailable'],
      [500, 'internal_error'],
    ] as const)('answers a delivery failure after the signature as %i %s', async (status, code) => {
      vi.mocked(adapterManager._mockWebhookAdapter.handleInbound).mockResolvedValue({
        ok: false,
        error: 'Publish failed',
        status,
      });

      const res = await request(server)
        .post('/api/relay/webhooks/wh-github')
        .set('Content-Type', 'application/json')
        .send('{}');

      expect(res.status).toBe(status);
      expect(res.body.code).toBe(code);
      expect(JSON.stringify(res.body)).not.toContain('Publish failed');
    });
  });

  describe('POST /api/relay/adapters', () => {
    it('returns 201 on success, written by a person', async () => {
      const res = await request(server)
        .post('/api/relay/adapters')
        .send({
          type: 'webhook',
          id: 'wh-new',
          config: { inbound: { subject: 'relay.webhook.new', secret: 'secret-long-enough' } },
        });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ ok: true, id: 'wh-new' });
      expect(vi.mocked(adapterManager.addAdapter).mock.calls.at(-1)?.[5]).toBe('person');
    });

    it('lets only a person confirm a paused connection (DOR-3271)', async () => {
      const refused = await request(server)
        .post('/api/relay/adapters/wh-1/confirm-references')
        .set('X-DorkOS-Agent', 'agent-1');
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('person_only');
      expect(vi.mocked(adapterManager.confirmReferences)).not.toHaveBeenCalled();

      const missing = await request(server).post('/api/relay/adapters/wh-1/confirm-references');
      expect(missing.status).toBe(400);

      // This install has no owner yet, so the person at this computer confirms
      // with no sheet (Security on DOR-3467). With an owner it waits for
      // "Confirm it's you": `relay-confirm-step-up.test.ts`.
      vi.mocked(adapterManager.getCatalog).mockReturnValueOnce([
        {
          manifest: { displayName: 'Webhook' },
          instances: [{ id: 'wh-1', label: 'Deploy hooks' }],
        },
      ] as unknown as ReturnType<AdapterManager['getCatalog']>);
      const ok = await request(server)
        .post('/api/relay/adapters/wh-1/confirm-references')
        .send({ fingerprint: 'abc' });
      expect(ok.status).toBe(200);
      expect(vi.mocked(adapterManager.confirmReferences)).toHaveBeenCalledWith(
        'wh-1',
        'abc',
        false
      );

      const undoRefused = await request(server)
        .delete('/api/relay/adapters/wh-1/confirm-references')
        .set('X-DorkOS-Agent', 'agent-1');
      expect(undoRefused.status).toBe(403);
      const undo = await request(server).delete('/api/relay/adapters/wh-1/confirm-references');
      expect(undo.status).toBe(200);
      expect(vi.mocked(adapterManager.confirmReferences)).toHaveBeenLastCalledWith(
        'wh-1',
        null,
        true
      );
    });

    it('tells the manager an agent wrote it when the caller names an agent (DOR-3271)', async () => {
      // 'agent-1' resolves to no agent here, and the stranger-mark gate (on by default, DOR-4453)
      // refuses an unresolved agent header any typed secret. That gate is pinned in
      // relay-setting-step-up.test.ts; this case is about the writer label, so it runs with it off.
      await withStrangerMarkFlag(false, async () => {
        await request(server)
          .post('/api/relay/adapters')
          .set('X-DorkOS-Agent', 'agent-1')
          .send({
            type: 'webhook',
            id: 'wh-agent',
            config: { inbound: { subject: 'relay.webhook.agent', secret: 'secret-long-enough' } },
          });
        await request(server)
          .patch('/api/relay/adapters/wh-agent/config')
          .set('X-DorkOS-Agent', 'agent-1')
          .send({ config: { outbound: { url: 'https://example.com/x' } } });
      });

      expect(vi.mocked(adapterManager.addAdapter).mock.calls.at(-1)?.[5]).toBe('agent');
      expect(vi.mocked(adapterManager.updateConfig).mock.calls.at(-1)?.[2]).toBe('agent');
    });

    it('names the refused fields by key, never their values', async () => {
      vi.mocked(adapterManager.addAdapter).mockRejectedValue(
        new AdapterError('Field token is bad: tok-secret-1', 'INVALID_CONFIG', 'tg-main', ['token'])
      );

      const res = await request(server)
        .post('/api/relay/adapters')
        .send({ type: 'telegram', id: 'tg-main', config: { token: 'x', mode: 'polling' } });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'invalid_request', fields: ['token'] });
      expect(JSON.stringify(res.body)).not.toContain('tok-secret-1');
    });

    // Each AdapterError code maps to its own problem, with a fixed sentence:
    // the error's own message (which can name a field or value) stays in the log.
    it.each([
      ['DUPLICATE_ID', 409, 'connection_id_taken'],
      ['INVALID_CONFIG', 400, 'invalid_request'],
      ['MULTI_INSTANCE_DENIED', 400, 'invalid_request'],
      ['START_FAILED', 502, 'connection_saved_not_started'],
    ] as const)('answers %s with %i %s', async (code, status, problemCode) => {
      vi.mocked(adapterManager.addAdapter).mockRejectedValue(new AdapterError('refused', code));

      const res = await request(server)
        .post('/api/relay/adapters')
        .send({ type: 'telegram', id: 'tg-main', config: { token: 'x', mode: 'polling' } });

      expect(res.status).toBe(status);
      expect(res.body.code).toBe(problemCode);
      expect(res.body).not.toHaveProperty('error');
      expect(JSON.stringify(res.body)).not.toContain('refused');
    });
  });

  describe('DELETE /api/relay/adapters/:id', () => {
    it('removes it and forgets its history (DOR-2604)', async () => {
      const res = await request(server).delete('/api/relay/adapters/wh-github');

      expect(res.status).toBe(200);
      // A person removing a connection is the one removal that forgets its history.
      expect(vi.mocked(adapterManager.removeAdapter)).toHaveBeenCalledWith('wh-github', {
        forgetHistory: true,
      });
    });

    it('returns 400 for built-in claude-code', async () => {
      vi.mocked(adapterManager.removeAdapter).mockRejectedValue(
        new AdapterError('Cannot remove the built-in claude-code adapter', 'REMOVE_BUILTIN_DENIED')
      );

      const res = await request(server).delete('/api/relay/adapters/claude-code');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
    });
  });

  it('updates a config as a person', async () => {
    const res = await request(server)
      .patch('/api/relay/adapters/tg-main/config')
      .send({ config: { token: 'new-token', mode: 'webhook' } });

    expect(res.status).toBe(200);
    expect(vi.mocked(adapterManager.updateConfig)).toHaveBeenCalledWith(
      'tg-main',
      { token: 'new-token', mode: 'webhook' },
      'person'
    );
  });

  describe('POST /api/relay/adapters/test', () => {
    it.each([{ ok: true }, { ok: false, error: 'Connection refused' }])(
      'answers 200 with the outcome %j',
      async (outcome) => {
        vi.mocked(adapterManager.testConnection).mockResolvedValue(outcome);

        const res = await request(server)
          .post('/api/relay/adapters/test')
          .send({ type: 'telegram', config: { token: 'test-token', mode: 'polling' } });

        expect(res.status).toBe(200);
        expect(res.body).toEqual(outcome);
        expect(vi.mocked(adapterManager.testConnection)).toHaveBeenCalledWith(
          'telegram',
          { token: 'test-token', mode: 'polling' },
          'person'
        );
      }
    );
  });
});
