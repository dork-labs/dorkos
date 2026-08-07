/**
 * A sign-in that dies while the person is still working (DOR-981).
 *
 * The bug had two halves and this file holds both to the same evidence — one
 * `needs-auth` from a turn's MCP status snapshot:
 *
 * 1. DorkOS stopped injecting the dead token, so the row flips back to "Needs
 *    sign-in" WITHOUT anyone pressing Test and without another turn.
 * 2. The sign-in card appears in the conversation the person hit the wall in,
 *    with a link that actually works.
 *
 * The engine and the manifest service are the REAL ones over a temp workspace,
 * because the interesting failures live between them: a cached token, a stored
 * token, and a manifest that has to agree about whether a server is connected.
 * Only the session projector is mocked — it is the surface the card lands on.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resetKeyCache } from '@dorkos/shared/extension-secrets';
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest, McpServerTransport } from '@dorkos/shared/mesh-schemas';

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
  vi.doUnmock('../../session/index.js');
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** A scheduler that captures but never fires — nothing here waits on a timer. */
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

/** Knobs the mock provider reads on every request, so a test can revoke mid-run. */
interface ProviderState {
  /** The PKCE challenge the authorize URL carried, filled in by the test. */
  challenge: string;
  /** Whether the token endpoint hands out a refresh token with the grant. */
  issueRefreshToken: boolean;
  /** Whether a `refresh_token` grant is honoured — flipped to false to revoke. */
  honourRefresh: boolean;
  /** Every grant_type the token endpoint was asked for, in order. */
  grants: string[];
}

/** A mock OAuth provider: discovery, DCR, and a PKCE-validating token endpoint. */
function mockOAuthFetch(state: ProviderState): typeof fetch {
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
        redirect_uris: ['http://127.0.0.1:4242/api/agents/mcp-oauth/callback'],
        token_endpoint_auth_method: 'none',
      });
    }
    if (url.endsWith('/token')) {
      const form = readForm(init);
      const grant = form.get('grant_type') ?? '';
      state.grants.push(grant);
      if (grant === 'refresh_token') {
        // The revocation itself: the provider stops honouring the grant family.
        if (!state.honourRefresh) return json({ error: 'invalid_grant' }, 400);
        return json({
          access_token: 'access-2',
          refresh_token: 'refresh-2',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      const verifierOk =
        createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url') === state.challenge;
      if (form.get('code') !== AUTH_CODE || !verifierOk) {
        return json({ error: 'invalid_grant' }, 400);
      }
      return json({
        access_token: 'access-1',
        token_type: 'Bearer',
        expires_in: 3600,
        ...(state.issueRefreshToken ? { refresh_token: 'refresh-1' } : {}),
      });
    }
    return new Response('not found', { status: 404 });
  };
}

/** The OAuth-protected http connection the fixture workspace declares. */
const OAUTH_HTTP: McpServerTransport = {
  transport: 'http',
  url: SERVER_URL,
  headers: {},
  authKind: 'oauth2',
};

/** Write an agent workspace whose single managed server carries `connection`. */
async function setupWorkspace(connection: McpServerTransport = OAUTH_HTTP): Promise<string> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-revoke-ws-'));
  tempDirs.push(projectPath);
  const manifest: AgentManifest = {
    id: AGENT_ID,
    name: 'test-agent',
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: '2026-08-06T00:00:00.000Z',
    registeredBy: 'test',
    personaEnabled: true,
    isSystem: false,
    enabledToolGroups: {},
    mcpServers: [
      {
        name: SERVER,
        enabled: true,
        connection,
        addedAt: '2026-08-06T00:00:00.000Z',
        addedBy: 'operator',
      },
    ],
  };
  await writeManifest(projectPath, manifest);
  return projectPath;
}

/** The card events the (mocked) session projector received. */
type Ingested = Array<Record<string, unknown>>;

/**
 * A whole world: the real OAuth engine, the real manifest service over a temp
 * workspace, and the revocation watch wired between them — loaded fresh so the
 * mocked session module takes effect.
 */
