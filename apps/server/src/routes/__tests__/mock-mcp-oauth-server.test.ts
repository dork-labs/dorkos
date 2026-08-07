/**
 * Tests for the test-mode mock OAuth-protected MCP server (DOR-952, hardened in
 * DOR-988).
 *
 * This mock is the thing the managed-MCP OAuth browser spec measures itself
 * against, so its gates ARE the evidence that spec produces. A gate that says
 * yes to everything turns a green e2e into a green e2e that proves nothing, and
 * that is not hypothetical: the refresh grant used to mint a valid access token
 * for any string at all, while the spec's header advertised refresh as covered.
 *
 * The browser spec cannot cover the refresh grant — it finishes in seconds and
 * the mock's access tokens live an hour, so the SDK never refreshes. These tests
 * drive the grant directly instead, plus the authorize allowlist, the PKCE and
 * expiry checks, the bearer gate, and the reset seam.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';

import {
  MOCK_MCP_OAUTH_BASE,
  MOCK_MCP_OAUTH_MCP_PATH,
  createMockMcpOAuthRouter,
  resetMockMcpOAuthState,
} from '../mock-mcp-oauth-server.js';

/** The mock is mounted at the app root, exactly as `app.ts` mounts it. */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(createMockMcpOAuthRouter());
  return app;
}

const app = buildApp();

/** A loopback callback URL of the shape the DorkOS OAuth client registers. */
const CALLBACK = 'http://127.0.0.1:4242/api/agents/mcp-oauth/callback';

/** Register a client through DCR and return its `client_id`. */
async function registerClient(): Promise<string> {
  const res = await request(app)
    .post(`${MOCK_MCP_OAUTH_BASE}/register`)
    .send({ redirect_uris: [CALLBACK] });
  expect(res.status).toBe(201);
  return res.body.client_id as string;
}

/** Run a full PKCE authorization-code flow and return the issued token pair. */
async function signIn(): Promise<{ accessToken: string; refreshToken: string }> {
  const clientId = await registerClient();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const authorized = await request(app).get(`${MOCK_MCP_OAUTH_BASE}/authorize`).query({
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-1',
  });
  expect(authorized.status).toBe(302);
  const code = new URL(authorized.headers.location).searchParams.get('code');
  expect(code).toBeTruthy();

  const token = await request(app)
    .post(`${MOCK_MCP_OAUTH_BASE}/token`)
    .type('form')
    .send({ grant_type: 'authorization_code', code: code!, code_verifier: verifier });
  expect(token.status).toBe(200);
  return {
    accessToken: token.body.access_token as string,
    refreshToken: token.body.refresh_token as string,
  };
}

/** Send an MCP `initialize` to the protected endpoint with the given auth header. */
function callMcp(authorization?: string) {
  const req = request(app)
    .post(MOCK_MCP_OAUTH_MCP_PATH)
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json');
  if (authorization !== undefined) req.set('Authorization', authorization);
  return req.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    },
  });
}

beforeEach(() => {
  resetMockMcpOAuthState();
});

describe('mock OAuth server — the refresh grant', () => {
  it('exchanges a refresh token it issued for a working access token', async () => {
    const { refreshToken } = await signIn();

    const res = await request(app)
      .post(`${MOCK_MCP_OAUTH_BASE}/token`)
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: refreshToken });

    expect(res.status).toBe(200);
    const refreshed = res.body.access_token as string;
    expect(refreshed).toBeTruthy();
    // Not merely well-formed: it opens the bearer gate.
    expect((await callMcp(`Bearer ${refreshed}`)).status).toBe(200);
  });

  it('rejects a refresh token it never issued', async () => {
    await signIn();

    const res = await request(app)
      .post(`${MOCK_MCP_OAUTH_BASE}/token`)
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: 'mock-refresh-not-a-real-token' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_grant' });
  });

  it('rejects a missing refresh token rather than treating it as valid', async () => {
    const res = await request(app)
      .post(`${MOCK_MCP_OAUTH_BASE}/token`)
      .type('form')
      .send({ grant_type: 'refresh_token' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_grant' });
  });

  it('rotates: the presented refresh token is spent, and the new one works', async () => {
    const { refreshToken } = await signIn();

    const first = await request(app)
      .post(`${MOCK_MCP_OAUTH_BASE}/token`)
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: refreshToken });
    expect(first.status).toBe(200);
    const rotated = first.body.refresh_token as string;
    expect(rotated).not.toBe(refreshToken);

    const replay = await request(app)
      .post(`${MOCK_MCP_OAUTH_BASE}/token`)
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: refreshToken });
    expect(replay.status).toBe(400);

    const next = await request(app)
      .post(`${MOCK_MCP_OAUTH_BASE}/token`)
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: rotated });
    expect(next.status).toBe(200);
  });

  it('rejects a grant type it does not implement', async () => {
    const res = await request(app)
      .post(`${MOCK_MCP_OAUTH_BASE}/token`)
      .type('form')
      .send({ grant_type: 'client_credentials' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'unsupported_grant_type' });
  });
});

