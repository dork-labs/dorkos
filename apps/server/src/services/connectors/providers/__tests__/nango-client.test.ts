import { describe, it, expect, vi } from 'vitest';
import { FetchNangoHttpClient } from '../nango-client.js';

/** Build a client over a fetch fake that records every call it receives. */
function clientWith(responses: Array<{ status?: number; body?: string }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const response = responses[Math.min(i, responses.length - 1)] ?? {};
    i += 1;
    return new Response(response.body ?? '{}', { status: response.status ?? 200 });
  });
  const client = new FetchNangoHttpClient({
    secretKey: 'sk-nango-secret',
    baseUrl: 'http://localhost:3003',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { client, calls };
}

describe('FetchNangoHttpClient — status normalization (DOR-415 nit)', () => {
  /** Drive getConnectionState with a raw status and read the normalized one. */
  async function stateFor(rawStatus: string | undefined): Promise<string> {
    const { client } = clientWith([
      { body: JSON.stringify(rawStatus === undefined ? {} : { status: rawStatus }) },
    ]);
    const state = await client.getConnectionState('cs_1');
    return state.status;
  }

  it('keeps PENDING as the explicit in-flight case', async () => {
    await expect(stateFor('PENDING')).resolves.toBe('PENDING');
    await expect(stateFor('pending')).resolves.toBe('PENDING');
  });

  it('maps the known terminal states', async () => {
    await expect(stateFor('EXPIRED')).resolves.toBe('EXPIRED');
    await expect(stateFor('ERROR')).resolves.toBe('ERROR');
    await expect(stateFor('FAILED')).resolves.toBe('ERROR');
  });

  it('defaults an UNKNOWN status to ERROR, never in-flight (a poller must not spin forever)', async () => {
    await expect(stateFor('SOMETHING_NEW')).resolves.toBe('ERROR');
    await expect(stateFor(undefined)).resolves.toBe('ERROR');
  });
});

describe('FetchNangoHttpClient — end_user identity (DOR-415 nit)', () => {
  it('sends a fresh UUID end_user.id per connect; the label stays display_name only', async () => {
    const { client, calls } = clientWith([
      { body: JSON.stringify({ data: { token: 't1' } }) },
      { body: JSON.stringify({ data: { token: 't2' } }) },
    ]);

    await client.initiateConnection({ integration: 'gmail', label: 'work' });
    await client.initiateConnection({ integration: 'gmail', label: 'work' });

    const bodies = calls.map(
      (call) =>
        JSON.parse(String(call.init.body)) as { end_user: { id: string; display_name: string } }
    );
    // Duplicate labels yield DISTINCT end-user ids…
    expect(bodies[0]!.end_user.id).not.toBe(bodies[1]!.end_user.id);
    expect(bodies[0]!.end_user.id).toMatch(/^[0-9a-f-]{36}$/);
    // …while the label rides only as the display name.
    expect(bodies[0]!.end_user.display_name).toBe('work');
    expect(bodies[1]!.end_user.display_name).toBe('work');
    expect(bodies[0]!.end_user.id).not.toBe('work');
  });
});
