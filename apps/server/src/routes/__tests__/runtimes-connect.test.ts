vi.mock('../../services/runtimes/connect/signin-accounts.js', () => ({
  signinAccounts: () => [{ accountId: 'two', path: '/Users/x/.claude2', name: 'Claude2' }],
}));
vi.mock('../../services/core/auth/index.js', async (original) => ({
  ...(await original<typeof import('../../services/core/auth/index.js')>()),
  readOwnerAccount: () => ({ id: 'user_owner' }),
}));
import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Module mocks (never spawn/network/store for real through the route) -----

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: { status: { enabled: false, connected: false, url: null } },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

/**
 * A browser session the session gate can verify. Since ADR 261015-125850 rule 3
 * every request from another device needs a person session at the `/api`
 * gate, whatever "Ask for a password on this computer too" says; a remote case
 * presents one so it reaches the route, and the route's own "only on this
 * computer" rule is what is under test.
 */
const PERSON_SESSION = 'dorkos-test-session=person';

// Stood in at the gate's verifier step only: a request carrying the test
// session is the owner's browser session; everything else is the real gate.
vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/core/auth/session-gate.js')>();
  return {
    ...actual,
    decideSessionGate: async (...args: Parameters<typeof actual.decideSessionGate>) => {
      const [, , facts, access] = args;
      const cookie = facts.headers.cookie ?? '';
      if (access !== 'refused' && cookie.includes(PERSON_SESSION)) {
        return { allowed: true, user: { userId: 'user_owner', credential: 'cookie' } };
      }
      return actual.decideSessionGate(...args);
    },
  };
});

vi.mock('../../services/runtimes/opencode/providers/provision.js', () => ({
  provisionOpenCode: vi.fn(),
}));

// Preserve ConnectError (a real class the route branches on); mock the actions.
vi.mock('../../services/runtimes/connect/credentials.js', async (orig) => {
  const actual = await orig<typeof import('../../services/runtimes/connect/credentials.js')>();
  return {
    ...actual,
    storeRuntimeCredential: vi.fn(),
    storeProviderCredential: vi.fn(),
    readOpenCodeDirectSetup: vi.fn(),
    readRuntimeKeyStatus: vi.fn(),
    checkProviderCredential: vi.fn(),
    checkRuntimeCredential: vi.fn(),
  };
});

// Preserve LOGIN_RUNTIME_TYPES; mock the login action.
vi.mock('../../services/runtimes/connect/delegated-login.js', async (orig) => {
  const actual = await orig<typeof import('../../services/runtimes/connect/delegated-login.js')>();
  return { ...actual, delegateRuntimeLogin: vi.fn() };
});

// The session→account resolution is its own unit; here we only pin how the
// route USES it (precedence, and the fall-through when it has no answer).
vi.mock('../../services/runtimes/connect/resolve-session-account.js', () => ({
  resolveAccountRootForSession: vi.fn(),
}));

// Preserve OpenRouterError, buildAuthorizeUrl, and the real flow store; mock the
// network-touching actions.
vi.mock('../../services/runtimes/opencode/providers/openrouter.js', async (orig) => {
  const actual =
    await orig<typeof import('../../services/runtimes/opencode/providers/openrouter.js')>();
  return {
    ...actual,
    storeOpenRouterKeyReference: vi.fn(),
    handleOpenRouterCallback: vi.fn(),
  };
});

vi.mock('../../services/runtimes/opencode/providers/ollama.js', () => ({
  detectOllama: vi.fn(),
  pullOllamaModel: vi.fn(),
}));

