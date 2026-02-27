import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpTransport } from '../http-transport';
import { DirectTransport } from '../direct-transport';

describe('HttpTransport.listRelayDeadLetters', () => {
  const BASE_URL = 'http://localhost:4242/api';

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls GET /relay/dead-letters with no filters', async () => {
    const mockDeadLetters = [{ id: 'dl-1', subject: 'test.subject' }];
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(mockDeadLetters), { status: 200 }),
    );

    const transport = new HttpTransport(BASE_URL);
    const result = await transport.listRelayDeadLetters();

    expect(fetch).toHaveBeenCalledWith(
      `${BASE_URL}/relay/dead-letters`,
      expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
    );
    expect(result).toEqual(mockDeadLetters);
  });

  it('appends endpointHash query parameter when provided', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

    const transport = new HttpTransport(BASE_URL);
    await transport.listRelayDeadLetters({ endpointHash: 'abc123' });

    expect(fetch).toHaveBeenCalledWith(
      `${BASE_URL}/relay/dead-letters?endpointHash=abc123`,
      expect.anything(),
    );
  });

  it('omits query string when filters are empty', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

    const transport = new HttpTransport(BASE_URL);
    await transport.listRelayDeadLetters({});

    expect(fetch).toHaveBeenCalledWith(
      `${BASE_URL}/relay/dead-letters`,
      expect.anything(),
    );
  });

  it('throws when the server responds with an error', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Relay not enabled' }), { status: 503 }),
    );

    const transport = new HttpTransport(BASE_URL);
    await expect(transport.listRelayDeadLetters()).rejects.toThrow('Relay not enabled');
  });

  it('returns an empty array when server returns []', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

    const transport = new HttpTransport(BASE_URL);
    const result = await transport.listRelayDeadLetters();

    expect(result).toEqual([]);
  });
});

describe('DirectTransport.listRelayDeadLetters', () => {
  it('returns an empty array (Relay not supported in embedded mode)', async () => {
    const transport = new DirectTransport({} as never);
    const result = await transport.listRelayDeadLetters();

    expect(result).toEqual([]);
  });

  it('ignores any filters and returns empty array', async () => {
    const transport = new DirectTransport({} as never);
    const result = await transport.listRelayDeadLetters({ endpointHash: 'any-hash' });

    expect(result).toEqual([]);
  });
});
