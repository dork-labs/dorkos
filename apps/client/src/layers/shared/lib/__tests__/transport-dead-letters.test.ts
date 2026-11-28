import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpTransport } from '../transport';

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
      new Response(JSON.stringify(mockDeadLetters), { status: 200 })
    );

    const transport = new HttpTransport(BASE_URL);
    const result = await transport.listRelayDeadLetters();

    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/relay/dead-letters`);
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(result).toEqual(mockDeadLetters);
  });

  it('appends endpointHash query parameter when provided', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

    const transport = new HttpTransport(BASE_URL);
    await transport.listRelayDeadLetters({ endpointHash: 'abc123' });

    expect(fetch).toHaveBeenCalledWith(
      `${BASE_URL}/relay/dead-letters?endpointHash=abc123`,
      expect.anything()
    );
  });
});
