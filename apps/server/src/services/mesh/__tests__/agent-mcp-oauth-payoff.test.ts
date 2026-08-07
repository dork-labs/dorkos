/**
 * What a completed managed-MCP sign-in is worth, and whether "already connected"
 * is true (DOR-1003).
 *
 * Two behaviours, both riding the injected probe:
 *
 * 1. **The payoff.** Once a flow reports `connected`, the server is dialled once
 *    and the poll carries `toolCount` — the count the operator just unlocked. A
 *    probe that cannot answer never downgrades the connection; the count is
 *    simply absent.
 * 2. **The honesty check.** `alreadyConnected` used to mean "a token is on disk".
 *    A token the server refuses now produces a fresh sign-in link instead, with
 *    the dead credential cleared (the DOR-986 invalidation seam).
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resetKeyCache } from '@dorkos/shared/extension-secrets';

import {
  AgentMcpOAuthService,
  type McpTargetProbe,
  type McpTargetProbeResult,
} from '../agent-mcp-oauth-service.js';

const AGENT_ID = '01HV7KJZZZ0000000000000000';
const SERVER = 'granola';
const ORIGIN = 'https://mcp.test.local';
const SERVER_URL = `${ORIGIN}/mcp`;
const AUTH_CODE = 'auth-code-xyz';
const CALLBACK_BASE = 'http://127.0.0.1:4242';
const TARGET = { agentId: AGENT_ID, serverName: SERVER, serverUrl: SERVER_URL };

const tempDirs: string[] = [];
afterEach(async () => {
  resetKeyCache();
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** A scheduler that captures but never fires — background refresh is out of scope here. */
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

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** A mock OAuth provider: discovery, DCR, and a PKCE-validating token endpoint. */
function mockOAuthFetch(pkce: { challenge: string }): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

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
    if (method === 'POST' && url.endsWith('/register')) {
      return json({
        client_id: 'test-client-id',
        redirect_uris: [`${CALLBACK_BASE}/api/agents/mcp-oauth/callback`],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: 'DorkOS',
      });
    }
    if (method === 'POST' && url.endsWith('/token')) {
      const form = readForm(init);
      if (form.get('grant_type') === 'refresh_token') {
        return json({
          access_token: 'access-2',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'refresh-1',
        });
      }
      const verifierOk = s256(form.get('code_verifier') ?? '') === pkce.challenge;
      if (form.get('code') !== AUTH_CODE || !verifierOk) {
        return json({ error: 'invalid_grant' }, 400);
      }
      return json({
        access_token: 'access-1',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'refresh-1',
      });
    }
    return new Response('not found', { status: 404 });
  };
}

/** Build an engine over a fresh dorkHome, wired to `probe`. */
async function buildEngine(probe?: McpTargetProbe): Promise<{
  oauth: AgentMcpOAuthService;
  pkce: { challenge: string };
}> {
  const dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-payoff-home-'));
  tempDirs.push(dorkHome);
  const pkce = { challenge: '' };
  const oauth = new AgentMcpOAuthService({
    dorkHome,
    callbackBaseUrl: CALLBACK_BASE,
    fetchImpl: mockOAuthFetch(pkce),
    cache: { scheduler: inertScheduler },
    logger: { warn: () => {} },
    ...(probe ? { probe } : {}),
  });
  return { oauth, pkce };
}

/** Drive a full browser sign-in and return the flow id, now `connected`. */
async function signInFully(
  oauth: AgentMcpOAuthService,
  pkce: { challenge: string }
): Promise<string> {
  const started = await oauth.startSignin(TARGET);
  expect(started.alreadyConnected).toBe(false);
  pkce.challenge = new URL(started.authorizeUrl!).searchParams.get('code_challenge') ?? '';
  const cb = await oauth.handleCallback({ state: started.flowId, code: AUTH_CODE });
  expect(cb).toEqual({ connected: true, serverName: SERVER });
  return started.flowId;
}

describe('pollSignin — the payoff', () => {
  it('reports how many tools the sign-in unlocked', async () => {
    const { oauth, pkce } = await buildEngine(async () => ({ ok: true, toolCount: 12 }));
    const flowId = await signInFully(oauth, pkce);

    // Reverting the probe call (returning the bare flow status) drops toolCount
    // and reddens this.
    expect(await oauth.pollSignin(flowId)).toEqual({ status: 'connected', toolCount: 12 });
  });

  it('still reports connected — without a count — when the count cannot be taken', async () => {
    const { oauth, pkce } = await buildEngine(async () => {
      throw new Error('the server hung up');
    });
    const flowId = await signInFully(oauth, pkce);

    // The sign-in succeeded. A failed second round trip is not allowed to turn
    // that into a failure, or into a fabricated zero.
    const polled = await oauth.pollSignin(flowId);
    expect(polled.status).toBe('connected');
    expect(polled.toolCount).toBeUndefined();
    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBe('access-1');
  });

  it('leaves a pending flow alone (nothing to count yet)', async () => {
    let probed = false;
    const { oauth } = await buildEngine(async () => {
      probed = true;
      return { ok: true, toolCount: 9 };
    });
    const started = await oauth.startSignin(TARGET);

    expect(await oauth.pollSignin(started.flowId)).toEqual({ status: 'pending' });
    expect(probed).toBe(false);
  });
});

describe('startSignin — alreadyConnected has to be proven', () => {
  /** The stored-token path: sign in for real, then ask again. */
  async function signInTwice(probeSecondTime: McpTargetProbeResult) {
    let calls = 0;
    const probe: McpTargetProbe = async () => {
      calls += 1;
      return calls === 1 ? { ok: true, toolCount: 4 } : probeSecondTime;
    };
    const { oauth, pkce } = await buildEngine(probe);
    await signInFully(oauth, pkce);
    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBe('access-1');
    // First probe consumed above so the second startSignin sees `probeSecondTime`.
    calls = 1;
    return { oauth, again: await oauth.startSignin(TARGET) };
  }

  it('reports alreadyConnected when the stored token still works', async () => {
    const { again } = await signInTwice({ ok: true, toolCount: 4 });

    expect(again.alreadyConnected).toBe(true);
    expect(again.authorizeUrl).toBeUndefined();
  });

  it('hands back a fresh sign-in link when the stored token is refused', async () => {
    const { oauth, again } = await signInTwice({ ok: false, needsAuth: true });

    // Not "already connected" — the server said no. Reverting the proof step
    // (trusting AUTHORIZED) makes this report alreadyConnected with no link.
    expect(again.alreadyConnected).toBe(false);
    expect(again.authorizeUrl).toContain(`${ORIGIN}/authorize`);
    // And the dead credential is gone, not left to be re-offered next time.
    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBeUndefined();
  });

  it('keeps trusting AUTHORIZED when no probe is wired at all', async () => {
    const { oauth, pkce } = await buildEngine();
    await signInFully(oauth, pkce);

    const again = await oauth.startSignin(TARGET);
    expect(again.alreadyConnected).toBe(true);
  });
});
