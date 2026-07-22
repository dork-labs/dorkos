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

// Preserve ConnectError (a real class the route branches on); mock the actions.
vi.mock('../../services/runtimes/connect/credentials.js', async (orig) => {
  const actual = await orig<typeof import('../../services/runtimes/connect/credentials.js')>();
  return { ...actual, storeRuntimeCredential: vi.fn(), storeProviderCredential: vi.fn() };
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
  pullOllamaModel: vi.fn(),
}));

import request from 'supertest';
import { createApp } from '../../app.js';
import { logger } from '../../lib/logger.js';
import {
  storeRuntimeCredential,
  storeProviderCredential,
  ConnectError,
} from '../../services/runtimes/connect/credentials.js';
import { delegateRuntimeLogin } from '../../services/runtimes/connect/delegated-login.js';
import {
  storeOpenRouterKeyReference,
  handleOpenRouterCallback,
  fetchOpenRouterModels,
  OpenRouterError,
} from '../../services/runtimes/opencode/openrouter.js';
import { detectOllama, pullOllamaModel } from '../../services/runtimes/opencode/ollama.js';
import type { OllamaPullResult } from '@dorkos/shared/runtime-connect';

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

  describe('POST /api/runtimes/opencode/provider/credential', () => {
    it('stores a provider key and returns ONLY the reference — never the secret', async () => {
      vi.mocked(storeProviderCredential).mockResolvedValue({ ref: 'file:openai' });
      const res = await request(app)
        .post('/api/runtimes/opencode/provider/credential')
        .send({ providerId: 'openai', secret: SECRET, baseURL: 'https://api.example.com/v1' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ref: 'file:openai' });
      expect(res.text).not.toContain(SECRET);
      expect(storeProviderCredential).toHaveBeenCalledWith({
        providerId: 'openai',
        secret: SECRET,
        baseURL: 'https://api.example.com/v1',
      });
    });

    it('defaults a missing baseURL to null', async () => {
      vi.mocked(storeProviderCredential).mockResolvedValue({ ref: 'file:openai' });
      await request(app)
        .post('/api/runtimes/opencode/provider/credential')
        .send({ providerId: 'openai', secret: SECRET });

      expect(storeProviderCredential).toHaveBeenCalledWith({
        providerId: 'openai',
        secret: SECRET,
        baseURL: null,
      });
    });

    it('maps a ConnectError to its status with an honest message', async () => {
      vi.mocked(storeProviderCredential).mockRejectedValue(
        new ConnectError('A provider id is required.', 400)
      );
      const res = await request(app)
        .post('/api/runtimes/opencode/provider/credential')
        .send({ providerId: 'x', secret: SECRET });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/provider id/);
      expect(res.text).not.toContain(SECRET);
    });

    it('rejects a request with no secret', async () => {
      const res = await request(app)
        .post('/api/runtimes/opencode/provider/credential')
        .send({ providerId: 'openai' });
      expect(res.status).toBe(400);
      expect(storeProviderCredential).not.toHaveBeenCalled();
    });

    it('rejects a non-loopback origin with 403 and never stores', async () => {
      const res = await request(app)
        .post('/api/runtimes/opencode/provider/credential')
        .set('Host', 'evil.example.com')
        .send({ providerId: 'openai', secret: SECRET });
      expect(res.status).toBe(403);
      expect(storeProviderCredential).not.toHaveBeenCalled();
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

    it('HTML-escapes the interpolated error so a value cannot inject markup', async () => {
      vi.mocked(handleOpenRouterCallback).mockResolvedValue({
        status: 'error',
        error: '<script>alert(1)</script>',
      });
      const res = await request(app)
        .get('/api/runtimes/opencode/openrouter/oauth/callback')
        .query({ state: 'bogus' });
      expect(res.status).toBe(400);
      // The raw tag never reaches the page; only its escaped form does.
      expect(res.text).not.toContain('<script>alert(1)</script>');
      expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
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
    it('returns detected running state + models with per-model fit verdicts', async () => {
      vi.mocked(detectOllama).mockResolvedValue({
        running: true,
        models: [{ name: 'qwen2.5-coder:7b', size: 4_700_000_000 }, { name: 'no-size-model' }],
      });
      const res = await request(app).get('/api/runtimes/opencode/ollama');
      expect(res.status).toBe(200);
      expect(res.body.running).toBe(true);
      expect(res.body.models).toEqual([
        { name: 'qwen2.5-coder:7b', size: 4_700_000_000 },
        { name: 'no-size-model' },
      ]);
      // Installed list carries an honest verdict per sized model; unsized ones are skipped.
      expect(res.body.installed).toHaveLength(1);
      expect(res.body.installed[0].id).toBe('qwen2.5-coder:7b');
      expect(res.body.installed[0].sizeBytes).toBe(4_700_000_000);
      expect(['runs-well', 'may-be-slow', 'too-large']).toContain(
        res.body.installed[0].assessment.verdict
      );
    });

    it('rejects a non-loopback origin with 403', async () => {
      const res = await request(app)
        .get('/api/runtimes/opencode/ollama')
        .set('Host', 'evil.example.com');
      expect(res.status).toBe(403);
      expect(detectOllama).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/runtimes/opencode/ollama/models', () => {
    it('returns the curated catalog assessed against this machine', async () => {
      const res = await request(app).get('/api/runtimes/opencode/ollama/models');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.models)).toBe(true);
      expect(res.body.models.length).toBeGreaterThanOrEqual(1);
      // Real hardware snapshot + honest per-model verdicts (static heuristic).
      expect(res.body.hardware.totalRamBytes).toBeGreaterThan(0);
      for (const entry of res.body.models) {
        expect(['runs-well', 'may-be-slow', 'too-large']).toContain(entry.verdict);
        expect(entry.explanation).toMatch(/estimate/i);
      }
    });

    it('rejects a non-loopback origin with 403', async () => {
      const res = await request(app)
        .get('/api/runtimes/opencode/ollama/models')
        .set('Host', 'evil.example.com');
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/runtimes/opencode/ollama/pull', () => {
    it('streams progress frames and a terminal result for a curated model', async () => {
      vi.mocked(pullOllamaModel).mockImplementation(async (model, onProgress) => {
        onProgress?.({ status: 'pulling manifest' });
        onProgress?.({ status: 'downloading', completed: 50, total: 100, percent: 50 });
        const result: OllamaPullResult = { ok: true, model };
        onProgress?.({ status: 'success' });
        return result;
      });

      const res = await request(app)
        .post('/api/runtimes/opencode/ollama/pull')
        .send({ model: 'qwen2.5-coder:7b' });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.text).toContain('event: progress');
      expect(res.text).toContain('event: result');
      expect(res.text).toContain('"ok":true');
      expect(res.text).toContain('qwen2.5-coder:7b');
      expect(pullOllamaModel).toHaveBeenCalledWith('qwen2.5-coder:7b', expect.any(Function));
    });

    it('defaults to the curated default model when none is named', async () => {
      vi.mocked(pullOllamaModel).mockResolvedValue({ ok: true, model: 'qwen2.5-coder:7b' });
      const res = await request(app).post('/api/runtimes/opencode/ollama/pull').send({});
      expect(res.status).toBe(200);
      expect(pullOllamaModel).toHaveBeenCalledWith('qwen2.5-coder:7b', expect.any(Function));
    });

    it('streams the honest error result when the pull fails', async () => {
      vi.mocked(pullOllamaModel).mockResolvedValue({
        ok: false,
        model: 'qwen2.5-coder:7b',
        error: 'Could not pull qwen2.5-coder:7b. Check that Ollama is running and try again.',
      });

      const res = await request(app)
        .post('/api/runtimes/opencode/ollama/pull')
        .send({ model: 'qwen2.5-coder:7b' });

      expect(res.status).toBe(200);
      expect(res.text).toContain('event: result');
      expect(res.text).toContain('"ok":false');
      expect(res.text).toContain('Could not pull');
    });

    it('accepts any syntactically valid tag, curated or not (pull-by-name)', async () => {
      vi.mocked(pullOllamaModel).mockResolvedValue({ ok: true, model: 'totally/uncurated:latest' });
      const res = await request(app)
        .post('/api/runtimes/opencode/ollama/pull')
        .send({ model: 'totally/uncurated:latest' });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(pullOllamaModel).toHaveBeenCalledWith(
        'totally/uncurated:latest',
        expect.any(Function)
      );
    });

    it('rejects a malformed tag with 400 and never triggers a pull', async () => {
      const res = await request(app)
        .post('/api/runtimes/opencode/ollama/pull')
        .send({ model: 'not a valid tag!' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/valid ollama model name/i);
      expect(pullOllamaModel).not.toHaveBeenCalled();
    });

    it('rejects a non-loopback origin with 403 and never pulls', async () => {
      const res = await request(app)
        .post('/api/runtimes/opencode/ollama/pull')
        .set('Host', 'evil.example.com')
        .send({ model: 'qwen2.5-coder:7b' });

      expect(res.status).toBe(403);
      expect(pullOllamaModel).not.toHaveBeenCalled();
    });
  });
});