vi.mock('../../services/core/cloud/credits-models.js', () => ({
  creditsModelsFor: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../services/core/cloud/credits-inference.js', () => ({
  heldCreditsToken: vi.fn().mockReturnValue(null),
}));
vi.mock('../../services/runtimes/connect/doe-credentials.js', () => ({
  storeDoeCredential: vi.fn(),
}));
import { storeDoeCredential } from '../../services/runtimes/connect/doe-credentials.js';
import { configManager } from '../../services/core/config-manager.js';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
import request from '@dorkos/test-utils/supertest';
import type { Server } from 'node:http';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { composedListener } from '../../http/__tests__/composed-listener.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { createRuntimesRoutes } from '../runtimes.js';
import { logger } from '../../lib/logger.js';
import {
  storeRuntimeCredential,
  storeProviderCredential,
  readOpenCodeDirectSetup,
  readRuntimeKeyStatus,
  checkProviderCredential,
  checkRuntimeCredential,
} from '../../services/runtimes/connect/credentials.js';
import { ConnectError } from '../../services/runtimes/connect/connect-error.js';
import { delegateRuntimeLogin } from '../../services/runtimes/connect/delegated-login.js';
import { resolveAccountRootForSession } from '../../services/runtimes/connect/resolve-session-account.js';
import {
  storeOpenRouterKeyReference,
  handleOpenRouterCallback,
  OpenRouterError,
} from '../../services/runtimes/opencode/providers/openrouter.js';
import {
  detectOllama,
  pullOllamaModel,
} from '../../services/runtimes/opencode/providers/ollama.js';
import type { OllamaPullResult } from '@dorkos/shared/runtime-connect';
import { signInLandings } from '../../services/core/sign-in-landing/sign-in-landings.js';

const admission = new MainRequestAdmission();
const app = composedListener(admission);

/**
 * ONE listener for the whole file (DOR-483). Requests target `server`, never
 * `app`: handed a non-listening app supertest binds and frees an ephemeral port
 * per request, and a pooled keep-alive socket for a reclaimed port lands on the
 * wrong server. See {@link listeningServer}.
 */
const server = listeningServer(app);

const SECRET = 'sk-ant-secret-never-echo';

/** The TCP peer `peerApp` reports for the current test; set by `appWithPeer`. */
let currentPeer = '127.0.0.1';

