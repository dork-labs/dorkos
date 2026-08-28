import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RuntimeProvisionResult } from '@dorkos/shared/transport';

// Mock the provisioning services — never run a real install through the route.
vi.mock('../../services/runtimes/opencode/providers/provision.js', () => ({
  provisionOpenCode: vi.fn(),
}));

vi.mock('../../services/runtimes/codex/provision.js', () => ({
  provisionCodex: vi.fn(),
}));

vi.mock('../../services/runtimes/claude-code/tooling/provision.js', () => ({
  provisionClaudeCode: vi.fn(),
}));

vi.mock('../../services/runtimes/opencode/providers/ollama-provision.js', () => ({
  provisionOllama: vi.fn(),
  detectOllamaInstallMethod: vi.fn().mockResolvedValue('manual'),
}));

const mockTunnelManager = vi.hoisted(() => ({
  status: { enabled: false, connected: false, url: null as string | null },
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({ tunnelManager: mockTunnelManager }));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import express from 'express';
import request from 'supertest';
import { createApp } from '../../app.js';
import runtimesRouter from '../runtimes.js';
import { provisionOpenCode } from '../../services/runtimes/opencode/providers/provision.js';
import { provisionCodex } from '../../services/runtimes/codex/provision.js';
import { provisionClaudeCode } from '../../services/runtimes/claude-code/tooling/provision.js';
import { provisionOllama } from '../../services/runtimes/opencode/providers/ollama-provision.js';

const app = createApp();

/**
 * A connected tunnel, whose public host the `/api` host guard trusts. That is
 * what makes it the right probe for the routes' own loopback rule: the request
 * reaches the handler, and the handler still has to refuse it.
 */
const TUNNEL_HOST = 'abc123.ngrok-free.app';

function connectTunnel(): void {
  mockTunnelManager.status.url = `https://${TUNNEL_HOST}`;
}

beforeEach(() => {
  mockTunnelManager.status.url = null;
});

describe('POST /api/runtimes/opencode/provision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('streams progress frames and a terminal result on success (loopback)', async () => {
    vi.mocked(provisionOpenCode).mockImplementation(async (onProgress) => {
      onProgress?.({ stage: 'starting', message: 'Installing opencode-ai@1.17.13…' });
      onProgress?.({ stage: 'installing', message: 'added 1 package' });
      const result: RuntimeProvisionResult = { ok: true, binaryPath: '/dork/opencode' };
      onProgress?.({ stage: 'done', message: 'OpenCode installed.' });
      return result;
    });

    const res = await request(app).post('/api/runtimes/opencode/provision');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    // Progress frames streamed, then the terminal result frame carried the outcome.
    expect(res.text).toContain('event: progress');
    expect(res.text).toContain('event: result');
    expect(res.text).toContain('"ok":true');
    expect(res.text).toContain('/dork/opencode');
    expect(provisionOpenCode).toHaveBeenCalledOnce();
    expect(typeof vi.mocked(provisionOpenCode).mock.calls[0][0]).toBe('function');
  });

  it('streams the honest error result when provisioning fails', async () => {
    vi.mocked(provisionOpenCode).mockResolvedValue({
      ok: false,
      error: 'Could not install OpenCode. Check your network and try again.',
    });

    const res = await request(app).post('/api/runtimes/opencode/provision');

    expect(res.status).toBe(200);
    expect(res.text).toContain('event: result');
    expect(res.text).toContain('"ok":false');
    expect(res.text).toContain('Could not install OpenCode');
  });

  it('rejects a non-loopback request with 403 and never provisions', async () => {
    connectTunnel();

    const res = await request(app)
      .post('/api/runtimes/opencode/provision')
      .set('Host', TUNNEL_HOST);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/locally/i);
    expect(provisionOpenCode).not.toHaveBeenCalled();
  });

  it('rejects a rebound Host at the app edge, before the route runs', async () => {
    const res = await request(app)
      .post('/api/runtimes/opencode/provision')
      .set('Host', 'evil.example.com');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('HOST_NOT_ALLOWED');
    expect(provisionOpenCode).not.toHaveBeenCalled();
  });
});

