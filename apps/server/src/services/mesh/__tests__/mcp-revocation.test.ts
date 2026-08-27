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

import type { McpTargetProbeResult } from '../agent-mcp-target-probe.js';
// Imported rather than read at runtime: this suite shares a process pool with a
// test that deliberately injects `EMFILE` into `fs`, so a fixture read here is a
// real source of cross-file flake. The import is resolved at transform time.
import observedStatus from './fixtures/mcp-server-status-401.observed.json' with { type: 'json' };

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
  /** When true the token endpoint is unreachable rather than refusing — a blip, not a verdict. */
  refreshOffline: boolean;
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
        // The network is down, which says NOTHING about whether the grant is good.
        if (state.refreshOffline) throw new TypeError('fetch failed');
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
    workspace: { mode: 'home' },
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
    /** What the arbiter says. Defaults to "the server refused our token". */
    probeAnswer?: McpTargetProbeResult;
    /** Omit the probe entirely — a process that cannot check must not condemn. */
    noProbe?: boolean;
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
    refreshOffline: false,
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
  // The arbiter, controllable per test. Production wires the real reachability
  // probe here (`AgentMcpServerService.test`); its own suite covers the dialling.
  let probeAnswer: McpTargetProbeResult = options.probeAnswer ?? { ok: false, needsAuth: true };
  const setProbeAnswer = (answer: McpTargetProbeResult): void => {
    probeAnswer = answer;
  };
  const probe = vi.fn(async () => probeAnswer);
  const port = createMcpRevocationWatch({
    oauth,
    servers,
    ...(options.noProbe ? {} : { probe }),
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

  return {
    oauth,
    servers,
    watch,
    port,
    settled,
    cwd,
    dorkHome,
    provider,
    ingested,
    startSignin,
    probe,
    setProbeAnswer,
  };
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
    const { oauth, servers, watch, cwd, provider, ingested, probe } = await buildWorld();
    await signInFully(oauth, provider);

    // The state the bug reported: the row says Connected because DorkOS holds a
    // token, and it would go on saying so while every tool call 401'd.
    expect((await servers.list(AGENT_ID))[0]?.authStatus).toBe('connected');

    // The evidence a REAL turn produces for a bearer-carrying server whose token
    // the server refuses: `mcpAuthEvidenceFrom` distilled a `failed` entry, not a
    // `needs-auth` one. Keying on `needs-auth` — the first version of this feature
    // — meant this never fired at all.
    await watch({ sessionId: SESSION_ID, cwd, serverNames: [SERVER] });
    expect(probe).toHaveBeenCalledTimes(1);

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
    // The non-refreshable grant: there is no refresh token to try, and the probe
    // already proved the access token dead, so there is nothing left to recover.
    //
    // Evicting only the in-memory cache would leave the dead token set on disk,
    // and `warm` re-primes from disk — so the row would read "Connected" again
    // the moment the process restarted. The same lie, one restart later.
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

  it('investigates once when two turns report it in the same breath', async () => {
    // Two sessions in one workspace, both turns starting together. Neither has
    // finished investigating when the other arrives, so nothing they could look
    // up — not the token, not the flow store — has been written yet.
    //
    // The PROBE is what this asserts on, because the probe is the first thing an
    // investigation does and the only cost that is paid before any state has
    // changed: without the in-flight guard both reports dial the server. (The
    // second one would then find an already-evicted cache entry and bow out, so
    // counting sign-ins hides the duplicated work rather than catching it.)
    const { oauth, port, settled, cwd, provider, ingested, startSignin, probe } =
      await buildWorld();
    await signInFully(oauth, provider);
    startSignin.mockClear();

    port({ sessionId: SESSION_ID, cwd, serverNames: [SERVER] });
    port({ sessionId: 'sess-second', cwd, serverNames: [SERVER] });
    await vi.waitFor(() => expect(settled).toHaveLength(2));

    expect(probe).toHaveBeenCalledTimes(1);
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
  it('catches the bearer-refused server in the ACTUAL observed snapshot', async () => {
    // The anchor for the whole design, replayed from the recorded output of a
    // real turn rather than from a hand-written idea of what one looks like.
    //
    // Provenance: `fixtures/mcp-server-status-401.observed.json` is the verbatim
    // `query.mcpServerStatus()` array from one turn against
    // `@anthropic-ai/claude-agent-sdk` 0.3.177, with two MCP servers pointed at
    // an always-401 endpoint — one carrying a DorkOS-style bearer, one with no
    // credentials at all. Unrelated servers from that machine were removed; the
    // four entries kept are unedited. The harness is described in the module doc
    // of `mcp-revocation.ts` and is not run by any suite (it spends a real turn).
    const { mcpAuthEvidenceFrom } = await import('../mcp-revocation.js');
    const observed: Array<{ name: string; status?: string }> = observedStatus;

    // The bearer-carrying server is `failed`, NOT `needs-auth` — which is why
    // the first version of this feature never fired. Reverting the filter to
    // `needs-auth` only drops it and reddens this against real recorded data.
    expect(observed.find((s) => s.name.startsWith('dor981-bearer'))?.status).toBe('failed');
    expect(mcpAuthEvidenceFrom(observed)).toContain(
      observed.find((s) => s.name.startsWith('dor981-bearer'))!.name
    );
    // …and the two servers that were merely still connecting are left alone.
    expect(mcpAuthEvidenceFrom(observed)).not.toContain('shadcn');
  });

  it('looks at every server that did not come up — `failed` above all', async () => {
    const { mcpAuthEvidenceFrom } = await import('../mcp-revocation.js');

    expect(
      mcpAuthEvidenceFrom([
        // THE headline case, and the one the first version of this feature
        // missed entirely: a server carrying a DorkOS bearer that the server
        // refuses reports `failed`, never `needs-auth`. Observed live against
        // SDK 0.3.177 — see the module doc's empirical anchor.
        { name: 'bearer-refused', status: 'failed' },
        // The tokenless refusal. Worth looking at too, but never worth trusting:
        // the CLI replays this one from a 15-minute disk cache.
        { name: 'tokenless-refused', status: 'needs-auth' },
        // Not evidence of anything. `pending` means the snapshot was taken
        // before that server finished connecting; `disabled` means nobody asked.
        { name: 'slow', status: 'pending' },
        { name: 'off', status: 'disabled' },
        { name: 'fine', status: 'connected' },
        { name: 'unreported' },
      ])
    ).toEqual(['bearer-refused', 'tokenless-refused']);
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

describe('the probe is the arbiter, never the report', () => {
  it('stands down when the server accepts the token, and retires its own card', async () => {
    // The reviewer's reproduction, inverted — and the P0 the first version had.
    //
    // A person signs in mid-window. The next turn STILL reports the server as not
    // connected: the snapshot is stale, or the CLI is replaying a `needs-auth`
    // verdict it cached on disk for fifteen minutes and skipping the connection
    // entirely. Acting on that report deletes the grant they just created. The
    // probe dials for real, the server says yes, and nothing is touched — and the
    // card this module had put up is retired, so it cannot outlive its problem.
    const { oauth, servers, watch, cwd, provider, ingested, setProbeAnswer } = await buildWorld();
    await signInFully(oauth, provider);

    await watch({ sessionId: SESSION_ID, cwd, serverNames: [SERVER] });
    expect(ingested.map((event) => event.type)).toEqual(['mcp_signin_required']);
    const cardFlow = ingested[0]!.flowId;

    // The person signs in from that card, so a live token exists again…
    await signInFully(oauth, provider);
    setProbeAnswer({ ok: true, toolCount: 4 });

    // …and the very next turn still reports the server as failed.
    await watch({ sessionId: SESSION_ID, cwd, serverNames: [SERVER] });

    expect((await servers.list(AGENT_ID))[0]?.authStatus).toBe('connected');
    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBeDefined();
    // The stale card is settled rather than left telling someone to sign in to a
    // server they are already signed in to.
    expect(ingested.at(-1)).toEqual({
      type: 'mcp_signin_resolved',
      flowId: cardFlow,
      outcome: 'connected',
    });
  });

  it('settles an AGENT-minted card it adopted, once the server accepts the token', async () => {
    // The reach of `drawn` in one test. The agent asked for the sign-in, so the
    // flow is its own; this module only re-drew that card on a later failing
    // turn. When the probe then proves the server accepts the token DorkOS
    // holds, the link that card offers is moot whoever minted it — so it is
    // settled rather than left on screen. What is pinned here is that the
    // adopted flow IS in reach; the comment on `drawn` explains why that is safe.
    const { oauth, watch, cwd, provider, ingested, setProbeAnswer, startSignin } =
      await buildWorld();

    // An agent-initiated sign-in, left pending — no token yet.
    const agentFlow = await oauth.startSignin(TARGET, { originSessionId: SESSION_ID });
    expect(agentFlow.authorizeUrl).toBeDefined();
    startSignin.mockClear();

    // A failing turn re-draws that same flow's card rather than minting one.
    await watch({ sessionId: SESSION_ID, cwd, serverNames: [SERVER] });
    expect(startSignin).not.toHaveBeenCalled();
    expect(ingested).toEqual([
      expect.objectContaining({ type: 'mcp_signin_required', flowId: agentFlow.flowId }),
    ]);

    // The person finishes it; the server is healthy from here.
    provider.challenge = new URL(agentFlow.authorizeUrl!).searchParams.get('code_challenge') ?? '';
    await oauth.handleCallback({ state: agentFlow.flowId, code: AUTH_CODE });
    setProbeAnswer({ ok: true, toolCount: 3 });

    await watch({ sessionId: SESSION_ID, cwd, serverNames: [SERVER] });

    expect(ingested.at(-1)).toEqual({
      type: 'mcp_signin_resolved',
      flowId: agentFlow.flowId,
      outcome: 'connected',
    });
  });

  it('deletes nothing while a cached needs-auth verdict is being replayed', async () => {
    // The 15-minute window in full: DorkOS holds a good token, and every turn in
    // that window reports `needs-auth` from the CLI's own disk cache without ever
    // dialling the server. Nothing may be deleted, no card may appear, and the
    // row must keep telling the truth — for every one of those turns.
    const { oauth, servers, watch, cwd, provider, ingested, startSignin, probe } = await buildWorld(
      { probeAnswer: { ok: true, toolCount: 9 } }
    );
    await signInFully(oauth, provider);
    startSignin.mockClear();
    const token = oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL);

    for (let turn = 0; turn < 3; turn++) {
      await watch({ sessionId: SESSION_ID, cwd, serverNames: [SERVER] });
    }

    expect(probe).toHaveBeenCalledTimes(3);
    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBe(token);
    expect((await servers.list(AGENT_ID))[0]?.authStatus).toBe('connected');
    expect(ingested).toEqual([]);
    expect(startSignin).not.toHaveBeenCalled();
    // Not one refresh either: a healthy probe ends the investigation outright.
    expect(provider.grants).not.toContain('refresh_token');
  });

  it('condemns nothing when no probe is wired — a process that cannot check must not judge', async () => {
    const { oauth, servers, watch, cwd, provider, ingested } = await buildWorld({ noProbe: true });
    await signInFully(oauth, provider);

    await watch({ sessionId: SESSION_ID, cwd, serverNames: [SERVER] });

    expect((await servers.list(AGENT_ID))[0]?.authStatus).toBe('connected');
    expect(ingested).toEqual([]);
  });

  it('condemns nothing when the server is merely unreachable', async () => {
    // A probe that failed without a 401 is not a refusal — the host is down, DNS
    // is broken, the laptop is on a plane. `tokenWasRefused` is deliberately
    // narrower than "not ok" for exactly this.
    const { oauth, servers, watch, cwd, provider, ingested } = await buildWorld({
      probeAnswer: { ok: false },
    });
    await signInFully(oauth, provider);

    await watch({ sessionId: SESSION_ID, cwd, serverNames: [SERVER] });

    expect((await servers.list(AGENT_ID))[0]?.authStatus).toBe('connected');
    expect(ingested).toEqual([]);
  });
});

describe('what a failed refresh is allowed to cost', () => {
  it('keeps the stored grant when the refresh only ran out of attempts', async () => {
    // The probe proved the ACCESS token is dead, so the cached one goes and the
    // row tells the truth. But the refresh failed on transport, which proves
    // nothing about the GRANT — so the stored credential survives, and a restart's
    // `warm` can still recover it. Deleting here would make a flapping network
    // indistinguishable from a revocation.
    const { oauth, servers, watch, cwd, provider, dorkHome, ingested } = await buildWorld({
      issueRefreshToken: true,
    });
    await signInFully(oauth, provider);
    provider.refreshOffline = true;

    await watch({ sessionId: SESSION_ID, cwd, serverNames: [SERVER] });

    // Cache dropped: the row is honest and the next turn will retry.
    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBeUndefined();
    expect((await servers.list(AGENT_ID))[0]?.authStatus).toBe('needs-auth');
    // No card: nobody is asked to sign in again over a network blip.
    expect(ingested).toEqual([]);

    // And the grant is still on disk — a restart picks it straight back up.
    const { AgentMcpOAuthService } = await import('../agent-mcp-oauth-service.js');
    const afterRestart = new AgentMcpOAuthService({
      dorkHome,
      callbackBaseUrl: 'http://127.0.0.1:4242',
      fetchImpl: mockOAuthFetch(provider),
      cache: { scheduler: inertScheduler },
      logger: { warn: () => {} },
    });
    await afterRestart.warm([TARGET]);
    expect(afterRestart.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBeDefined();
  });
});