/** The real runtimes routes behind the `/api` chain, with the TCP peer rewritten first. */
const peerRoutes = honoGroupListener({ path: '/api/runtimes', routes: createRuntimesRoutes() });
const peerServer = listeningServer((req, res) => {
  Object.defineProperty(req.socket, 'remoteAddress', { value: currentPeer, configurable: true });
  peerRoutes(req, res);
});

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

      const res = await request(server)
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
      const res = await request(server)
        .post('/api/runtimes/opencode/credential')
        .send({ secret: SECRET });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/native API key/);
      expect(res.text).not.toContain(SECRET);
    });

    it('rejects a request with no secret', async () => {
      const res = await request(server).post('/api/runtimes/codex/credential').send({});
      expect(res.status).toBe(400);
      expect(storeRuntimeCredential).not.toHaveBeenCalled();
    });

    it('rejects a non-loopback origin with 403 and never stores', async () => {
      const res = await request(server)
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
      const res = await request(server)
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
      await request(server)
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
      const res = await request(server)
        .post('/api/runtimes/opencode/provider/credential')
        .send({ providerId: 'x', secret: SECRET });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/provider id/);
      expect(res.text).not.toContain(SECRET);
    });

    it('rejects a request with no secret', async () => {
      const res = await request(server)
        .post('/api/runtimes/opencode/provider/credential')
        .send({ providerId: 'openai' });
      expect(res.status).toBe(400);
      expect(storeProviderCredential).not.toHaveBeenCalled();
    });

    it('rejects a non-loopback origin with 403 and never stores', async () => {
      const res = await request(server)
        .post('/api/runtimes/opencode/provider/credential')
        .set('Host', 'evil.example.com')
        .send({ providerId: 'openai', secret: SECRET });
      expect(res.status).toBe(403);
      expect(storeProviderCredential).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/runtimes/opencode/provider — the form remembers (DOR-2123)', () => {
    it('returns the saved service, base URL, and only the last four of the key', async () => {
      vi.mocked(readOpenCodeDirectSetup).mockResolvedValue({
        providerId: 'openai',
        baseURL: 'https://api.example.com/v1',
        key: { saved: true, last4: 'ab12' },
      });

      const res = await request(server).get('/api/runtimes/opencode/provider');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        providerId: 'openai',
        baseURL: 'https://api.example.com/v1',
        key: { saved: true, last4: 'ab12' },
      });
      // Assert on the SERIALIZED body: a hint is four characters, never a key.
      expect(res.text).not.toContain(SECRET);
    });

    it('answers a generic 500 when the store cannot be read, leaking no detail', async () => {
      const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
      vi.mocked(readOpenCodeDirectSetup).mockRejectedValue(new Error('/Users/someone/.dork boom'));

      const res = await request(server).get('/api/runtimes/opencode/provider');

      expect(res.status).toBe(500);
      expect(res.text).not.toContain('/Users/someone');
      spy.mockRestore();
    });
  });

  describe('POST /api/runtimes/opencode/provider/credential/check', () => {
    it('answers 200 with the refusal when the key is not accepted — a "no" is not an error', async () => {
      vi.mocked(checkProviderCredential).mockResolvedValue({
        ok: false,
        reason: 'rejected',
        message: 'That key was not accepted. Check it and try again.',
      });

      const res = await request(server)
        .post('/api/runtimes/opencode/provider/credential/check')
        .send({ providerId: 'openai', secret: SECRET, baseURL: null });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: false,
        reason: 'rejected',
        message: 'That key was not accepted. Check it and try again.',
      });
      expect(res.text).not.toContain(SECRET);
    });

    it('passes a missing secret through as null, so the SAVED key is checked', async () => {
      vi.mocked(checkProviderCredential).mockResolvedValue({ ok: true });

      const res = await request(server)
        .post('/api/runtimes/opencode/provider/credential/check')
        .send({ providerId: 'openai' });

      expect(res.status).toBe(200);
      expect(checkProviderCredential).toHaveBeenCalledWith({
        providerId: 'openai',
        secret: null,
        baseURL: null,
      });
    });

    it('maps a ConnectError to its status — an unknown service is a 400, not a "no"', async () => {
      vi.mocked(checkProviderCredential).mockRejectedValue(
        new ConnectError('DorkOS can’t pass a key to "Valut Cloud".', 400)
      );

      const res = await request(server)
        .post('/api/runtimes/opencode/provider/credential/check')
        .send({ providerId: 'Valut Cloud', secret: SECRET });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Valut Cloud/);
      expect(res.text).not.toContain(SECRET);
    });

    it('rejects a request with no service id', async () => {
      const res = await request(server)
        .post('/api/runtimes/opencode/provider/credential/check')
        .send({ secret: SECRET });
      expect(res.status).toBe(400);
      expect(checkProviderCredential).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/runtimes/opencode/provider/credential — an empty key keeps the saved one', () => {
    it('forwards an empty secret rather than refusing it at the schema', async () => {
      vi.mocked(storeProviderCredential).mockResolvedValue({ ref: 'file:openai' });

      const res = await request(server)
        .post('/api/runtimes/opencode/provider/credential')
        .send({ providerId: 'openai', secret: '', baseURL: 'https://moved.example.com/v1' });

      expect(res.status).toBe(200);
      expect(storeProviderCredential).toHaveBeenCalledWith({
        providerId: 'openai',
        secret: '',
        baseURL: 'https://moved.example.com/v1',
      });
    });
  });

  describe('GET /api/runtimes/:type/credential', () => {
    it('reports a saved key by its last four characters only', async () => {
      vi.mocked(readRuntimeKeyStatus).mockResolvedValue({ key: { saved: true, last4: 'cho1' } });

      const res = await request(server).get('/api/runtimes/claude-code/credential');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ key: { saved: true, last4: 'cho1' } });
      expect(res.text).not.toContain(SECRET);
    });

    it('maps a ConnectError for a runtime with no key of its own', async () => {
      vi.mocked(readRuntimeKeyStatus).mockRejectedValue(
        new ConnectError('"opencode" does not support a native API key.', 400)
      );
      const res = await request(server).get('/api/runtimes/opencode/credential');
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/runtimes/:type/credential/check', () => {
    it('answers 200 with the refusal and never echoes the key', async () => {
      vi.mocked(checkRuntimeCredential).mockResolvedValue({
        ok: false,
        reason: 'unreachable',
        message: 'Couldn’t reach api.anthropic.com. Check the base URL and whether you’re online.',
      });

      const res = await request(server)
        .post('/api/runtimes/claude-code/credential/check')
        .send({ secret: SECRET });

      expect(res.status).toBe(200);
      expect(res.body.reason).toBe('unreachable');
      expect(res.text).not.toContain(SECRET);
      expect(checkRuntimeCredential).toHaveBeenCalledWith('claude-code', SECRET);
    });

    it('passes a missing secret through as null (Express 5 leaves an empty body undefined)', async () => {
      vi.mocked(checkRuntimeCredential).mockResolvedValue({ ok: true });
      const res = await request(server).post('/api/runtimes/claude-code/credential/check');
      expect(res.status).toBe(200);
      expect(checkRuntimeCredential).toHaveBeenCalledWith('claude-code', null);
    });

    it('maps a ConnectError to its status', async () => {
      vi.mocked(checkRuntimeCredential).mockRejectedValue(
        new ConnectError('Paste the key to check it.', 400)
      );
      const res = await request(server).post('/api/runtimes/codex/credential/check').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Paste the key to check it.');
    });
  });

  describe('POST /api/runtimes/:type/login', () => {
    it('keeps Codex login unchanged', async () => {
      vi.mocked(delegateRuntimeLogin).mockResolvedValue({ ok: true });
      expect((await request(server).post('/api/runtimes/codex/login')).status).toBe(200);
      expect(delegateRuntimeLogin).toHaveBeenCalledWith('codex', { accountRoot: undefined });
    });
    it('resolves an account ID to its own registered folder', async () => {
      vi.mocked(delegateRuntimeLogin).mockResolvedValue({ ok: true });
      const res = await request(server)
        .post('/api/runtimes/claude-code/login')
        .set('Cookie', PERSON_SESSION)
        .send({ accountId: 'two' });
      expect(res.status).toBe(200);
      expect(delegateRuntimeLogin).toHaveBeenCalledWith('claude-code', {
        accountRoot: '/Users/x/.claude2',
      });
    });
    it.each([{}, { accountId: 'unknown' }, { accountRoot: '/etc/passwd' }, { accountId: 42 }])(
      'refuses an absent, unknown or path target: %j',
      async (body) => {
        const res = await request(server)
          .post('/api/runtimes/claude-code/login')
          .set('Cookie', PERSON_SESSION)
          .send(body);
        expect(res.status).toBe(400);
        expect(delegateRuntimeLogin).not.toHaveBeenCalled();
      }
    );
    it('does not fall back when a session is unresolved', async () => {
      vi.mocked(resolveAccountRootForSession).mockResolvedValue(undefined);
      const res = await request(server)
        .post('/api/runtimes/claude-code/login')
        .set('Cookie', PERSON_SESSION)
        .send({ sessionId: 'unknown', accountId: 'two' });
      expect(res.status).toBe(400);
      expect(delegateRuntimeLogin).not.toHaveBeenCalled();
    });
    it('resolves a session from server records', async () => {
      vi.mocked(delegateRuntimeLogin).mockResolvedValue({ ok: true });
      vi.mocked(resolveAccountRootForSession).mockResolvedValue('/Users/x/.claude2');
      const res = await request(server)
        .post('/api/runtimes/claude-code/login')
        .set('Cookie', PERSON_SESSION)
        .send({ sessionId: 'known' });
      expect(res.status).toBe(200);
      expect(delegateRuntimeLogin).toHaveBeenCalledWith('claude-code', {
        accountRoot: '/Users/x/.claude2',
      });
    });
    it('refuses an agent even with an owner cookie', async () => {
      const res = await request(server)
        .post('/api/runtimes/claude-code/login')
        .set('Cookie', PERSON_SESSION)
        .set('X-DorkOS-Agent', 'agent')
        .send({ accountId: 'two' });
      expect(res.status).toBe(403);
      expect(delegateRuntimeLogin).not.toHaveBeenCalled();
    });
    it('refuses an agent: only the person at this computer starts a sign-in', async () => {
      expect(
        (
          await request(server)
            .post('/api/runtimes/claude-code/login')
            .set('X-DorkOS-Agent', 'agent-1')
            .send({ accountId: 'two' })
        ).status
      ).toBe(403);
      expect(delegateRuntimeLogin).not.toHaveBeenCalled();
    });
    it("refuses the owner's own session from another device (Security S3)", async () => {
      // The sign-in opens a browser on this computer, so a cookie from a phone
      // or a laptop on the LAN may not start one, however valid it is.
      currentPeer = '192.168.86.200';
      const fromLan = await request(peerServer)
        .post('/api/runtimes/claude-code/login')
        .set('Host', 'localhost')
        .set('Cookie', PERSON_SESSION)
        .send({ accountId: 'two' });
      expect(fromLan.status).toBe(403);
      const elsewhere = await request(server)
        .post('/api/runtimes/claude-code/login')
        .set('Host', 'evil.example.com')
        .set('Cookie', PERSON_SESSION)
        .send({ accountId: 'two' });
      expect(elsewhere.status).toBe(403);
      expect(delegateRuntimeLogin).not.toHaveBeenCalled();
    });
    it('control: the owner at this computer starts the sign-in', async () => {
      vi.mocked(delegateRuntimeLogin).mockResolvedValue({ ok: true });
      currentPeer = '127.0.0.1';
      const res = await request(peerServer)
        .post('/api/runtimes/claude-code/login')
        .set('Host', 'localhost')
        .set('Cookie', PERSON_SESSION)
        .send({ accountId: 'two' });
      expect(res.status).toBe(200);
      expect(delegateRuntimeLogin).toHaveBeenCalledTimes(1);
    });
    it('passes on the confirmed identity, or an honest refusal for a ruled-out organization', async () => {
      vi.mocked(delegateRuntimeLogin).mockResolvedValue({
        ok: false,
        identity: { state: 'blocked' },
        error: 'This sign-in is in an organization you ruled out.',
      });
      const res = await request(server)
        .post('/api/runtimes/claude-code/login')
        .set('Cookie', PERSON_SESSION)
        .send({ accountId: 'two' });
      expect(res.body).toMatchObject({ ok: false, identity: { state: 'blocked' } });
    });
  });

  describe('POST /api/runtimes/opencode/openrouter/key', () => {
    it('stores a valid key and returns { ok: true } without echoing it', async () => {
      vi.mocked(storeOpenRouterKeyReference).mockResolvedValue({ ref: 'file:openrouter' });
      const res = await request(server)
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
      const res = await request(server)
        .post('/api/runtimes/opencode/openrouter/key')
        .send({ key: 'bad' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: false, error: expect.stringContaining('not accepted') });
    });
  });

  describe('OpenRouter OAuth-PKCE', () => {
    it('starts a flow and returns the authorize URL + a pollable state', async () => {
      const res = await request(server).post('/api/runtimes/opencode/openrouter/oauth/start');
      expect(res.status).toBe(200);
      expect(res.body.state).toBeTruthy();
      const url = new URL(res.body.authorizeUrl);
      expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      // The callback URL round-trips the state so the loopback landing can match it.
      expect(url.searchParams.get('callback_url')).toContain(`state=${res.body.state}`);
    });

    it('polls a started flow as pending', async () => {
      const start = await request(server).post('/api/runtimes/opencode/openrouter/oauth/start');
      const res = await request(server)
        .get('/api/runtimes/opencode/openrouter/oauth/status')
        .query({ state: start.body.state });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'pending' });
    });

    /** The landing record a callback's redirect points at. */
    function landingFrom(location: string) {
      const id = new URL(location, 'http://localhost').searchParams.get('landing') ?? '';
      const landing = signInLandings.get(id);
      if (!landing) throw new Error(`no landing for ${location}`);
      return landing;
    }

    it('redirects a connected callback to the app’s landing page', async () => {
      vi.mocked(handleOpenRouterCallback).mockResolvedValue({ status: 'connected' });
      const res = await request(server)
        .get('/api/runtimes/opencode/openrouter/oauth/callback')
        .query({ state: 'abc', code: 'auth_code' });
      expect(res.status).toBe(303);
      expect(res.headers.location).toMatch(/\/signed-in\?landing=[A-Za-z0-9_-]+$/);
      expect(res.headers.location).not.toContain('auth_code');
      expect(landingFrom(res.headers.location)).toMatchObject({
        service: 'openrouter',
        serviceName: 'OpenRouter',
        status: 'connected',
        canRetry: false,
      });
      expect(handleOpenRouterCallback).toHaveBeenCalledWith({
        state: 'abc',
        code: 'auth_code',
        error: undefined,
      });
    });

    it('finishes when the OpenRouter page is the Referer, as a real redirect sends it', async () => {
      vi.mocked(handleOpenRouterCallback).mockResolvedValue({ status: 'connected' });
      const res = await request(server)
        .get('/api/runtimes/opencode/openrouter/oauth/callback')
        .query({ state: 'abc', code: 'auth_code' })
        .set('Referer', 'https://openrouter.ai/');
      expect(res.status).toBe(303);
      expect(landingFrom(res.headers.location).status).toBe('connected');
    });

    it('records an expired link, and Try again mints a fresh sign-in link', async () => {
      vi.mocked(handleOpenRouterCallback).mockResolvedValue({
        status: 'error',
        error: 'This sign-in link expired. Please try again.',
      });
      const res = await request(server)
        .get('/api/runtimes/opencode/openrouter/oauth/callback')
        .query({ state: 'bogus' });
      expect(res.status).toBe(303);
      const landing = landingFrom(res.headers.location);
      expect(landing).toMatchObject({ status: 'failed', reason: 'expired', canRetry: true });
      const retried = await signInLandings.retry(landing.id);
      expect(retried?.kind).toBe('authorize');
    });

    it('never carries the failure’s own words to the page', async () => {
      vi.mocked(handleOpenRouterCallback).mockResolvedValue({
        status: 'error',
        error: '<script>alert(1)</script>',
      });
      const res = await request(server)
        .get('/api/runtimes/opencode/openrouter/oauth/callback')
        .query({ state: 'bogus', code: 'x' });
      const landing = landingFrom(res.headers.location);
      // The page words a reason code itself; no server sentence reaches it.
      expect(landing.reason).toBe('failed');
      expect(JSON.stringify(landing)).not.toContain('script');
    });
  });

  describe('GET /api/runtimes/opencode/ollama', () => {
    it('returns detected running state + models with per-model fit verdicts', async () => {
      vi.mocked(detectOllama).mockResolvedValue({
        running: true,
        models: [{ name: 'qwen2.5-coder:7b', size: 4_700_000_000 }, { name: 'no-size-model' }],
      });
      const res = await request(server).get('/api/runtimes/opencode/ollama');
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
      const res = await request(server)
        .get('/api/runtimes/opencode/ollama')
        .set('Host', 'evil.example.com');
      expect(res.status).toBe(403);
      expect(detectOllama).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/runtimes/opencode/ollama/models', () => {
    it('returns the curated catalog assessed against this machine', async () => {
      const res = await request(server).get('/api/runtimes/opencode/ollama/models');
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
      const res = await request(server)
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

      const res = await request(server)
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
      const res = await request(server).post('/api/runtimes/opencode/ollama/pull').send({});
      expect(res.status).toBe(200);
      expect(pullOllamaModel).toHaveBeenCalledWith('qwen2.5-coder:7b', expect.any(Function));
    });

    it('streams the honest error result when the pull fails', async () => {
      vi.mocked(pullOllamaModel).mockResolvedValue({
        ok: false,
        model: 'qwen2.5-coder:7b',
        error: 'Could not pull qwen2.5-coder:7b. Check that Ollama is running and try again.',
      });

      const res = await request(server)
        .post('/api/runtimes/opencode/ollama/pull')
        .send({ model: 'qwen2.5-coder:7b' });

      expect(res.status).toBe(200);
      expect(res.text).toContain('event: result');
      expect(res.text).toContain('"ok":false');
      expect(res.text).toContain('Could not pull');
    });

    it('accepts any syntactically valid tag, curated or not (pull-by-name)', async () => {
      vi.mocked(pullOllamaModel).mockResolvedValue({ ok: true, model: 'totally/uncurated:latest' });
      const res = await request(server)
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
      const res = await request(server)
        .post('/api/runtimes/opencode/ollama/pull')
        .send({ model: 'not a valid tag!' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/valid ollama model name/i);
      expect(pullOllamaModel).not.toHaveBeenCalled();
    });

    it('rejects a non-loopback origin with 403 and never pulls', async () => {
      const res = await request(server)
        .post('/api/runtimes/opencode/ollama/pull')
        .set('Host', 'evil.example.com')
        .send({ model: 'qwen2.5-coder:7b' });

      expect(res.status).toBe(403);
      expect(pullOllamaModel).not.toHaveBeenCalled();
    });
  });

  /**
   * Every route in this file calls `rejectNonLoopback`, and until now nothing
   * would have noticed if one stopped. The existing `Host: evil.example.com`
   * cases do not cover it: the `/api` host guard answers those at the app edge,
   * so the request never reaches the route's own gate. Mutation-testing found
   * this — forcing `isLocalRequest` to `true` left this whole file green
   * (DOR-532 final review).
   *
   * A non-loopback TCP peer with a LOOPBACK `Host` is the shape that isolates the
   * route gate: the host guard admits it, and only `rejectNonLoopback` can turn it
   * away. These are the routes that accept secrets, so a silent regression here is
   * the one worth catching.
   */
  describe('locality gate on the credential + connect routes', () => {
    /**
     * Point the peer server's rewrite at `peer` and return that server.
     *
     * A SECOND listener, bound once alongside the main one and never rebound
     * (DOR-483). It gets its own rather than sharing, because the middleware
     * below redefines `remoteAddress` on the live socket: under keep-alive the
     * socket outlives the request, so a poisoned peer would follow it onto the
     * NEXT request. Keeping the rewrite on a dedicated listener means every
     * request that reaches a poisoned socket passes through the middleware that
     * overwrites it first.
     *
     * @param peer - The TCP peer address every request should appear to come from.
     * @returns The peer server, listening and rewriting to `peer`.
     */
    function appWithPeer(peer: string): Server {
      currentPeer = peer;
      return peerServer;
    }

    /** The LAN peer that defeated the header-only check, per the DOR-532 probes. */
    const REMOTE_PEER = '192.168.86.200';

    const ROUTES: Array<{
      name: string;
      method: 'get' | 'post';
      path: string;
      body?: Record<string, unknown>;
      /** The action that must never run. */
      action?: () => unknown;
      /** Whether the request body carries a secret that must not be echoed. */
      carriesSecret?: boolean;
    }> = [
      {
        name: 'POST /:type/credential',
        method: 'post',
        path: '/api/runtimes/claude-code/credential',
        body: { secret: SECRET },
        action: () => storeRuntimeCredential,
        carriesSecret: true,
      },
      {
        name: 'POST /opencode/provider/credential',
        method: 'post',
        path: '/api/runtimes/opencode/provider/credential',
        body: { providerId: 'anthropic', secret: SECRET },
        action: () => storeProviderCredential,
        carriesSecret: true,
      },
      {
        name: 'GET /opencode/provider',
        method: 'get',
        path: '/api/runtimes/opencode/provider',
        action: () => readOpenCodeDirectSetup,
      },
      {
        name: 'POST /opencode/provider/credential/check',
        method: 'post',
        path: '/api/runtimes/opencode/provider/credential/check',
        body: { providerId: 'openai', secret: SECRET },
        action: () => checkProviderCredential,
        carriesSecret: true,
      },
      {
        name: 'GET /:type/credential',
        method: 'get',
        path: '/api/runtimes/claude-code/credential',
        action: () => readRuntimeKeyStatus,
      },
      {
        name: 'POST /:type/credential/check',
        method: 'post',
        path: '/api/runtimes/claude-code/credential/check',
        body: { secret: SECRET },
        action: () => checkRuntimeCredential,
        carriesSecret: true,
      },
      {
        name: 'POST /codex/login',
        method: 'post',
        path: '/api/runtimes/codex/login',
        body: {},
        action: () => delegateRuntimeLogin,
      },
      {
        name: 'POST /opencode/openrouter/key',
        method: 'post',
        path: '/api/runtimes/opencode/openrouter/key',
        body: { key: SECRET },
        action: () => storeOpenRouterKeyReference,
        carriesSecret: true,
      },
      {
        name: 'POST /opencode/openrouter/oauth/start',
        method: 'post',
        path: '/api/runtimes/opencode/openrouter/oauth/start',
        body: {},
      },
      {
        name: 'GET /opencode/openrouter/oauth/status',
        method: 'get',
        path: '/api/runtimes/opencode/openrouter/oauth/status',
      },
      {
        name: 'GET /opencode/ollama',
        method: 'get',
        path: '/api/runtimes/opencode/ollama',
        action: () => detectOllama,
      },
      {
        name: 'GET /opencode/ollama/models',
        method: 'get',
        path: '/api/runtimes/opencode/ollama/models',
      },
      {
        name: 'POST /opencode/ollama/pull',
        method: 'post',
        path: '/api/runtimes/opencode/ollama/pull',
        body: { model: 'qwen2.5-coder:7b' },
        action: () => pullOllamaModel,
      },
    ];

    it.each(ROUTES)('refuses $name from a non-loopback peer', async (route) => {
      const req = request(appWithPeer(REMOTE_PEER))
        [route.method](route.path)
        .set('Host', 'localhost')
        .set('Cookie', PERSON_SESSION);
      const res = await (route.body ? req.send(route.body) : req);

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/locally/i);
      if (route.action) expect(route.action()).not.toHaveBeenCalled();
      if (route.carriesSecret) expect(JSON.stringify(res.body)).not.toContain(SECRET);
    });

    it.each(ROUTES)(
      'refuses $name from a non-loopback peer with no session at the /api gate',
      async (route) => {
        // Another device always needs a person session (ADR 261015-125850
        // rule 3), with the this-computer password off, as here.
        const req = request(appWithPeer(REMOTE_PEER))
          [route.method](route.path)
          .set('Host', 'localhost');
        const res = await (route.body ? req.send(route.body) : req);

        expect(res.status).toBe(401);
        if (route.action) expect(route.action()).not.toHaveBeenCalled();
        if (route.carriesSecret) expect(JSON.stringify(res.body)).not.toContain(SECRET);
      }
    );

    it.each(ROUTES)('still admits $name from a loopback peer', async (route) => {
      const req = request(appWithPeer('127.0.0.1'))
        [route.method](route.path)
        .set('Host', 'localhost');
      const res = await (route.body ? req.send(route.body) : req);

      // The gate is what is under test, not each route's own outcome — a handler
      // may still 400 on a stub'd dependency. Anything but the locality refusal
      // proves the request got past it.
      expect(res.status).not.toBe(403);
    });
  });
});