/**
 * DOR-532 review. `app.ts` sets `trust proxy: 1`, which makes Express derive
 * `req.hostname` from `X-Forwarded-Host` when the first hop is trusted — and on
 * a direct connection the first hop is the caller. The locality gate on these
 * routes used to read `req.hostname`, so any caller could claim to be local by
 * adding one header. That mattered most in the configuration `DORKOS_TRUSTED_HOSTS`
 * exists to support (login off, behind a reverse proxy) and on the Docker image,
 * where `DORKOS_ALLOW_INSECURE_BIND` switches the host guard off entirely.
 *
 * A connected tunnel stands in for that deployment: its host is one the host
 * guard lets through, so the request reaches the route and the route's own gate
 * is what is under test.
 */
describe('X-Forwarded-Host spoofing of the loopback gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectTunnel();
  });

  afterEach(() => {
    // `clearAllMocks` clears calls, not implementations, so the resolved value
    // set below would leak into the codex describe that follows.
    vi.mocked(provisionCodex).mockReset();
  });

  it.each([
    ['/api/runtimes/opencode/provision', () => provisionOpenCode],
    ['/api/runtimes/codex/provision', () => provisionCodex],
    ['/api/runtimes/claude-code/provision', () => provisionClaudeCode],
    ['/api/runtimes/opencode/ollama/provision', () => provisionOllama],
  ])('refuses %s and never installs anything', async (path, getSpy) => {
    const res = await request(app)
      .post(path)
      .set('Host', TUNNEL_HOST)
      .set('X-Forwarded-Host', 'localhost');

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/locally/i);
    expect(getSpy()).not.toHaveBeenCalled();
  });

  it('refuses the OpenRouter OAuth callback', async () => {
    const res = await request(app)
      .get('/api/runtimes/opencode/openrouter/oauth/callback?code=abc&state=xyz')
      .set('Host', TUNNEL_HOST)
      .set('X-Forwarded-Host', 'localhost');

    expect(res.status).toBe(403);
  });

  it('still admits a genuine loopback request with the same header present', async () => {
    vi.mocked(provisionCodex).mockResolvedValue({ ok: true, binaryPath: '/dork/codex' });

    const res = await request(app)
      .post('/api/runtimes/codex/provision')
      .set('Host', 'localhost:4242')
      .set('X-Forwarded-Host', 'evil.example.com');

    expect(res.status).toBe(200);
    expect(provisionCodex).toHaveBeenCalledOnce();
  });
});

/**
 * DOR-532 re-review. The `Host` header is written by the client as freely as
 * `X-Forwarded-Host` is, so reading it proved nothing about locality on its own:
 * a raw socket from a LAN peer sending `Host: localhost` reached these routes and
 * would have run a package install. The gate now also requires the TCP peer to be
 * loopback, which is the one signal a caller cannot write.
 *
 * These mount the router on a bare app behind a middleware that rewrites the
 * peer address, because supertest always connects from 127.0.0.1. The host guard
 * is not in this app on purpose: it is separately tested, and the point here is
 * that the ROUTE refuses even when the guard would have let the request through
 * (as it does on the Docker image, where the guard is disabled outright).
 */
