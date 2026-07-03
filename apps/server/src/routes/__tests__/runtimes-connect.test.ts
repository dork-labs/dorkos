import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Module mocks (never spawn/network/store for real through the route) -----

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: { status: { enabled: false, connected: false, url: null } },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

vi.mock('../../services/runtimes/opencode/provision.js', () => ({
  provisionOpenCode: vi.fn(),
}));

// Preserve ConnectError (a real class the route branches on); mock the action.
vi.mock('../../services/runtimes/connect/credentials.js', async (orig) => {
  const actual = await orig<typeof import('../../services/runtimes/connect/credentials.js')>();
  return { ...actual, storeRuntimeCredential: vi.fn() };
});

// Preserve LOGIN_RUNTIME_TYPES; mock the login action.
vi.mock('../../services/runtimes/connect/delegated-login.js', async (orig) => {
  const actual = await orig<typeof import('../../services/runtimes/connect/delegated-login.js')>();
  return { ...actual, delegateRuntimeLogin: vi.fn() };
});

// Preserve OpenRouterError, buildAuthorizeUrl, and the real flow store; mock the
// network-touching actions.
vi.mock('../../services/runtimes/opencode/openrouter.js', async (orig) => {
  const actual = await orig<typeof import('../../services/runtimes/opencode/openrouter.js')>();
  return {
    ...actual,
    storeOpenRouterKeyReference: vi.fn(),
    handleOpenRouterCallback: vi.fn(),
    fetchOpenRouterModels: vi.fn(),
  };
});

vi.mock('../../services/runtimes/opencode/ollama.js', () => ({
  detectOllama: vi.fn(),
}));

import request from 'supertest';
import { createApp } from '../../app.js';
import { logger } from '../../lib/logger.js';
import {
  storeRuntimeCredential,
  ConnectError,
} from '../../services/runtimes/connect/credentials.js';
import { delegateRuntimeLogin } from '../../services/runtimes/connect/delegated-login.js';
import {
  storeOpenRouterKeyReference,
  handleOpenRouterCallback,
  fetchOpenRouterModels,
  OpenRouterError,
} from '../../services/runtimes/opencode/openrouter.js';
import { detectOllama } from '../../services/runtimes/opencode/ollama.js';

const app = createApp();
const SECRET = 'sk-ant-secret-never-echo';