describe('DorkOS inference setup', () => {
  const inference = {
    source: 'api-key',
    provider: 'openai',
    protocol: 'openai-chat-completions',
    endpoint: 'https://api.openai.com/v1',
    model: 'test-model',
    contextWindow: 8192,
    maxOutputTokens: 1024,
  };
  beforeEach(() => vi.clearAllMocks());
  it('reads only the requested credits catalog format and refuses invalid protocols', async () => {
    const response = await request(server).get(
      '/api/runtimes/doe/credits-models?protocol=openai-responses'
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ endpoint: null, models: [] });
    expect(
      (await request(server).get('/api/runtimes/doe/credits-models?protocol=other')).status
    ).toBe(400);
  });
  it('saves a key through encrypted setup without echoing any secret or reference', async () => {
    vi.mocked(storeDoeCredential).mockResolvedValue({
      ...inference,
      source: 'api-key',
      protocol: 'openai-chat-completions',
      credentialRef: 'file:test-only',
    });
    const response = await request(server)
      .post('/api/runtimes/doe/credential')
      .send({ inference, secret: SECRET });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, hasKey: true });
    expect(response.text).not.toContain(SECRET);
    expect(response.text).not.toContain('file:');
  });
  it('returns metadata and key presence, with no reference or resolved credential', async () => {
    const config = UserConfigSchema.parse({ version: 1 });
    config.runtimes.doe.inference = {
      ...inference,
      source: 'api-key',
      protocol: 'openai-chat-completions',
      credentialRef: 'env:PRIVATE_TEST_KEY',
      credentialEndpoint: inference.endpoint,
    };
    vi.mocked(configManager.get).mockImplementation((key) => config[key] as never);
    const response = await request(server).get('/api/runtimes/doe/inference');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ inference, hasKey: true, autoProtocol: null });
    expect(response.text).not.toContain('PRIVATE_TEST_KEY');
  });
  it('preserves a same-endpoint key on metadata changes and drops it on an endpoint change', async () => {
    const config = UserConfigSchema.parse({ version: 1 });
    config.runtimes.doe.inference = {
      ...inference,
      source: 'api-key',
      protocol: 'openai-chat-completions',
      credentialRef: 'env:PRIVATE_TEST_KEY',
      credentialEndpoint: inference.endpoint,
    };
    vi.mocked(configManager.get).mockImplementation((key) => config[key] as never);
    expect(
      (
        await request(server)
          .put('/api/runtimes/doe/inference')
          .send({ ...inference, model: 'next-model' })
      ).status
    ).toBe(200);
    expect(vi.mocked(configManager.set).mock.lastCall?.[1]).toMatchObject({
      doe: { inference: { credentialRef: 'env:PRIVATE_TEST_KEY' } },
    });
    expect(
      (
        await request(server)
          .put('/api/runtimes/doe/inference')
          .send({ ...inference, endpoint: 'https://example.com/v1' })
      ).status
    ).toBe(200);
    expect(
      (vi.mocked(configManager.set).mock.lastCall?.[1] as typeof config.runtimes).doe.inference
    ).not.toHaveProperty('credentialRef');
  });
  it('refuses a remote peer before encrypted setup runs', async () => {
    currentPeer = '203.0.113.10';
    try {
      const res = await request(peerServer)
        .post('/api/runtimes/doe/credential')
        .set('Cookie', PERSON_SESSION)
        .send({ inference, secret: SECRET });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/only available on this computer/);
      expect(storeDoeCredential).not.toHaveBeenCalled();
    } finally {
      currentPeer = '127.0.0.1';
    }
  });
});