describe('TCP peer is required to be loopback', () => {
  /** Build an app whose requests appear to arrive from `peer`. */
  function appWithPeer(peer: string | undefined): express.Express {
    const peerApp = express();
    peerApp.use((req, _res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: peer, configurable: true });
      next();
    });
    peerApp.use(express.json());
    peerApp.use('/api/runtimes', runtimesRouter);
    return peerApp;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['192.168.86.200', 'a LAN peer'],
    ['::ffff:192.168.86.200', 'the same peer, v4-mapped'],
    ['172.17.0.1', "Docker's bridge gateway"],
    ['203.0.113.7', 'a public address'],
  ])('refuses a loopback Host from %s (%s) and never installs', async (peer) => {
    const res = await request(appWithPeer(peer))
      .post('/api/runtimes/codex/provision')
      .set('Host', 'localhost');

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/locally/i);
    expect(provisionCodex).not.toHaveBeenCalled();
  });

  it('refuses when the socket has no address at all', async () => {
    const res = await request(appWithPeer(undefined))
      .post('/api/runtimes/codex/provision')
      .set('Host', 'localhost');

    expect(res.status).toBe(403);
    expect(provisionCodex).not.toHaveBeenCalled();
  });

  // The other half of the pair: the peer really is loopback here, because the
  // request comes from the user's own browser. What gives it away is the Host
  // the browser wrote from the address bar.
  it('refuses a rebound browser: loopback peer, hostile Host', async () => {
    const res = await request(appWithPeer('127.0.0.1'))
      .post('/api/runtimes/codex/provision')
      .set('Host', 'evil.example.com');

    expect(res.status).toBe(403);
    expect(provisionCodex).not.toHaveBeenCalled();
  });

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.2'])(
    'admits a genuine local caller from %s',
    async (peer) => {
      vi.mocked(provisionCodex).mockResolvedValue({ ok: true, binaryPath: '/dork/codex' });

      const res = await request(appWithPeer(peer))
        .post('/api/runtimes/codex/provision')
        .set('Host', 'localhost:4242');

      expect(res.status).toBe(200);
      expect(provisionCodex).toHaveBeenCalledOnce();

      vi.mocked(provisionCodex).mockReset();
    }
  );

  // The `DORKOS_ALLOW_INSECURE_BIND` branch is covered in
  // `lib/__tests__/trusted-origins.test.ts`, against the pure `isLocalRequest`.
  //
  // Reaching it through the route would mean mutating the shared `env`
  // singleton for the duration of a test. Vitest isolates module state per file
  // (`isolate` is left at its default `true`), so that could not reach another
  // test file — but it still leaves a window inside THIS file where an
  // assertion that a request is refused would pass for the wrong reason, and it
  // relies on a config default staying put to be safe at all. Passing the flag
  // in as a fact costs nothing and removes the question.
});

describe('POST /api/runtimes/codex/provision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('streams progress frames and a terminal result on success (loopback)', async () => {
    vi.mocked(provisionCodex).mockImplementation(async (onProgress) => {
      onProgress?.({ stage: 'starting', message: 'Installing @openai/codex@0.144.1…' });
      onProgress?.({ stage: 'installing', message: 'added 1 package' });
      const result: RuntimeProvisionResult = { ok: true, binaryPath: '/dork/codex' };
      onProgress?.({ stage: 'done', message: 'Codex installed.' });
      return result;
    });

    const res = await request(app).post('/api/runtimes/codex/provision');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    // The SSE frame contract is identical to the OpenCode endpoint (pinned for the client).
    expect(res.text).toContain('event: progress');
    expect(res.text).toContain('event: result');
    expect(res.text).toContain('"ok":true');
    expect(res.text).toContain('/dork/codex');
    expect(provisionCodex).toHaveBeenCalledOnce();
    expect(typeof vi.mocked(provisionCodex).mock.calls[0][0]).toBe('function');
  });

  it('streams the honest error result when provisioning fails', async () => {
    vi.mocked(provisionCodex).mockResolvedValue({
      ok: false,
      error: 'Could not install Codex. Check your network and try again.',
    });

    const res = await request(app).post('/api/runtimes/codex/provision');

    expect(res.status).toBe(200);
    expect(res.text).toContain('event: result');
    expect(res.text).toContain('"ok":false');
    expect(res.text).toContain('Could not install Codex');
  });

  it('rejects a non-loopback request with 403 and never provisions', async () => {
    connectTunnel();

    const res = await request(app).post('/api/runtimes/codex/provision').set('Host', TUNNEL_HOST);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/locally/i);
    expect(provisionCodex).not.toHaveBeenCalled();
  });
});