async function buildWorld(
  options: {
    connection?: McpServerTransport;
    projector?: boolean;
    issueRefreshToken?: boolean;
  } = {}
) {
  vi.resetModules();
  const ingested: Ingested = [];
  vi.doMock('../../session/index.js', () => ({
    peekProjector: () =>
      options.projector === false
        ? undefined
        : { ingest: (event: Record<string, unknown>) => ingested.push(event) },
  }));

  const { AgentMcpOAuthService } = await import('../agent-mcp-oauth-service.js');
  const { AgentMcpServerService } = await import('../agent-mcp-server-service.js');
  const { createMcpRevocationWatch } = await import('../mcp-revocation.js');

  const dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-revoke-home-'));
  tempDirs.push(dorkHome);
  const cwd = await setupWorkspace(options.connection ?? OAUTH_HTTP);
  const provider: ProviderState = {
    challenge: '',
    issueRefreshToken: options.issueRefreshToken ?? false,
    honourRefresh: true,
    grants: [],
  };

  const oauth = new AgentMcpOAuthService({
    dorkHome,
    callbackBaseUrl: 'http://127.0.0.1:4242',
    fetchImpl: mockOAuthFetch(provider),
    cache: { scheduler: inertScheduler },
    logger: { warn: () => {} },
    sleep: async () => {},
  });
  const servers = new AgentMcpServerService({
    agents: { get: (id: string) => (id === AGENT_ID ? { projectPath: cwd } : undefined) },
    logger: { warn: () => {} },
    tokenProvider: oauth,
  });
  const startSignin = vi.spyOn(oauth, 'startSignin');
  const settled: string[] = [];
  const port = createMcpRevocationWatch({
    oauth,
    servers,
    logger: { warn: () => {}, info: () => {} },
    onSettled: (serverName) => settled.push(serverName),
  });

  /**
   * Report evidence and WAIT for every reported server to be done with.
   *
   * The investigation is detached from the turn on purpose, so there is nothing
   * to await without this. Counting settlements — rather than spinning
   * microtasks — is what keeps these tests from depending on how many awaits a
   * refresh happens to take today.
   */
  const watch = async (evidence: {
    sessionId: string;
    cwd: string;
    serverNames: string[];
  }): Promise<void> => {
    const before = settled.length;
    port(evidence);
    await vi.waitFor(() =>
      expect(settled.length).toBe(before + new Set(evidence.serverNames).size)
    );
  };

  return { oauth, servers, watch, port, settled, cwd, dorkHome, provider, ingested, startSignin };
}

/** Drive a full browser sign-in so the server is genuinely connected. */
async function signInFully(
  oauth: { startSignin: Function; handleCallback: Function },
  provider: ProviderState
): Promise<void> {
  const started = await oauth.startSignin(TARGET, {
    originSessionId: SESSION_ID,
  });
  provider.challenge = new URL(started.authorizeUrl).searchParams.get('code_challenge') ?? '';
  const cb = await oauth.handleCallback({ state: started.flowId, code: AUTH_CODE });
  expect(cb.connected).toBe(true);
}

