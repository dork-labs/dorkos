import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HttpTransport } from '../transport';
const birth = {
  v: 1 as const,
  documentId: 'doc / one',
  physicalOpenedAt: '2026-10-15T00:00:00.000Z',
  channelCreatedAt: '2026-10-15T00:00:00.000Z',
  generation: 'a'.repeat(64),
};
const eventId = '10000000-0000-4000-8000-000000000001';
const discovery = {
  documentId: birth.documentId,
  incarnation: birth,
  entries: [],
  hasMore: false,
  window: 'latest_25_current_owner_birth',
  admission: 'not_observed_blocked',
};
const recovered = {
  documentId: birth.documentId,
  incarnation: birth,
  entry: {
    eventId,
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
    state: 'review',
    reason: 'prepared_without_replacement',
  },
};
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});
it.each(['/api', 'http://127.0.0.1:6242/api'])(
  'forwards the real web/desktop HTTP port at %s without draft or path authority',
  async (base) => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(discovery), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(recovered), { status: 200 }));
    const transport = new HttpTransport(base);
    const port = transport.originalFileSaveRecovery;
    expect(await port.discover(birth.documentId)).toEqual(discovery);
    expect(await port.recover(birth.documentId, eventId, birth)).toEqual(recovered);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      base + '/canvas/docs/doc%20%2F%20one/file-saves',
      expect.objectContaining({ credentials: 'include' })
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      base + '/canvas/docs/doc%20%2F%20one/file-saves/' + eventId + '/recover',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ expectedIncarnation: birth }),
      })
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  }
);
it('rejects malformed discovery rather than manufacturing an empty successful window', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }));
  await expect(
    new HttpTransport('/api').originalFileSaveRecovery.discover(birth.documentId)
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('rejects malformed recovery and retains HTTP refusal as failure', async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Original birth retired', code: 'DOC_CLOSED' }), {
        status: 409,
      })
    );
  const port = new HttpTransport('/api').originalFileSaveRecovery;
  await expect(port.recover(birth.documentId, eventId, birth)).rejects.toThrow();
  await expect(port.recover(birth.documentId, eventId, birth)).rejects.toMatchObject({
    status: 409,
    code: 'DOC_CLOSED',
  });
});
