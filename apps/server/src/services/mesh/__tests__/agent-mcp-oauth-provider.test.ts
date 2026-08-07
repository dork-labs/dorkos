/**
 * {@link McpOAuthClientProvider} driven by the REAL MCP SDK `auth()` (DOR-986).
 *
 * The bug this suite exists for could not be seen from DorkOS's own code: the
 * provider looked complete, and the recovery it was missing lives inside the
 * SDK's `auth()` catch block. So these tests do what the reviewer's probe did —
 * hand the real provider to the real orchestrator over an in-process mock OAuth
 * server and watch what the SDK actually does with it. No network.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { ExtensionSecretStore, resetKeyCache } from '@dorkos/shared/extension-secrets';

import { McpOAuthClientProvider, McpOAuthSecretStore } from '../agent-mcp-oauth-provider.js';
import { McpOAuthFlowStore } from '../agent-mcp-oauth-flow-store.js';

const AGENT_ID = '01HV7KJZZZ0000000000000000';
const SERVER = 'granola';
const ORIGIN = 'https://mcp.test.local';
const SERVER_URL = `${ORIGIN}/mcp`;
const CALLBACK = 'http://127.0.0.1:4242/api/agents/mcp-oauth/callback';

const tempDirs: string[] = [];
afterEach(async () => {
  resetKeyCache();
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** JSON Response helper. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A mock OAuth server whose token endpoint rejects every refresh as
 * `invalid_grant` — the shape of a refresh token the user revoked upstream.
 */
function revokingFetch(seen: URLSearchParams[]): typeof fetch {
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
        redirect_uris: [CALLBACK],
        token_endpoint_auth_method: 'none',
      });
    }
    if (method === 'POST' && url.endsWith('/token')) {
      seen.push(new URLSearchParams(String(init?.body)));
      return json({ error: 'invalid_grant', error_description: 'refresh token revoked' }, 400);
    }
    return new Response('not found', { status: 404 });
  };
}

/** A provider over a real encrypted store in a throwaway dorkHome. */
async function makeProvider(): Promise<{
  provider: McpOAuthClientProvider;
  secrets: McpOAuthSecretStore;
  flows: McpOAuthFlowStore;
  state: string;
}> {
  const dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-oauth-provider-'));
  tempDirs.push(dorkHome);
  const secrets = new McpOAuthSecretStore(new ExtensionSecretStore('mcp-oauth', dorkHome));
  const flows = new McpOAuthFlowStore();
  const state = 'state-1';
  flows.start(state, { agentId: AGENT_ID, serverName: SERVER, serverUrl: SERVER_URL });
  const provider = new McpOAuthClientProvider({
    agentId: AGENT_ID,
    serverName: SERVER,
    serverUrl: SERVER_URL,
    state,
    redirectUri: CALLBACK,
    secrets,
    flows,
  });
  return { provider, secrets, flows, state };
}

describe('McpOAuthClientProvider.invalidateCredentials — recovering from a revoked grant', () => {
  it('lets the SDK retry into a fresh authorize URL instead of throwing', async () => {
    const { provider, secrets, flows, state } = await makeProvider();
    await secrets.saveClientInformation(AGENT_ID, SERVER, {
      client_id: 'test-client-id',
      redirect_uris: [CALLBACK],
    });
    await secrets.saveTokens(
      AGENT_ID,
      SERVER,
      { access_token: 'old', token_type: 'Bearer', refresh_token: 'revoked' },
      SERVER_URL
    );

    const tokenCalls: URLSearchParams[] = [];
    const result = await auth(provider, {
      serverUrl: SERVER_URL,
      fetchFn: revokingFetch(tokenCalls),
    });

    // Deleting `invalidateCredentials` from the provider makes the SDK's retry
    // replay the same dead refresh token, so `auth()` THROWS InvalidGrantError
    // and every assertion below reddens — which is exactly the state that left
    // `mcp.signin` unable to ever produce a sign-in link again.
    expect(result).toBe('REDIRECT');
    expect(flows.authorizeUrl(state)).toContain(`${ORIGIN}/authorize`);
    // The dead token set is gone from disk, so the next attempt starts clean.
    expect(await secrets.tokens(AGENT_ID, SERVER)).toBeUndefined();
    // Discriminator: the refresh really was attempted before we recovered.
    expect(tokenCalls.map((c) => c.get('grant_type'))).toEqual(['refresh_token']);
  });

  it('drops exactly the scope it is asked to drop', async () => {
    const { provider, secrets, flows, state } = await makeProvider();
    await secrets.saveClientInformation(AGENT_ID, SERVER, {
      client_id: 'test-client-id',
      redirect_uris: [CALLBACK],
    });
    await secrets.saveTokens(
      AGENT_ID,
      SERVER,
      { access_token: 'old', token_type: 'Bearer' },
      SERVER_URL
    );
    flows.setVerifier(state, 'verifier-1');

    await provider.invalidateCredentials('tokens');
    // 'tokens' must not take the registration or the verifier with it — otherwise
    // every recoverable refresh failure would force a whole new DCR round trip.
    expect(await secrets.tokens(AGENT_ID, SERVER)).toBeUndefined();
    expect(await secrets.clientInformation(AGENT_ID, SERVER)).toBeDefined();
    expect(flows.claimVerifier(state)).toBe('verifier-1');

    flows.setVerifier(state, 'verifier-2');
    await provider.invalidateCredentials('client');
    expect(await secrets.clientInformation(AGENT_ID, SERVER)).toBeUndefined();
    expect(flows.claimVerifier(state)).toBe('verifier-2');

    await secrets.saveTokens(
      AGENT_ID,
      SERVER,
      { access_token: 'again', token_type: 'Bearer' },
      SERVER_URL
    );
    await secrets.saveClientInformation(AGENT_ID, SERVER, {
      client_id: 'test-client-id',
      redirect_uris: [CALLBACK],
    });
    flows.setVerifier(state, 'verifier-3');
    await provider.invalidateCredentials('all');
    expect(await secrets.tokens(AGENT_ID, SERVER)).toBeUndefined();
    expect(await secrets.clientInformation(AGENT_ID, SERVER)).toBeUndefined();
    expect(flows.claimVerifier(state)).toBeNull();
  });
});

describe('McpOAuthSecretStore.serverNames', () => {
  it('recovers one agent’s server names from the key namespace, and only that agent’s', async () => {
    const { secrets } = await makeProvider();
    await secrets.saveTokens(
      AGENT_ID,
      SERVER,
      { access_token: 'a', token_type: 'Bearer' },
      SERVER_URL
    );
    // Client info only, no token: still a server the deleted-agent cascade must
    // forget, so the name has to come back from either kind of key.
    await secrets.saveClientInformation(AGENT_ID, 'other', {
      client_id: 'c1',
      redirect_uris: [CALLBACK],
    });
    await secrets.saveTokens(
      'agent-2',
      SERVER,
      { access_token: 'b', token_type: 'Bearer' },
      SERVER_URL
    );

    // This listing is the ONLY record of what an unregistered agent had — its
    // manifest is already gone. Returning nothing here means the cascade forgets
    // nothing and the tokens outlive the agent.
    expect((await secrets.serverNames(AGENT_ID)).sort()).toEqual(['granola', 'other']);
    // The discriminator against a prefix bug that claims every agent's servers.
    expect(await secrets.serverNames('agent-2')).toEqual([SERVER]);
    expect(await secrets.serverNames('never-seen')).toEqual([]);
  });
});
