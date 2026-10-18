import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transport } from '@dorkos/shared/transport';
import { HttpTransport } from '../transport';

const route = {
  id: 'helper',
  on: 'task.*',
  to: 'agent:atlas',
  turn: 'immediate',
  destination: { kind: 'agent', agentId: 'atlas', agentName: 'Atlas' },
  needsPerson: true,
  state: 'no_grant',
  grant: null,
  waiting: null,
};
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const call = (index = 0) => vi.mocked(fetch).mock.calls[index]!;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('document route controls over HTTP', () => {
  it('reads one document’s routes and refuses a list for another document', async () => {
    const transport: Transport = new HttpTransport('/api');
    vi.mocked(fetch).mockResolvedValueOnce(json({ documentId: 'doc 1', routes: [route] }));
    expect((await transport.getCanvasDocRoutes('doc 1')).routes).toHaveLength(1);
    expect(String(call()[0])).toContain('/api/canvas/docs/doc%201/routes');
    vi.mocked(fetch).mockResolvedValueOnce(json({ documentId: 'other', routes: [] }));
    await expect(transport.getCanvasDocRoutes('doc 1')).rejects.toThrow('another document');
  });

  it('posts the review and refuses one for a different expiry', async () => {
    const transport: Transport = new HttpTransport('/api');
    const expiresAt = '2026-10-18T15:00:00.000Z';
    const review = {
      documentId: 'doc',
      routeId: 'helper',
      on: 'task.*',
      destination: route.destination,
      allowedTypes: ['task.*'],
      limits: { envelopeBytes: 16384, eventsPerMinute: 60, turnsPerHour: 10 },
      expiresAt,
      reviewHash: 'c'.repeat(64),
    };
    vi.mocked(fetch).mockResolvedValueOnce(json(review));
    expect((await transport.reviewCanvasDocRoute('doc', 'helper', { expiresAt })).reviewHash).toBe(
      'c'.repeat(64)
    );
    expect(String(call()[0])).toContain('/api/canvas/docs/doc/routes/helper/review');
    expect(call()[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ expiresAt }) });
    vi.mocked(fetch).mockResolvedValueOnce(
      json({ ...review, expiresAt: '2026-10-19T15:00:00.000Z' })
    );
    await expect(transport.reviewCanvasDocRoute('doc', 'helper', { expiresAt })).rejects.toThrow();
  });

  it('sends only the reviewed expiry and hash when approving, and nothing but the route when turning off', async () => {
    const transport: Transport = new HttpTransport('/api');
    vi.mocked(fetch).mockImplementation(async () => json({ route }));
    const body = { expiresAt: '2026-10-18T15:00:00.000Z', reviewHash: 'c'.repeat(64) };
    await transport.approveCanvasDocRoute('doc', 'helper', body);
    expect(call(0)[1]).toMatchObject({ method: 'POST', body: JSON.stringify(body) });
    await transport.revokeCanvasDocRoute('doc', 'helper');
    expect(String(call(1)[0])).toContain('/routes/helper/revoke');
    expect(call(1)[1]).toMatchObject({ method: 'POST', body: '{}' });
    await expect(transport.revokeCanvasDocRoute('doc', 'other')).rejects.toThrow('another route');
  });
});