describe('mock OAuth server — the authorization-code grant', () => {
  it('rejects a code whose PKCE verifier does not match', async () => {
    const clientId = await registerClient();
    const challenge = createHash('sha256').update('the-real-verifier').digest('base64url');
    const authorized = await request(app)
      .get(`${MOCK_MCP_OAUTH_BASE}/authorize`)
      .query({ client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge });
    const code = new URL(authorized.headers.location).searchParams.get('code')!;

    const res = await request(app)
      .post(`${MOCK_MCP_OAUTH_BASE}/token`)
      .type('form')
      .send({ grant_type: 'authorization_code', code, code_verifier: 'a-different-verifier' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_grant' });
  });

  it('rejects a code that has been sitting unexchanged for over ten minutes', async () => {
    vi.useFakeTimers();
    try {
      const clientId = await registerClient();
      const verifier = 'verifier-for-the-stale-code';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const authorized = await request(app)
        .get(`${MOCK_MCP_OAUTH_BASE}/authorize`)
        .query({ client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge });
      const code = new URL(authorized.headers.location).searchParams.get('code')!;

      vi.advanceTimersByTime(10 * 60 * 1000 + 1);

      const res = await request(app)
        .post(`${MOCK_MCP_OAUTH_BASE}/token`)
        .type('form')
        .send({ grant_type: 'authorization_code', code, code_verifier: verifier });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_grant' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('mock OAuth server — the authorize endpoint', () => {
  it('refuses a client_id that never registered through DCR', async () => {
    const res = await request(app)
      .get(`${MOCK_MCP_OAUTH_BASE}/authorize`)
      .query({ client_id: 'mock-client-invented', redirect_uri: CALLBACK });

    expect(res.status).toBe(400);
    expect(res.headers.location).toBeUndefined();
  });

  it.each([
    ['an off-machine host', 'http://evil.example.com/api/agents/mcp-oauth/callback'],
    ['a loopback host with the wrong path', 'http://127.0.0.1:4242/somewhere/else'],
    ['a non-http scheme', 'file:///api/agents/mcp-oauth/callback'],
    ['nothing at all', ''],
  ])('refuses to redirect to %s', async (_label, redirectUri) => {
    const clientId = await registerClient();
    const res = await request(app)
      .get(`${MOCK_MCP_OAUTH_BASE}/authorize`)
      .query({ client_id: clientId, redirect_uri: redirectUri });

    expect(res.status).toBe(400);
    expect(res.headers.location).toBeUndefined();
  });
});

describe('mock OAuth server — the bearer gate', () => {
  it('401s with a resource_metadata pointer when no token is presented', async () => {
    const res = await callMcp();
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/resource_metadata=/);
  });

  it('401s for a token it never issued', async () => {
    const res = await callMcp('Bearer mock-access-invented');
    expect(res.status).toBe(401);
  });

  // RFC 6750 §2.1: the scheme name is case-insensitive. A client that sends
  // `bearer` is not an unauthorized client.
  it.each(['Bearer', 'bearer', 'BEARER'])('accepts the %s scheme spelling', async (scheme) => {
    const { accessToken } = await signIn();
    const res = await callMcp(`${scheme} ${accessToken}`);
    expect(res.status).toBe(200);
  });

  it('stops accepting an issued token once the state is reset', async () => {
    const { accessToken } = await signIn();
    expect((await callMcp(`Bearer ${accessToken}`)).status).toBe(200);

    resetMockMcpOAuthState();

    expect((await callMcp(`Bearer ${accessToken}`)).status).toBe(401);
  });
});

afterEach(() => {
  resetMockMcpOAuthState();
});
