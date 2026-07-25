import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { apiCall } from '../lib/api-client.js';

/** Capture the headers the client sends without hitting the network. */
function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentHeaders(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
  return (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
}

describe('apiCall agent identity header', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

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
    // Unattributed calls stay exactly as they were.
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