/**
 * DOR-1334 / F4. The client's readiness projection offers "Install Claude" for a
 * claude-code that resolves no binary, and the button POSTed to an endpoint that
 * did not exist — a 404, which the person saw as nothing happening at all.
 */
describe('POST /api/runtimes/claude-code/provision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('streams progress frames and a terminal result on success (loopback)', async () => {
    vi.mocked(provisionClaudeCode).mockImplementation(async (onProgress) => {
      onProgress?.({ stage: 'starting', message: 'Installing the Claude Code binary…' });
      onProgress?.({ stage: 'installing', message: 'added 1 package' });
      onProgress?.({ stage: 'done', message: 'Claude Code installed.' });
      return { ok: true, binaryPath: '/dork/claude' };
    });

    const res = await request(app).post('/api/runtimes/claude-code/provision');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    // The SSE frame contract is identical to the codex/opencode endpoints.
    expect(res.text).toContain('event: progress');
    expect(res.text).toContain('event: result');
    expect(res.text).toContain('"ok":true');
    expect(res.text).toContain('/dork/claude');
    expect(provisionClaudeCode).toHaveBeenCalledOnce();
    expect(typeof vi.mocked(provisionClaudeCode).mock.calls[0][0]).toBe('function');
  });

  it('streams the honest error result when provisioning fails', async () => {
    vi.mocked(provisionClaudeCode).mockResolvedValue({
      ok: false,
      error: 'Could not install Claude Code. Check your network and try again.',
    });

    const res = await request(app).post('/api/runtimes/claude-code/provision');

    expect(res.status).toBe(200);
    expect(res.text).toContain('event: result');
    expect(res.text).toContain('"ok":false');
    expect(res.text).toContain('Could not install Claude Code');
  });

  it('rejects a non-loopback request with 403 and never provisions', async () => {
    connectTunnel();

    const res = await request(app)
      .post('/api/runtimes/claude-code/provision')
      .set('Host', TUNNEL_HOST);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/locally/i);
    expect(provisionClaudeCode).not.toHaveBeenCalled();
  });
});

describe('POST /api/runtimes/opencode/ollama/provision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('streams progress frames and a terminal result carrying the install method + status (loopback)', async () => {
    vi.mocked(provisionOllama).mockImplementation(async (onProgress) => {
      onProgress?.({ stage: 'starting', message: 'Installing Ollama…' });
      onProgress?.({ stage: 'done', message: 'Ollama installed.' });
      return { ok: true, installMethod: 'brew', status: { running: true, models: [] } };
    });

    const res = await request(app).post('/api/runtimes/opencode/ollama/provision');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    // Mirrors the provision endpoint's SSE contract: progress frames then a result.
    expect(res.text).toContain('event: progress');
    expect(res.text).toContain('event: result');
    expect(res.text).toContain('"ok":true');
    expect(res.text).toContain('"installMethod":"brew"');
    expect(res.text).toContain('"running":true');
    expect(provisionOllama).toHaveBeenCalledOnce();
    expect(typeof vi.mocked(provisionOllama).mock.calls[0][0]).toBe('function');
  });

  it('streams the honest error result when there is no one-click path', async () => {
    vi.mocked(provisionOllama).mockResolvedValue({
      ok: false,
      installMethod: 'manual',
      error:
        'One-click install is not available on this computer. Copy the command to install Ollama yourself.',
    });

    const res = await request(app).post('/api/runtimes/opencode/ollama/provision');

    expect(res.status).toBe(200);
    expect(res.text).toContain('event: result');
    expect(res.text).toContain('"ok":false');
    expect(res.text).toContain('One-click install is not available');
  });

  it('rejects a non-loopback request with 403 and never installs', async () => {
    connectTunnel();

    const res = await request(app)
      .post('/api/runtimes/opencode/ollama/provision')
      .set('Host', TUNNEL_HOST);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/locally/i);
    expect(provisionOllama).not.toHaveBeenCalled();
  });
});