describe('a sign-in that dies mid-session', () => {
  it('flips the row back to needs-auth and puts the card where the wall was', async () => {
    const { oauth, servers, watch, cwd, provider, ingested } = await buildWorld();
    await signInFully(oauth, provider);

    // The state the bug reported: the row says Connected because DorkOS holds a
    // token, and it would go on saying so while every tool call 401'd.
    expect((await servers.list(AGENT_ID))[0]?.authStatus).toBe('connected');

    await watch({ sessionId: SESSION_ID, cwd, serverNames: [SERVER] });

    // Half one: the listing tells the truth again, with no Test and no turn.
    expect((await servers.list(AGENT_ID))[0]?.authStatus).toBe('needs-auth');
    // …and injection has stopped handing the dead token out.
    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBeUndefined();

    // Half two: exactly one card, carrying a link a person can actually press.
    expect(ingested).toHaveLength(1);
    const card = ingested[0]!;
    expect(card.type).toBe('mcp_signin_required');
    expect(card.serverName).toBe(SERVER);
    expect(card.agentId).toBe(AGENT_ID);
    expect(String(card.authorizeUrl)).toContain(`${ORIGIN}/authorize`);
    expect(String(card.disclosure)).toContain(SERVER);
  });

  it('deletes the STORED credential too, so a restart cannot resurrect it', async () => {
    // Evicting only the in-memory cache leaves the dead token set on disk, and
    // `warm` re-primes from disk. The row would read "Connected" again the moment
    // the process restarted — the same lie, one restart later.
    const { oauth, watch, cwd, provider, dorkHome } = await buildWorld();
    await signInFully(oauth, provider);

    await watch({ sessionId: SESSION_ID, cwd, serverNames: [SERVER] });

    const { AgentMcpOAuthService } = await import('../agent-mcp-oauth-service.js');
    const afterRestart = new AgentMcpOAuthService({
      dorkHome,
      callbackBaseUrl: 'http://127.0.0.1:4242',
      fetchImpl: mockOAuthFetch(provider),
      cache: { scheduler: inertScheduler },
      logger: { warn: () => {} },
    });
    await afterRestart.warm([TARGET]);

    expect(afterRestart.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBeUndefined();
  });

  it('says nothing — the card is the whole message', async () => {
    // Etiquette: the failure surfaces itself. Nothing is injected into the
    // agent's mouth, so the ONLY thing this path may put on the session is the
    // card itself (`meta/agent-etiquette.md`).
    const { oauth, watch, cwd, provider, ingested } = await buildWorld();
    await signInFully(oauth, provider);

    await watch({ sessionId: SESSION_ID, cwd, serverNames: [SERVER] });

    expect(ingested.map((event) => event.type)).toEqual(['mcp_signin_required']);
  });

  it('records the session AND its directory, so the resume survives a restart', async () => {
    const { oauth, watch, cwd, provider, startSignin } = await buildWorld();
    await signInFully(oauth, provider);
    startSignin.mockClear();

    await watch({ sessionId: SESSION_ID, cwd, serverNames: [SERVER] });

    expect(startSignin).toHaveBeenCalledTimes(1);
    expect(startSignin.mock.calls[0]![1]).toEqual({
      originSessionId: SESSION_ID,
      originCwd: cwd,
    });
  });
});

describe('what it refuses to conclude', () => {
  it('takes a refresh that works as a blip, not a revocation', async () => {
    // The whole point of trying a refresh first: a refused access token beside a
    // live grant is recoverable, and condemning it would sign the person out of a
    // server that was never disconnected.
    const { oauth, servers, watch, cwd, provider, ingested } = await buildWorld({
      issueRefreshToken: true,
    });
    await signInFully(oauth, provider);

    await watch({ sessionId: SESSION_ID, cwd, serverNames: [SERVER] });

    expect(provider.grants).toContain('refresh_token');
    expect((await servers.list(AGENT_ID))[0]?.authStatus).toBe('connected');
    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBe('access-2');
    expect(ingested).toEqual([]);
  });

  it('condemns the grant once the refresh is refused too', async () => {
    // The counterpart that makes the test above mean something: same setup, same
    // evidence, and the ONLY difference is the provider's answer to the refresh.
    const { oauth, servers, watch, cwd, provider, ingested } = await buildWorld({
      issueRefreshToken: true,
    });
    await signInFully(oauth, provider);
    provider.honourRefresh = false;

    await watch({ sessionId: SESSION_ID, cwd, serverNames: [SERVER] });

    expect((await servers.list(AGENT_ID))[0]?.authStatus).toBe('needs-auth');
    expect(ingested).toHaveLength(1);
  });

  it('does nothing for a server DorkOS never held a sign-in for', async () => {
    // Never connected: its row already says needs-auth, and an unbidden card for
    // something the person never signed into is noise, not help.
    const { servers, watch, cwd, ingested, startSignin } = await buildWorld();

    await watch({ sessionId: SESSION_ID, cwd, serverNames: [SERVER] });

    expect(ingested).toEqual([]);
    expect(startSignin).not.toHaveBeenCalled();
    expect((await servers.list(AGENT_ID))[0]?.authStatus).toBe('needs-auth');
  });

  it('never draws a card for a server carrying its OWN Authorization header', async () => {
    // The operator pasted that credential in. Its 401 is theirs to fix, and an
    // OAuth sign-in DorkOS would then own is not the fix.
    const { oauth, watch, cwd, provider, ingested, startSignin } = await buildWorld({
      connection: {
        transport: 'http',
        url: SERVER_URL,
        headers: { Authorization: 'Bearer operator-token' },
        authKind: 'oauth2',
      },
    });
    await signInFully(oauth, provider);
    startSignin.mockClear();

    await watch({ sessionId: SESSION_ID, cwd, serverNames: [SERVER] });

    expect(ingested).toEqual([]);
    expect(startSignin).not.toHaveBeenCalled();
  });

  it('ignores a stdio server, which has no bearer to have refused', async () => {
    const { watch, cwd, ingested, startSignin } = await buildWorld({
      connection: { transport: 'stdio', command: 'echo', args: [], env: {} },
    });

    await watch({ sessionId: SESSION_ID, cwd, serverNames: [SERVER] });

    expect(ingested).toEqual([]);
    expect(startSignin).not.toHaveBeenCalled();
  });

  it('ignores a name that belongs to no managed server here', async () => {
    const { watch, cwd, ingested, startSignin } = await buildWorld();

    await watch({ sessionId: SESSION_ID, cwd, serverNames: ['something-else'] });

    expect(ingested).toEqual([]);
    expect(startSignin).not.toHaveBeenCalled();
  });
});

describe('one card per server', () => {
  it('starts one sign-in when a burst names the same server twice', async () => {
    const { oauth, watch, cwd, provider, ingested, startSignin } = await buildWorld();
    await signInFully(oauth, provider);
    startSignin.mockClear();

    await watch({ sessionId: SESSION_ID, cwd, serverNames: [SERVER, SERVER, SERVER] });

    expect(startSignin).toHaveBeenCalledTimes(1);
    expect(ingested).toHaveLength(1);
  });

  it('starts one sign-in when two turns report it in the same breath', async () => {
    // Two sessions in one workspace, both turns starting together. Neither has
    // finished investigating when the other arrives, so nothing they could look
    // up — not the token, not the flow store — has been written yet. Only the
    // in-flight guard stops the second from minting its own flow.
    const { oauth, port, settled, cwd, provider, ingested, startSignin } = await buildWorld();
    await signInFully(oauth, provider);
    startSignin.mockClear();

    port({ sessionId: SESSION_ID, cwd, serverNames: [SERVER] });
    port({ sessionId: 'sess-second', cwd, serverNames: [SERVER] });
    await vi.waitFor(() => expect(settled).toHaveLength(2));

    expect(startSignin).toHaveBeenCalledTimes(1);
    expect(ingested).toHaveLength(1);
  });

  it('re-draws the SAME sign-in when a later turn reports the same server again', async () => {
    // The person is part-way through the sign-in the first dead turn drew, and the
    // server is still refusing. A second flow would put a dead link beside the
    // working one; saying nothing at all would let the projector's grace age the
    // card out from under someone who is still in their browser. So: same flow,
    // re-drawn.
    const { oauth, watch, cwd, provider, ingested, startSignin } = await buildWorld();
    await signInFully(oauth, provider);
    startSignin.mockClear();

    await watch({ sessionId: SESSION_ID, cwd, serverNames: [SERVER] });
    await watch({ sessionId: SESSION_ID, cwd, serverNames: [SERVER] });

    expect(startSignin).toHaveBeenCalledTimes(1);
    expect(ingested).toHaveLength(2);
    expect(ingested[0]!.flowId).toBe(ingested[1]!.flowId);
  });
});

describe('reading a turn’s status snapshot', () => {
  it('counts only the status that means "your token was refused"', async () => {
    const { authRefusedServers } = await import('../mcp-revocation.js');

    expect(
      authRefusedServers([
        { name: 'refused', status: 'needs-auth' },
        // Everything below is trouble of some other kind. Reading any of it as a
        // revocation would sign the person out of a working server the first time
        // their network hiccupped.
        { name: 'broken', status: 'failed' },
        { name: 'slow', status: 'pending' },
        { name: 'off', status: 'disabled' },
        { name: 'fine', status: 'connected' },
        { name: 'unreported' },
      ])
    ).toEqual(['refused']);
  });
});

describe('when there is nobody to show the card to', () => {
  it('still evicts the dead token, quietly', async () => {
    // A session with no live projector — nobody watching, or the process
    // restarted. The row still has to tell the truth; only the card is lost.
    const { oauth, servers, watch, cwd, provider } = await buildWorld({ projector: false });
    await signInFully(oauth, provider);

    await watch({ sessionId: SESSION_ID, cwd, serverNames: [SERVER] });

    expect((await servers.list(AGENT_ID))[0]?.authStatus).toBe('needs-auth');
    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBeUndefined();
  });
});
