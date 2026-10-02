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
      CanvasChannelEventReceiptSchema.safeParse(await transport.ingestCanvasEvent('doc', input))
        .success
    ).toBe(true);
    expect(
      CanvasChannelEventReceiptSchema.safeParse(
        await transport.getCanvasEventReceipt('doc', input.id)
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
    expect(await transport.ingestCanvasEvent('a/b ?', input)).toEqual(receipt);
    expect(fetch).toHaveBeenCalledWith(
      '/api/canvas/docs/a%2Fb%20%3F/events',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(input) })
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
    await transport.getCanvasEventReceipt('doc', input.id);
    expect(fetch).toHaveBeenCalledWith(
      `/api/canvas/docs/doc/events/${input.id}`,
      expect.any(Object)
    );
    await expect(transport.getCanvasEventReceipt('missing', input.id)).rejects.toMatchObject({
      status: 404,
    });
  });
});
