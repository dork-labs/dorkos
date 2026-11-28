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
 * - the PORT's handler settles the card and saves one wake per flow (spec
 *   `turns-survive-restarts` §6.3, T7); what the wake does next is the run
 *   record's (`services/runs/__tests__/wake-chat.test.ts`).
 *
 * @vitest-environment node
 */
import { createTestDb } from '@dorkos/test-utils/db';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resetKeyCache } from '../../../lib/secret-store/extension-secrets.js';

import { eq, turnEffects, type Db } from '@dorkos/db';
import { WakeRequestSchema, type WakeRequest } from '@dorkos/shared/turn-port';
import { AgentMcpOAuthService } from '../agent-mcp-oauth-service.js';
import { resumeAfterMcpSignin, type McpSigninConnectedEvent } from '../mcp-signin-resume.js';
import { installRunRecord, uninstallRunRecord, WAKE_NOT_LATE_MS } from '../../runs/index.js';
import { disposeProjector, getOrCreateProjector } from '../../session/index.js';
import { noteTurnHold, setContinuationHoldDb } from '../../core/turn-power/continuation-hold.js';

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
  /** The directory the sign-in recorded when it started — NOT the server default. */
  const SESSION_CWD = '/projects/somewhere-else';
  const NOW = Date.parse('2026-11-28T09:00:00.000Z');

  const EVENT: McpSigninConnectedEvent = {
    agentId: AGENT_ID,
    serverName: SERVER,
    sessionId: SESSION_ID,
    flowId: 'flow-1',
    originCwd: SESSION_CWD,
    toolCount: 7,
  };

  let db: Db;

  /** Every wake saved, by key, with its parsed request. */
  function wakes(): { key: string; wake: WakeRequest }[] {
    return db
      .select()
      .from(turnEffects)
      .where(eq(turnEffects.kind, 'wake_chat'))
      .all()
      .map((row) => ({ key: row.key, wake: WakeRequestSchema.parse(JSON.parse(row.payloadJson)) }));
  }

  beforeEach(() => {
    db = createTestDb();
    installRunRecord(db, { epoch: '01BOOTEPOCHSIGNIN000000000' });
  });

  afterEach(() => {
    uninstallRunRecord();
    setContinuationHoldDb(undefined);
    disposeProjector(SESSION_ID);
  });

  it('settles the session’s card, then saves one wake for the flow that must not run late', () => {
    const ingest = vi.spyOn(getOrCreateProjector(SESSION_ID, SESSION_CWD), 'ingest');

    resumeAfterMcpSignin(EVENT, NOW);
    resumeAfterMcpSignin(EVENT, NOW);

    expect(ingest.mock.calls[0]![0]).toEqual({
      type: 'mcp_signin_resolved',
      flowId: 'flow-1',
      outcome: 'connected',
      toolCount: 7,
    });
    const [saved, ...more] = wakes();
    expect(more, 'one flow, one resume').toEqual([]);
    expect(saved!.key).toBe('wake:signin:flow-1');
    expect(saved!.wake.start).toMatchObject({
      sessionId: SESSION_ID,
      // The flow's own directory: a restart empties the projector registry (DOR-981).
      cwd: SESSION_CWD,
      origin: { kind: 'resume' },
      // `whenBusy: 'refuse'` became a deadline: a busy chat is waited for, briefly.
      notAfter: NOW + WAKE_NOT_LATE_MS,
    });
    expect(saved!.wake.onlyIfChatExists).toEqual({ cwd: SESSION_CWD });
    const { content } = saved!.wake.start;
    expect(content).toContain('Continue the task');
    expect(content).toContain('Do not describe or narrate');
    expect(content).toContain(SERVER);
  });

  it('holds the nudge to the runtime default when the chat’s latest turn was held (DOR-3037)', () => {
    setContinuationHoldDb(createTestDb());
    noteTurnHold(SESSION_ID, true);
    resumeAfterMcpSignin(EVENT, NOW);
    noteTurnHold(SESSION_ID, false);
    resumeAfterMcpSignin({ ...EVENT, flowId: 'flow-2' }, NOW);
    const [held, free] = wakes().map(({ wake }) => wake.start);
    expect(held).toMatchObject({ permissionCeiling: 'runtime-default', continuationHold: true });
    expect(free!.permissionCeiling).toBeUndefined();
  });
});
