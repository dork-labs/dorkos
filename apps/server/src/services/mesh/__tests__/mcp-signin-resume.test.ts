/**
 * Bringing an agent back on its own once a sign-in lands (DOR-1004).
 *
 * The resume moved out of the browser for one reason: an OAuth round trip is
 * exactly when a person reloads, closes the tab, or finishes on their phone, and
 * a client-owned resume forfeits every one of those. So the two halves are pinned
 * separately here:
 *
 * - the ENGINE calls the port exactly once, and only for a sign-in that began
 *   inside a session;
 * - the PORT's handler declines quietly when there is nothing it may do.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resetKeyCache } from '@dorkos/shared/extension-secrets';

import { AgentMcpOAuthService } from '../agent-mcp-oauth-service.js';
import type { McpSigninConnectedEvent } from '../mcp-signin-resume.js';

const AGENT_ID = '01HV7KJZZZ0000000000000000';
const SERVER = 'granola';
const ORIGIN = 'https://mcp.test.local';
const SERVER_URL = `${ORIGIN}/mcp`;
const AUTH_CODE = 'auth-code-xyz';
const SESSION_ID = 'sess-abc';
const TARGET = { agentId: AGENT_ID, serverName: SERVER, serverUrl: SERVER_URL };

const tempDirs: string[] = [];
afterEach(async () => {
  resetKeyCache();
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** A scheduler that captures but never fires — background refresh is out of scope. */
const inertScheduler = {
  set: (): ReturnType<typeof setTimeout> => 0 as unknown as ReturnType<typeof setTimeout>,
  clear: (): void => {},
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function readForm(init?: RequestInit): URLSearchParams {
  const b = init?.body;
  if (!b) return new URLSearchParams();
  if (typeof b === 'string') return new URLSearchParams(b);
  if (b instanceof URLSearchParams) return b;
  return new URLSearchParams(String(b));
}

/** A mock OAuth provider: discovery, DCR, and a PKCE-validating token endpoint. */
function mockOAuthFetch(pkce: { challenge: string }): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('oauth-protected-resource')) {
      return json({ resource: SERVER_URL, authorization_servers: [ORIGIN] });
    }
    if (url.includes('oauth-authorization-server') || url.includes('openid-configuration')) {
      return json({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/authorize`,
        token_endpoint: `${ORIGIN}/token`,
        registration_endpoint: `${ORIGIN}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (url.endsWith('/register')) {
      return json({
        client_id: 'test-client-id',
        redirect_uris: [`http://127.0.0.1:4242/api/agents/mcp-oauth/callback`],
        token_endpoint_auth_method: 'none',
      });
    }
    if (url.endsWith('/token')) {
      const form = readForm(init);
      const verifierOk =
        createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url') === pkce.challenge;
      if (form.get('code') !== AUTH_CODE || !verifierOk)
        return json({ error: 'invalid_grant' }, 400);
      return json({ access_token: 'access-1', token_type: 'Bearer', expires_in: 3600 });
    }
    return new Response('not found', { status: 404 });
  };
}

/** Build an engine wired to a recording port, over a fresh dorkHome. */
async function buildEngine(): Promise<{
  oauth: AgentMcpOAuthService;
  pkce: { challenge: string };
  connected: McpSigninConnectedEvent[];
}> {
  const dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-resume-home-'));
  tempDirs.push(dorkHome);
  const pkce = { challenge: '' };
  const connected: McpSigninConnectedEvent[] = [];
  const oauth = new AgentMcpOAuthService({
    dorkHome,
    callbackBaseUrl: 'http://127.0.0.1:4242',
    fetchImpl: mockOAuthFetch(pkce),
    cache: { scheduler: inertScheduler },
    logger: { warn: () => {} },
    probe: async () => ({ ok: true, toolCount: 7 }),
    onSigninConnected: (event) => connected.push(event),
  });
  return { oauth, pkce, connected };
}

/** Drive a full browser sign-in for a flow started with `options`. */
async function signInFully(
  oauth: AgentMcpOAuthService,
  pkce: { challenge: string },
  options?: { originSessionId?: string }
): Promise<string> {
  const started = await oauth.startSignin(TARGET, options);
  pkce.challenge = new URL(started.authorizeUrl!).searchParams.get('code_challenge') ?? '';
  const cb = await oauth.handleCallback({ state: started.flowId, code: AUTH_CODE });
  expect(cb).toEqual({ connected: true, serverName: SERVER });
  return started.flowId;
}

describe('the connected port', () => {
  it('fires once, naming the session to resume and what it unlocked', async () => {
    const { oauth, pkce, connected } = await buildEngine();

    const flowId = await signInFully(oauth, pkce, { originSessionId: SESSION_ID });

    expect(connected).toEqual([
      {
        agentId: AGENT_ID,
        serverName: SERVER,
        sessionId: SESSION_ID,
        flowId,
        toolCount: 7,
      },
    ]);
  });

  it('does not fire for a sessionless sign-in', async () => {
    // The settings panel, the external `/mcp` server and HTTP all start sign-ins
    // with no conversation behind them. Resuming "the session" would mean picking
    // one at random.
    const { oauth, pkce, connected } = await buildEngine();

    await signInFully(oauth, pkce);

    expect(connected).toEqual([]);
  });

  it('fires only once when the callback page is reloaded', async () => {
    // A reloaded callback is a real thing operators do, and a second event here
    // is a second turn for one sign-in. TWO independent things prevent it — the
    // already-connected fast path, and the one-shot PKCE verifier — which is why
    // removing either alone leaves this green. What reddens it is announcing
    // OUTSIDE the exchange: on the fast path, or a second time around
    // `markConnected`. Both were tried.
    const { oauth, pkce, connected } = await buildEngine();
    const started = await oauth.startSignin(TARGET, { originSessionId: SESSION_ID });
    pkce.challenge = new URL(started.authorizeUrl!).searchParams.get('code_challenge') ?? '';

    await oauth.handleCallback({ state: started.flowId, code: AUTH_CODE });
    await oauth.handleCallback({ state: started.flowId, code: AUTH_CODE });

    expect(connected).toHaveLength(1);
  });

  it('does not fire when the sign-in failed', async () => {
    const { oauth, pkce, connected } = await buildEngine();
    const started = await oauth.startSignin(TARGET, { originSessionId: SESSION_ID });
    pkce.challenge = new URL(started.authorizeUrl!).searchParams.get('code_challenge') ?? '';

    const cb = await oauth.handleCallback({ state: started.flowId, error: 'access_denied' });

    expect(cb.connected).toBe(false);
    expect(connected).toEqual([]);
  });

  it('still resumes when the tool count cannot be taken', async () => {
    // The count is the payoff, never a gate: the sign-in DID succeed, and
    // withholding the resume over a second round trip is the more damaging lie.
    const dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-resume-home-'));
    tempDirs.push(dorkHome);
    const pkce = { challenge: '' };
    const connected: McpSigninConnectedEvent[] = [];
    const oauth = new AgentMcpOAuthService({
      dorkHome,
      callbackBaseUrl: 'http://127.0.0.1:4242',
      fetchImpl: mockOAuthFetch(pkce),
      cache: { scheduler: inertScheduler },
      logger: { warn: () => {} },
      probe: async () => {
        throw new Error('the server hung up');
      },
      onSigninConnected: (event) => connected.push(event),
    });

    await signInFully(oauth, pkce, { originSessionId: SESSION_ID });

    expect(connected).toHaveLength(1);
    expect(connected[0]).toMatchObject({ sessionId: SESSION_ID });
    expect(connected[0].toolCount).toBeUndefined();
  });

  it('survives a port that throws — the browser still sees success', async () => {
    // The caller is the loopback callback the operator's browser is waiting on.
    // A resume that cannot start must not turn their "you can close this tab"
    // page into an error.
    const dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-resume-home-'));
    tempDirs.push(dorkHome);
    const pkce = { challenge: '' };
    const oauth = new AgentMcpOAuthService({
      dorkHome,
      callbackBaseUrl: 'http://127.0.0.1:4242',
      fetchImpl: mockOAuthFetch(pkce),
      cache: { scheduler: inertScheduler },
      logger: { warn: () => {} },
      probe: async () => ({ ok: true, toolCount: 7 }),
      onSigninConnected: () => {
        throw new Error('the session exploded');
      },
    });

    const started = await oauth.startSignin(TARGET, { originSessionId: SESSION_ID });
    pkce.challenge = new URL(started.authorizeUrl!).searchParams.get('code_challenge') ?? '';

    await expect(oauth.handleCallback({ state: started.flowId, code: AUTH_CODE })).resolves.toEqual(
      { connected: true, serverName: SERVER }
    );
    expect((await oauth.pollSignin(started.flowId)).status).toBe('connected');
  });
});

describe('resumeAfterMcpSignin', () => {
  const EVENT: McpSigninConnectedEvent = {
    agentId: AGENT_ID,
    serverName: SERVER,
    sessionId: SESSION_ID,
    flowId: 'flow-1',
    toolCount: 7,
  };

  /** Load the module under a fresh set of session/runtime/logger mocks. */
  async function loadWithMocks(options: {
    accepted: boolean;
    hasSession?: boolean;
    ingest?: (event: unknown) => void;
  }) {
    vi.resetModules();
    const triggerTurn = vi.fn().mockResolvedValue({ accepted: options.accepted });
    // The logger is how "declined quietly" is told apart from "blew up and was
    // swallowed": this module never rejects, so without watching which LEVEL it
    // logged at, a throw on the busy path is indistinguishable from the intended
    // no-op.
    const warn = vi.fn();
    const info = vi.fn();
    vi.doMock('../../../lib/logger.js', () => ({ logger: { warn, info } }));
    const runtime = {
      hasSession: () => options.hasSession ?? true,
      getSession: async () => ({ id: SESSION_ID }),
      getCapabilities: () => ({ logBackedHistory: false }),
      acquireLock: vi.fn(),
      releaseLock: vi.fn(),
      sendMessage: vi.fn(),
      interruptQuery: vi.fn(),
      getInternalSessionId: vi.fn(),
    };
    vi.doMock('../../core/runtime-registry.js', () => ({
      runtimeRegistry: { resolveForSession: async () => runtime },
    }));
    vi.doMock('../../session/index.js', () => ({
      triggerTurn,
      getOrCreateProjector: () => ({ cwd: '/projects/test' }),
      peekProjector: () => ({ cwd: '/projects/test', ingest: options.ingest ?? (() => {}) }),
      persistenceModeFor: () => 'record',
      rekeyProjector: vi.fn(),
    }));
    const { resumeAfterMcpSignin } = await import('../mcp-signin-resume.js');
    return { resumeAfterMcpSignin, triggerTurn, warn, info };
  }

  afterEach(() => {
    vi.doUnmock('../../core/runtime-registry.js');
    vi.doUnmock('../../session/index.js');
    vi.doUnmock('../../../lib/logger.js');
    vi.resetModules();
  });

  it('settles the session’s card into a receipt, then resumes the agent', async () => {
    const ingested: unknown[] = [];
    const { resumeAfterMcpSignin, triggerTurn } = await loadWithMocks({
      accepted: true,
      ingest: (event) => ingested.push(event),
    });

    await resumeAfterMcpSignin(EVENT);

    expect(ingested).toEqual([
      { type: 'mcp_signin_resolved', flowId: 'flow-1', outcome: 'connected', toolCount: 7 },
    ]);
    expect(triggerTurn).toHaveBeenCalledTimes(1);
    const content = triggerTurn.mock.calls[0][0].content as string;
    expect(content).toContain('Continue the task');
    expect(content).toContain('Do not describe or narrate');
    expect(content).toContain(SERVER);
  });

  it('settles quietly when the session is locked — one attempt, no fault', async () => {
    // A lock means a turn is already running, usually the agent doing the very
    // work this would ask for. The server's tools inject on its next turn anyway,
    // so this is a note, not a failure — and it is tried exactly once.
    const { resumeAfterMcpSignin, triggerTurn, warn, info } = await loadWithMocks({
      accepted: false,
    });

    await expect(resumeAfterMcpSignin(EVENT)).resolves.toBeUndefined();

    expect(triggerTurn).toHaveBeenCalledTimes(1);
    // Declined, not faulted: this module swallows everything it catches, so the
    // LEVEL is the only thing that tells the two apart.
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toContain('busy');
  });

  it('reports a genuine failure as a warning rather than as a polite decline', async () => {
    // The counterpart that makes the assertion above mean something: a path that
    // really did break must NOT read the same as a busy session. Both are
    // swallowed — only the level distinguishes them.
    const { resumeAfterMcpSignin, triggerTurn, warn, info } = await loadWithMocks({
      accepted: true,
    });
    triggerTurn.mockRejectedValue(new Error('boom'));

    await expect(resumeAfterMcpSignin(EVENT)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
  });

  it('does not resume a session that no longer exists anywhere', async () => {
    vi.resetModules();
    const triggerTurn = vi.fn().mockResolvedValue({ accepted: true });
    vi.doMock('../../core/runtime-registry.js', () => ({
      runtimeRegistry: {
        resolveForSession: async () => ({
          hasSession: () => false,
          getSession: async () => undefined,
          getCapabilities: () => ({ logBackedHistory: false }),
        }),
      },
    }));
    vi.doMock('../../session/index.js', () => ({
      triggerTurn,
      getOrCreateProjector: () => ({ cwd: '/projects/test' }),
      peekProjector: () => undefined,
      persistenceModeFor: () => 'record',
      rekeyProjector: vi.fn(),
    }));
    const { resumeAfterMcpSignin } = await import('../mcp-signin-resume.js');

    await expect(resumeAfterMcpSignin(EVENT)).resolves.toBeUndefined();
    expect(triggerTurn).not.toHaveBeenCalled();
  });

  it('never rejects when the runtime itself throws', async () => {
    vi.resetModules();
    vi.doMock('../../core/runtime-registry.js', () => ({
      runtimeRegistry: {
        resolveForSession: async () => {
          throw new Error('no runtime for you');
        },
      },
    }));
    vi.doMock('../../session/index.js', () => ({
      triggerTurn: vi.fn(),
      getOrCreateProjector: () => ({ cwd: '/projects/test' }),
      peekProjector: () => undefined,
      persistenceModeFor: () => 'record',
      rekeyProjector: vi.fn(),
    }));
    const { resumeAfterMcpSignin } = await import('../mcp-signin-resume.js');

    await expect(resumeAfterMcpSignin(EVENT)).resolves.toBeUndefined();
  });
});
