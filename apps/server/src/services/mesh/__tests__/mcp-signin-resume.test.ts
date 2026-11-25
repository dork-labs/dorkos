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
import { createTestDb } from '@dorkos/test-utils/db';
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
  options?: { originSessionId?: string; originCwd?: string }
): Promise<string> {
  const started = await oauth.startSignin(TARGET, options);
  pkce.challenge = new URL(started.authorizeUrl!).searchParams.get('code_challenge') ?? '';
  const cb = await oauth.handleCallback({ state: started.flowId, code: AUTH_CODE });
  expect(cb).toMatchObject({ connected: true, serverName: SERVER });
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

  it('fires once when two callbacks race, not once per callback', async () => {
    // The reload test above only exercises the PRE-lock fast path: by the time the
    // second call arrives, the first has finished. Two callbacks landing
    // CONCURRENTLY — a browser reload during the few hundred ms the exchange is on
    // the wire — both pass that check while the flow is still pending, and only
    // the re-check INSIDE the lock stops the second from announcing. Without this
    // case that guard is unpinned, and one sign-in buys two turns.
    const { oauth, pkce, connected } = await buildEngine();
    const started = await oauth.startSignin(TARGET, { originSessionId: SESSION_ID });
    pkce.challenge = new URL(started.authorizeUrl!).searchParams.get('code_challenge') ?? '';

    const [first, second] = await Promise.all([
      oauth.handleCallback({ state: started.flowId, code: AUTH_CODE }),
      oauth.handleCallback({ state: started.flowId, code: AUTH_CODE }),
    ]);

    expect(first).toMatchObject({ connected: true, serverName: SERVER });
    expect(second).toMatchObject({ connected: true, serverName: SERVER });
    expect(connected).toHaveLength(1);
  });
});

describe('resumeAfterMcpSignin', () => {
  /** The directory the session's own projector reports — NOT the server default. */
  const SESSION_CWD = '/projects/somewhere-else';

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
    const dispatchMessage = vi.fn().mockResolvedValue({ accepted: options.accepted });
    // The logger is how "declined quietly" is told apart from "blew up and was
    // swallowed": this module never rejects, so without watching which LEVEL it
    // logged at, a throw on the busy path is indistinguishable from the intended
    // no-op.
    const warn = vi.fn();
    const info = vi.fn();
    vi.doMock('../../../lib/logger.js', () => ({ logger: { warn, info } }));
    const getSession = vi.fn(async () => ({ id: SESSION_ID }));
    const runtime = {
      hasSession: () => options.hasSession ?? true,
      getSession,
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
    const getOrCreateProjector = vi.fn((_id: string, _cwd?: string) => ({ cwd: SESSION_CWD }));
    vi.doMock('../../session/index.js', () => ({
      dispatchMessage,
      getOrCreateProjector,
      peekProjector: () => ({ cwd: SESSION_CWD, ingest: options.ingest ?? (() => {}) }),
      persistenceModeFor: () => 'record',
    }));
    const { resumeAfterMcpSignin } = await import('../mcp-signin-resume.js');
    return { resumeAfterMcpSignin, dispatchMessage, getOrCreateProjector, runtime, warn, info };
  }

  afterEach(() => {
    vi.doUnmock('../../core/runtime-registry.js');
    vi.doUnmock('../../session/index.js');
    vi.doUnmock('../../../lib/logger.js');
    vi.resetModules();
  });

  it('holds the nudge to the runtime default when the chat’s latest turn was held (DOR-3037)', async () => {
    const { resumeAfterMcpSignin, dispatchMessage } = await loadWithMocks({ accepted: true });
    const hold = await import('../../core/turn-power/continuation-hold.js');
    hold.setContinuationHoldDb(createTestDb());
    try {
      hold.noteTurnHold(SESSION_ID, true);
      await resumeAfterMcpSignin(EVENT);
      expect(dispatchMessage.mock.calls[0][0].permissionCeiling).toBe('runtime-default');
      hold.noteTurnHold(SESSION_ID, false);
      await resumeAfterMcpSignin({ ...EVENT, flowId: 'flow-2' });
      expect(dispatchMessage.mock.calls[1][0].permissionCeiling).toBeUndefined();
    } finally {
      hold.setContinuationHoldDb(undefined);
    }
  });

  it('settles the session’s card into a receipt, then resumes the agent', async () => {
    const ingested: unknown[] = [];
    const { resumeAfterMcpSignin, dispatchMessage } = await loadWithMocks({
      accepted: true,
      ingest: (event) => ingested.push(event),
    });

    await resumeAfterMcpSignin(EVENT);

    expect(ingested).toEqual([
      { type: 'mcp_signin_resolved', flowId: 'flow-1', outcome: 'connected', toolCount: 7 },
    ]);
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
    const content = dispatchMessage.mock.calls[0][0].content as string;
    expect(dispatchMessage.mock.calls[0][0].turnStarter).toBe('agent');
    expect(content).toContain('Continue the task');
    expect(content).toContain('Do not describe or narrate');
    expect(content).toContain(SERVER);
  });

  it('runs the turn in the SESSION’s directory, not the server default', async () => {
    // Every hop that takes a cwd has to be given one. A turn triggered without it
    // cold-starts a map-less session against the default root — the wrong
    // checkout, silently — which is the same bug `/ui-action` threads its request
    // cwd to avoid. The mocks deliberately report a directory that is NOT the
    // default, so a dropped hop cannot pass by coincidence.
    const { resumeAfterMcpSignin, dispatchMessage, getOrCreateProjector, runtime } =
      await loadWithMocks({ accepted: true, hasSession: false });

    await resumeAfterMcpSignin(EVENT);

    // The storage probe that decides whether there is anything to resume…
    expect(runtime.getSession).toHaveBeenCalledWith(SESSION_CWD, SESSION_ID);
    // …the projector the turn is flushed through…
    expect(getOrCreateProjector.mock.calls[0][1]).toBe(SESSION_CWD);
    // …and the trigger itself.
    expect(dispatchMessage.mock.calls[0][0].cwd).toBe(SESSION_CWD);
  });
});
