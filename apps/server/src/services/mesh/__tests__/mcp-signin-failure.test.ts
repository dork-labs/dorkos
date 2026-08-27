/**
 * What a person is told when a managed-MCP sign-in cannot even be started
 * (DOR-982), end to end: from the mock provider's real response, through the SDK
 * `auth()` throw, to the `{ error, code, detail }` payload `mcp.signin` rejects
 * with and every surface renders.
 *
 * The classification is deliberately NOT read off the error message, so each
 * case here is expressed as a PROVIDER SHAPE — what the server publishes — and
 * never as a string the SDK happened to produce.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { noopLogger } from '@dorkos/shared/logger';
import { AgentRegistry } from '@dorkos/mesh';
import { createTestDb } from '@dorkos/test-utils/db';
import { resetKeyCache } from '@dorkos/shared/extension-secrets';
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

import { mcpDomain } from '../mcp-capabilities.js';
import { AgentMcpOAuthService } from '../agent-mcp-oauth-service.js';
import { AgentMcpServerService, type AgentWorkspaceLocator } from '../agent-mcp-server-service.js';
import { McpSigninStartError } from '../mcp-signin-failure.js';
import { CapabilityToolError } from '../../core/capabilities/mcp-envelope.js';
import type { CapabilityDeps, CapabilityDefinition } from '../../core/capabilities/index.js';

const AGENT_ID = '01HV7KJZZZ0000000000000000';
const SERVER = 'granola';
const ORIGIN = 'https://mcp.test.local';
const SERVER_URL = `${ORIGIN}/mcp`;
const CALLBACK_BASE = 'http://127.0.0.1:4242';
const TARGET = { agentId: AGENT_ID, serverName: SERVER, serverUrl: SERVER_URL };

const tempDirs: string[] = [];
afterEach(async () => {
  resetKeyCache();
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

const inertScheduler = {
  set: (): ReturnType<typeof setTimeout> => 0 as unknown as ReturnType<typeof setTimeout>,
  clear: (): void => {},
};

/** JSON Response helper. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The metadata a working OAuth server publishes, minus whatever a case removes. */
function metadata(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    issuer: ORIGIN,
    authorization_endpoint: `${ORIGIN}/authorize`,
    token_endpoint: `${ORIGIN}/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    ...extra,
  };
}

/**
 * A provider that answers discovery with `meta` (or 404s discovery entirely when
 * it is `null`) and answers `POST /register` with `registerStatus`.
 */
function providerFetch(args: {
  meta: Record<string, unknown> | null;
  registerStatus?: number;
  registerBody?: string;
}): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('oauth-protected-resource')) {
      return json({ resource: SERVER_URL, authorization_servers: [ORIGIN] });
    }
    if (url.includes('oauth-authorization-server') || url.includes('openid-configuration')) {
      // A 4xx is how a server says "no OAuth metadata here"; the SDK moves on to
      // the next candidate URL and ends up with no metadata at all.
      return args.meta ? json(args.meta) : new Response('nope', { status: 404 });
    }
    if ((init?.method ?? 'GET') === 'POST' && url.endsWith('/register')) {
      return new Response(args.registerBody ?? '<html>Not Found</html>', {
        status: args.registerStatus ?? 404,
      });
    }
    return new Response('not found', { status: 404 });
  };
}

/** An engine over a throwaway dorkHome. */
async function makeService(fetchImpl: typeof fetch): Promise<AgentMcpOAuthService> {
  const dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-signin-failure-'));
  tempDirs.push(dorkHome);
  return new AgentMcpOAuthService({
    dorkHome,
    callbackBaseUrl: CALLBACK_BASE,
    fetchImpl,
    cache: { scheduler: inertScheduler },
    logger: { warn: () => {} },
  });
}

/** The failure `startSignin` threw, or a hard fail if it did not throw one. */
async function failureOf(oauth: AgentMcpOAuthService): Promise<McpSigninStartError['failure']> {
  try {
    await oauth.startSignin(TARGET);
  } catch (err) {
    if (err instanceof McpSigninStartError) return err.failure;
    throw err;
  }
  throw new Error('startSignin resolved; this case is supposed to fail');
}

describe('classifying a sign-in that never got off the ground', () => {
  it('names the fixable one when the provider refuses to register DorkOS', async () => {
    const oauth = await makeService(
      providerFetch({ meta: metadata({ registration_endpoint: `${ORIGIN}/register` }) })
    );

    const failure = await failureOf(oauth);

    expect(failure.code).toBe('SIGNIN_NO_APP_REGISTRATION');
    expect(failure.message).toContain('doesn’t let DorkOS register itself');
    expect(failure.message).toContain('app credentials');
    // The raw text is kept, but as a detail — never as the headline.
    expect(failure.detail).toContain('404');
    expect(failure.message).not.toContain('404');
  });

  it('says the same when the provider advertises no registration endpoint at all', async () => {
    // The SDK does not even try the network here — it throws off the metadata.
    // Same fix for the person, so the same family.
    const oauth = await makeService(providerFetch({ meta: metadata({}) }));

    const failure = await failureOf(oauth);

    expect(failure.code).toBe('SIGNIN_NO_APP_REGISTRATION');
    expect(failure.detail).toContain('dynamic client registration');
  });

  it('does NOT offer credentials when the server publishes no OAuth details', async () => {
    // Nothing to register WITH: sending this person hunting for app credentials
    // would send them after something that does not exist. Drop the
    // `metadataFound` signal and this collapses into the case above.
    const oauth = await makeService(providerFetch({ meta: null }));

    const failure = await failureOf(oauth);

    expect(failure.code).toBe('SIGNIN_NO_SIGNIN_SUPPORT');
    expect(failure.message).toContain('doesn’t offer sign-in the way DorkOS expects');
  });

  it('truncates a provider that answers with a whole error page', async () => {
    // `parseErrorResponse` folds the ENTIRE response body into its message, so a
    // provider serving a full HTML error page puts kilobytes of markup into the
    // detail — which then rides a capability payload into a card and, on the
    // agent-facing surfaces, a transcript. It is cut to a length that still
    // identifies the failure.
    const wall = `<html>${'x'.repeat(5000)}</html>`;
    const oauth = await makeService(
      providerFetch({
        meta: metadata({ registration_endpoint: `${ORIGIN}/register` }),
        registerBody: wall,
      })
    );

    const failure = await failureOf(oauth);

    expect(failure.code).toBe('SIGNIN_NO_APP_REGISTRATION');
    expect(failure.detail.length).toBeLessThanOrEqual(401);
    expect(failure.detail.endsWith('…')).toBe(true);
    // The useful head survives the cut — a detail trimmed to nothing would be
    // no better than dropping it.
    expect(failure.detail).toContain('404');
  });

  it('falls back to plain unreachable when the server cannot be reached', async () => {
    const oauth = await makeService(() => Promise.reject(new TypeError('fetch failed')));

    const failure = await failureOf(oauth);

    expect(failure.code).toBe('SIGNIN_UNREACHABLE');
    expect(failure.message).toContain('Couldn’t reach the server');
  });

  it('stops classifying once a stored client makes registration moot', async () => {
    // Same refusing provider, but the operator has supplied credentials — the
    // failure moves past registration, so it must stop advertising the fix the
    // person has already applied.
    const oauth = await makeService(
      providerFetch({ meta: metadata({ registration_endpoint: `${ORIGIN}/register` }) })
    );
    await oauth.saveManualClientInfo(TARGET, { clientId: 'operator-app-id' });

    // With a client identity in hand this provider CAN start a sign-in, so there
    // is no failure left to classify — which is the point.
    const started = await oauth.startSignin(TARGET);
    expect(started.authorizeUrl).toContain('client_id=operator-app-id');
  });
});

class FakeLocator implements AgentWorkspaceLocator {
  constructor(private readonly projectPath: string) {}
  get(agentId: string): { projectPath: string } | undefined {
    return agentId === AGENT_ID ? { projectPath: this.projectPath } : undefined;
  }
}

function capability(id: string): CapabilityDefinition {
  const found = mcpDomain.capabilities.find((c) => c.id === id);
  if (!found) throw new Error(`mcp domain no longer declares ${id}`);
  return found;
}

/** A workspace with one remote managed server, wired to a failing provider. */
async function setupCapabilityDeps(fetchImpl: typeof fetch): Promise<CapabilityDeps> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-signin-failure-ws-'));
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
        connection: { transport: 'http', url: SERVER_URL, headers: {} },
        addedAt: '2026-08-06T00:00:00.000Z',
        addedBy: 'operator',
      },
    ],
  };
  await writeManifest(projectPath, manifest);
  const service = new AgentMcpServerService({ agents: new FakeLocator(projectPath) });
  const oauth = await makeService(fetchImpl);
  return {
    logger: noopLogger,
    mcpDeps: { service, agents: new AgentRegistry(createTestDb()), oauth },
  };
}

describe('mcp.signin, when the sign-in cannot start', () => {
  it('rejects with the plain family, its code, and the raw text demoted to detail', async () => {
    const deps = await setupCapabilityDeps(
      providerFetch({ meta: metadata({ registration_endpoint: `${ORIGIN}/register` }) })
    );

    const raised = await capability('mcp.signin')
      .invoke(deps, { agentId: AGENT_ID, name: SERVER }, { identity: undefined } as never)
      .then(
        () => undefined,
        (err: unknown) => err
      );

    expect(raised).toBeInstanceOf(CapabilityToolError);
    const payload = (raised as CapabilityToolError).payload as {
      error: string;
      code?: string;
      detail?: string;
    };
    // Losing the classification (re-raising `err.message` as it used to) makes
    // `code` undefined and puts the OAuth 404 in `error` — which is the exact
    // regression this pins.
    expect(payload.code).toBe('SIGNIN_NO_APP_REGISTRATION');
    expect(payload.error).toContain('doesn’t let DorkOS register itself');
    expect(payload.detail).toContain('404');
  });

  it('keeps mcp.set_client off every MCP tool surface', async () => {
    // The input carries a client secret, and an MCP tool call is recorded in the
    // session transcript. Adding an `mcp` surface here would publish it.
    expect(capability('mcp.set_client').surfaces.mcp).toBeUndefined();
    expect(capability('mcp.set_client').surfaces.http).toBeDefined();
  });

  it('stores credentials and lets the retry through', async () => {
    const deps = await setupCapabilityDeps(
      providerFetch({ meta: metadata({ registration_endpoint: `${ORIGIN}/register` }) })
    );

    const saved = await capability('mcp.set_client').invoke(
      deps,
      {
        agentId: AGENT_ID,
        name: SERVER,
        clientId: 'operator-app-id',
        clientSecret: 'operator-app-secret',
      },
      { identity: undefined } as never
    );

    // The output must never echo what was stored.
    expect(saved).toEqual({ saved: true });
    expect(JSON.stringify(saved)).not.toContain('operator-app-secret');

    const started = (await capability('mcp.signin').invoke(
      deps,
      { agentId: AGENT_ID, name: SERVER },
      { identity: undefined } as never
    )) as { authorizeUrl?: string };
    expect(started.authorizeUrl).toContain('client_id=operator-app-id');
    expect(started.authorizeUrl).not.toContain('operator-app-secret');
  });
});
