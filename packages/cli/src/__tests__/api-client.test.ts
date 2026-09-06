import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { apiCall, ApiError, resolveApiKey } from '../lib/api-client.js';

/**
 * An isolated DORK_HOME per test. The credential resolver reads
 * `<dork home>/api-key` from disk, so without this the suite would pick up the
 * developer's real key file and pass or fail by accident.
 */
let dorkHome: string;

/** Capture the headers the client sends without hitting the network. */
function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Stub `fetch` with the login gate's real 401 body. */
function stubUnauthorized(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }), {
        status: 401,
      })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentHeaders(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
  return (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
}

/** Write a saved API key into the isolated dork home. */
function writeKeyFile(value: string): void {
  fs.writeFileSync(path.join(dorkHome, 'api-key'), value, { mode: 0o600 });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-api-client-'));
  vi.stubEnv('DORK_HOME', dorkHome);
  vi.stubEnv('DORKOS_API_KEY', '');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(dorkHome, { recursive: true, force: true });
});

describe('apiCall agent identity header', () => {
  it('attaches X-DorkOS-Agent when DORKOS_AGENT_TOKEN is set', async () => {
    vi.stubEnv('DORKOS_AGENT_TOKEN', 'minted-token');
    const fetchMock = stubFetch();

    await apiCall('GET', '/api/health');

    expect(sentHeaders(fetchMock)['X-DorkOS-Agent']).toBe('minted-token');
  });

  it('trims surrounding whitespace off the token', async () => {
    vi.stubEnv('DORKOS_AGENT_TOKEN', '  minted-token \n');
    const fetchMock = stubFetch();

    await apiCall('GET', '/api/health');

    expect(sentHeaders(fetchMock)['X-DorkOS-Agent']).toBe('minted-token');
  });

  it('sends no identity header when the env var is absent', async () => {
    const fetchMock = stubFetch();

    await apiCall('GET', '/api/health');

    const headers = sentHeaders(fetchMock);
    expect(headers['X-DorkOS-Agent']).toBeUndefined();
    // Unattributed, uncredentialed calls stay exactly as they were.
    expect(headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('sends no identity header when the env var is empty or whitespace', async () => {
    vi.stubEnv('DORKOS_AGENT_TOKEN', '   ');
    const fetchMock = stubFetch();

    await apiCall('GET', '/api/health');

    expect(sentHeaders(fetchMock)['X-DorkOS-Agent']).toBeUndefined();
  });

  it('keeps the Content-Type header alongside the identity header', async () => {
    vi.stubEnv('DORKOS_AGENT_TOKEN', 'minted-token');
    const fetchMock = stubFetch();

    await apiCall('POST', '/api/capabilities/demo.read/invoke', { a: 1 });

    expect(sentHeaders(fetchMock)).toEqual({
      'Content-Type': 'application/json',
      'X-DorkOS-Agent': 'minted-token',
    });
  });
});

describe('resolveApiKey', () => {
  it('returns null when neither source has a key', () => {
    expect(resolveApiKey()).toBeNull();
  });

  it('reads DORKOS_API_KEY, trimmed', () => {
    vi.stubEnv('DORKOS_API_KEY', '  env-key \n');
    expect(resolveApiKey()).toBe('env-key');
  });

  it('falls back to the saved key file, trimmed', () => {
    writeKeyFile('  file-key\n');
    expect(resolveApiKey()).toBe('file-key');
  });

  it('prefers the env var over the file (CLI precedence)', () => {
    writeKeyFile('file-key');
    vi.stubEnv('DORKOS_API_KEY', 'env-key');
    expect(resolveApiKey()).toBe('env-key');
  });

  it('treats a whitespace-only env var as unset and keeps reading', () => {
    writeKeyFile('file-key');
    vi.stubEnv('DORKOS_API_KEY', '   ');
    expect(resolveApiKey()).toBe('file-key');
  });

  it('treats an empty key file as no key', () => {
    writeKeyFile('   \n');
    expect(resolveApiKey()).toBeNull();
  });
});

describe('apiCall credentials', () => {
  it('sends no Authorization header when there is no key (login off works as before)', async () => {
    const fetchMock = stubFetch();

    await apiCall('GET', '/api/tasks');

    expect(sentHeaders(fetchMock).Authorization).toBeUndefined();
  });

  // `Authorization: Bearer <per-user API key>` is exactly the credential the
  // login gate accepts on `/api/*`; that end of the contract is proven against the
  // real Express app in
  // `apps/server/src/services/core/auth/__tests__/session-gate.test.ts`.
  it('presents the env key as a bearer token', async () => {
    vi.stubEnv('DORKOS_API_KEY', 'personal-key');
    const fetchMock = stubFetch();

    await apiCall('GET', '/api/tasks');

    expect(sentHeaders(fetchMock).Authorization).toBe('Bearer personal-key');
  });

  it('presents the saved key file as a bearer token', async () => {
    writeKeyFile('saved-key');
    const fetchMock = stubFetch();

    await apiCall('GET', '/api/tasks');

    expect(sentHeaders(fetchMock).Authorization).toBe('Bearer saved-key');
  });

  it('lets a caller-supplied Authorization header win', async () => {
    vi.stubEnv('DORKOS_API_KEY', 'personal-key');
    const fetchMock = stubFetch();

    await apiCall('GET', '/api/tasks', undefined, { Authorization: 'Bearer one-off' });

    expect(sentHeaders(fetchMock).Authorization).toBe('Bearer one-off');
  });

  it('keeps the credential alongside the identity header', async () => {
    vi.stubEnv('DORKOS_API_KEY', 'personal-key');
    vi.stubEnv('DORKOS_AGENT_TOKEN', 'minted-token');
    const fetchMock = stubFetch();

    await apiCall('POST', '/api/capabilities/demo.read/invoke', { a: 1 });

    expect(sentHeaders(fetchMock)).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer personal-key',
      'X-DorkOS-Agent': 'minted-token',
    });
  });
});

describe('apiCall 401 guidance', () => {
  it('replaces the gate\'s bare "Unauthorized" with what to do about it', async () => {
    stubUnauthorized();

    const err = await apiCall('GET', '/api/tasks').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    const apiError = err as ApiError;
    expect(apiError.status).toBe(401);
    expect(apiError.message).toContain('login turned on');
    // Names the credential, both places it can live, and where to get one.
    expect(apiError.message).toContain('DORKOS_API_KEY');
    expect(apiError.message).toContain(path.join(dorkHome, 'api-key'));
    expect(apiError.message).toContain('Settings → Access → API keys');
    // The server's machine-readable code survives for callers that branch on it.
    expect(apiError.body.code).toBe('AUTH_REQUIRED');
  });

  it('says the key was rejected when one was actually presented', async () => {
    vi.stubEnv('DORKOS_API_KEY', 'revoked-key');
    stubUnauthorized();

    const err = (await apiCall('GET', '/api/tasks').catch((e: unknown) => e)) as ApiError;

    expect(err.message).toContain('did not accept your API key');
    expect(err.message).not.toContain('login turned on');
  });

  it('keeps a 401 the server explained for itself, rather than blaming the API key', async () => {
    // A room route refuses an `X-DorkOS-Agent` token it cannot verify with its
    // own 401 and its own sentence (DOR-1361). Rewriting that into "the CLI
    // needs your API key" would send an agent whose token expired to mint a
    // credential that is not the one it is missing.
    vi.stubEnv('DORKOS_AGENT_TOKEN', 'revoked-agent-token');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: 'That agent identity could not be verified.',
              code: 'AGENT_IDENTITY_UNVERIFIED',
            }),
            { status: 401 }
          )
      )
    );

    const err = (await apiCall('GET', '/api/rooms').catch((e: unknown) => e)) as ApiError;

    expect(err.status).toBe(401);
    expect(err.message).toBe('That agent identity could not be verified.');
    expect(err.message).not.toContain('API key');
    expect(err.body.code).toBe('AGENT_IDENTITY_UNVERIFIED');
  });

  it('still guides a 401 that carries no code at all', async () => {
    // The other side of the branch above, and the reason it is `code === undefined
    // || code === AUTH_REQUIRED` rather than a check for the room code: a proxy
    // or an unparseable body produces a 401 with nothing machine-readable on it,
    // and that caller is the one the guidance was written for. Narrowing this to
    // "only rewrite AUTH_REQUIRED" would have left them a bare `Unauthorized`.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>401 Unauthorized</html>', { status: 401 }))
    );

    const err = (await apiCall('GET', '/api/tasks').catch((e: unknown) => e)) as ApiError;

    expect(err.status).toBe(401);
    expect(err.message).toContain('login turned on');
    expect(err.message).toContain('DORKOS_API_KEY');
  });

  it('never echoes the key value in the guidance', async () => {
    vi.stubEnv('DORKOS_API_KEY', 'super-secret-key');
    stubUnauthorized();

    const err = (await apiCall('GET', '/api/tasks').catch((e: unknown) => e)) as ApiError;

    expect(err.message).not.toContain('super-secret-key');
  });

  it('leaves non-401 error bodies untouched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'Validation failed', errors: ['bad name'] }), {
            status: 400,
          })
      )
    );

    const err = (await apiCall('POST', '/api/tasks', {}).catch((e: unknown) => e)) as ApiError;

    expect(err.status).toBe(400);
    expect(err.message).toBe('Validation failed');
    expect(err.body.errors).toEqual(['bad name']);
  });
});
