import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import {
  CanvasChannelEventReceiptSchema,
  CanvasChannelReplayResponseSchema,
  type PageEvent,
} from '@dorkos/shared/canvas-channel-schemas';
import { HttpTransport } from '../transport';
const input: PageEvent = {
  v: 1,
  id: '11111111-2222-4333-8444-555555555555',
  type: 'task.changed',
  payload: { done: true },
};
const condition = Object.freeze({ expectedGeneration: 'a'.repeat(64) });
const signal = new AbortController().signal;
const receipt = { receipt: { id: input.id, status: 'recorded', docSeq: 1 }, deliveries: [] };
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});
describe('document event Transport contract', () => {
  it('uses the mock port for acceptance, bounded replay and retained inspection', async () => {
    const transport: Transport = createMockTransport();
    expect(
      CanvasChannelEventReceiptSchema.safeParse(await transport.ingestCanvasEvent('doc', input, condition, signal))
        .success
    ).toBe(true);
    expect(
      CanvasChannelEventReceiptSchema.safeParse(
        await transport.getCanvasEventReceipt('doc', input.id, condition, signal)
      ).success
    ).toBe(true);
    expect(
      CanvasChannelReplayResponseSchema.safeParse(
        await transport.getCanvasChannel('doc', { since: 0, limit: 1 })
      ).success
    ).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('encodes opaque document IDs, sends only the envelope and returns acceptance separately', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(receipt), { status: 201 }));
    const transport: Transport = new HttpTransport('/api');
    expect(await transport.ingestCanvasEvent('a/b ?', input, condition, signal)).toEqual(receipt);
    expect(fetch).toHaveBeenCalledWith(
      '/api/canvas/docs/a%2Fb%20%3F/events',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(input), signal })
    );
  });
  it('preserves explicit zero cursors and limits without sending a caller or scope', async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response('{}', { status: 200 }));
    const transport: Transport = new HttpTransport('/api');
    await transport.getCanvasChannel('doc', { since: 0, limit: 1 });
    expect(fetch).toHaveBeenCalledWith(
      '/api/canvas/docs/doc/channel?since=0&limit=1',
      expect.any(Object)
    );
    await transport.getCanvasChannel('doc');
    expect(fetch).toHaveBeenLastCalledWith('/api/canvas/docs/doc/channel', expect.any(Object));
  });
  it('inspects receipts without replay and preserves HTTP refusals as failures', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'The document is not available.',
            code: 'CANVAS_DOCUMENT_NOT_FOUND',
          }),
          { status: 404 }
        )
      );
    const transport: Transport = new HttpTransport('/api');
    await transport.getCanvasEventReceipt('doc', input.id, condition, signal);
    expect(fetch).toHaveBeenCalledWith(
      `/api/canvas/docs/doc/events/${input.id}`,
      expect.any(Object)
    );
    await expect(transport.getCanvasEventReceipt('missing', input.id, condition, signal)).rejects.toMatchObject({
      status: 404,
    });
  });
  it('forwards the original generation header and exact signal on BOTH bound operations', async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify(receipt)));
    const transport: Transport = new HttpTransport('/api');
    const controller = new AbortController();
    const original = controller.signal;
    await transport.ingestCanvasEvent('doc', input, condition, original);
    await transport.getCanvasEventReceipt('doc', input.id, condition, original);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
    for (const [, options] of vi.mocked(fetch).mock.calls) {
      expect(options?.signal).toBe(original);
      expect(new Headers(options?.headers).get('X-DorkOS-Doc-Generation')).toBe(condition.expectedGeneration);
      expect(options?.credentials).toBe('include');
    }
    controller.abort();
    for (const [, options] of vi.mocked(fetch).mock.calls) expect(options?.signal?.aborted).toBe(true);
    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toBe(JSON.stringify(input));
    expect(vi.mocked(fetch).mock.calls[1][1]?.body).toBeUndefined();
  });
  it.each(['submit', 'inspect'] as const)('keeps native aborted %s uncertainty as the original rejection', async (operation) => {
    const controller = new AbortController();
    const reason = new DOMException('Retired', 'AbortError');
    controller.abort(reason);
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      expect(options?.signal).toBe(controller.signal);
      options?.signal?.throwIfAborted();
      throw new Error('Aborted request reached success');
    });
    const transport: Transport = new HttpTransport('/api');
    const result = operation === 'submit'
      ? transport.ingestCanvasEvent('doc', input, condition, controller.signal)
      : transport.getCanvasEventReceipt('doc', input.id, condition, controller.signal);
    await expect(result).rejects.toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

});