describe('runtime connect endpoints', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  describe('POST /api/runtimes/:type/credential', () => {
    it('stores a credential and returns ONLY the reference — never the secret, never a log line', async () => {
      const spies = [
        vi.spyOn(logger, 'error').mockImplementation(() => undefined as never),
        vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never),
        vi.spyOn(logger, 'info').mockImplementation(() => undefined as never),
        vi.spyOn(logger, 'debug').mockImplementation(() => undefined as never),
      ];
      vi.mocked(storeRuntimeCredential).mockResolvedValue({ ref: 'file:anthropic' });

      const res = await request(app)
        .post('/api/runtimes/claude-code/credential')
        .send({ secret: SECRET });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ref: 'file:anthropic' });
      expect(res.text).not.toContain(SECRET);
      // The secret reached the service (not dropped) …
      expect(storeRuntimeCredential).toHaveBeenCalledWith('claude-code', SECRET);
      // … but never appeared in any log line.
      for (const spy of spies) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(SECRET);
        }
      }
    });

    it('maps a ConnectError to its status with an honest message', async () => {
      vi.mocked(storeRuntimeCredential).mockRejectedValue(
        new ConnectError('"opencode" does not support a native API key.', 400)
      );
      const res = await request(app)
        .post('/api/runtimes/opencode/credential')
        .send({ secret: SECRET });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/native API key/);
      expect(res.text).not.toContain(SECRET);
    });

    it('rejects a request with no secret', async () => {
      const res = await request(app).post('/api/runtimes/codex/credential').send({});
      expect(res.status).toBe(400);
      expect(storeRuntimeCredential).not.toHaveBeenCalled();
    });

    it('rejects a non-loopback origin with 403 and never stores', async () => {
      const res = await request(app)
        .post('/api/runtimes/claude-code/credential')
        .set('Host', 'evil.example.com')
        .send({ secret: SECRET });
      expect(res.status).toBe(403);
      expect(storeRuntimeCredential).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/runtimes/:type/login', () => {
    it('delegates the vendor login and returns its completion result', async () => {
      vi.mocked(delegateRuntimeLogin).mockResolvedValue({ ok: true });
      const res = await request(app).post('/api/runtimes/codex/login');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(delegateRuntimeLogin).toHaveBeenCalledWith('codex');
    });

    it('surfaces an honest failure/timeout result', async () => {
      vi.mocked(delegateRuntimeLogin).mockResolvedValue({
        ok: false,
        error: 'Sign-in timed out. Please try again.',
      });
      const res = await request(app).post('/api/runtimes/claude-code/login');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: false, error: 'Sign-in timed out. Please try again.' });
    });

    it('rejects a runtime that does not support sign-in without spawning', async () => {
      const res = await request(app).post('/api/runtimes/opencode/login');
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(delegateRuntimeLogin).not.toHaveBeenCalled();
    });

    it('rejects a non-loopback origin with 403', async () => {
      const res = await request(app)
        .post('/api/runtimes/codex/login')
        .set('Host', 'evil.example.com');
      expect(res.status).toBe(403);
      expect(delegateRuntimeLogin).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/runtimes/opencode/openrouter/key', () => {
    it('stores a valid key and returns { ok: true } without echoing it', async () => {
      vi.mocked(storeOpenRouterKeyReference).mockResolvedValue({ ref: 'file:openrouter' });
      const res = await request(app)
        .post('/api/runtimes/opencode/openrouter/key')
        .send({ key: 'sk-or-valid' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(res.text).not.toContain('sk-or-valid');
    });

    it('returns an honest { ok: false } result for an invalid key', async () => {
      vi.mocked(storeOpenRouterKeyReference).mockRejectedValue(
        new OpenRouterError('That OpenRouter key was not accepted. Check it and try again.', 400)
      );
      const res = await request(app)
        .post('/api/runtimes/opencode/openrouter/key')
        .send({ key: 'bad' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: false, error: expect.stringContaining('not accepted') });
    });
  });

  describe('OpenRouter OAuth-PKCE', () => {
    it('starts a flow and returns the authorize URL + a pollable state', async () => {
      const res = await request(app).post('/api/runtimes/opencode/openrouter/oauth/start');
      expect(res.status).toBe(200);
      expect(res.body.state).toBeTruthy();
      const url = new URL(res.body.authorizeUrl);
      expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      // The callback URL round-trips the state so the loopback landing can match it.
      expect(url.searchParams.get('callback_url')).toContain(`state=${res.body.state}`);
    });

    it('polls a started flow as pending', async () => {
      const start = await request(app).post('/api/runtimes/opencode/openrouter/oauth/start');
      const res = await request(app)
        .get('/api/runtimes/opencode/openrouter/oauth/status')
        .query({ state: start.body.state });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'pending' });
    });

    it('renders a success page when the callback connected', async () => {
      vi.mocked(handleOpenRouterCallback).mockResolvedValue({ status: 'connected' });
      const res = await request(app)
        .get('/api/runtimes/opencode/openrouter/oauth/callback')
        .query({ state: 'abc', code: 'auth_code' });
      expect(res.status).toBe(200);
      expect(res.text).toContain('Connected');
      expect(handleOpenRouterCallback).toHaveBeenCalledWith({
        state: 'abc',
        code: 'auth_code',
        error: undefined,
      });
    });

    it('renders an error page when the callback failed', async () => {
      vi.mocked(handleOpenRouterCallback).mockResolvedValue({
        status: 'error',
        error: 'This sign-in link expired. Please try again.',
      });
      const res = await request(app)
        .get('/api/runtimes/opencode/openrouter/oauth/callback')
        .query({ state: 'bogus' });
      expect(res.status).toBe(400);
      expect(res.text).toContain('expired');
    });
  });

  describe('GET /api/runtimes/opencode/openrouter/models', () => {
    it('returns the catalog', async () => {
      vi.mocked(fetchOpenRouterModels).mockResolvedValue([
        { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
      ]);
      const res = await request(app).get('/api/runtimes/opencode/openrouter/models');
      expect(res.status).toBe(200);
      expect(res.body.models).toHaveLength(1);
    });
  });

  describe('GET /api/runtimes/opencode/ollama', () => {
    it('returns detected running state + models', async () => {
      vi.mocked(detectOllama).mockResolvedValue({
        running: true,
        models: [{ name: 'qwen2.5-coder:7b' }],
      });
      const res = await request(app).get('/api/runtimes/opencode/ollama');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ running: true, models: [{ name: 'qwen2.5-coder:7b' }] });
    });

    it('rejects a non-loopback origin with 403', async () => {
      const res = await request(app)
        .get('/api/runtimes/opencode/ollama')
        .set('Host', 'evil.example.com');
      expect(res.status).toBe(403);
      expect(detectOllama).not.toHaveBeenCalled();
    });
  });
});
