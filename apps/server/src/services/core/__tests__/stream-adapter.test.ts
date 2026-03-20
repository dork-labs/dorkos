import { describe, it, expect, vi } from 'vitest';
import { initSSEStream, sendSSEEvent, endSSEStream } from '../stream-adapter.js';
import type { StreamEvent } from '@dorkos/shared/types';
import type { Response } from 'express';

function createMockResponse() {
  return {
    writeHead: vi.fn(),
    write: vi.fn().mockReturnValue(true),
    once: vi.fn(),
    end: vi.fn(),
  } as unknown as Response;
}

describe('Stream Adapter', () => {
  it('initSSEStream sets correct headers', () => {
    const res = createMockResponse();
    initSSEStream(res);
    expect(res.writeHead).toHaveBeenCalledWith(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  });

  it('sendSSEEvent produces correct SSE format', async () => {
    const res = createMockResponse();
    const event: StreamEvent = {
      type: 'text_delta',
      data: { text: 'hello' },
    };
    await sendSSEEvent(res, event);
    expect(res.write).toHaveBeenCalledTimes(1);
    expect(res.write).toHaveBeenCalledWith('event: text_delta\ndata: {"text":"hello"}\n\n');
    expect(res.once).not.toHaveBeenCalled();
  });

  it('multiple events produce correct format', async () => {
    const res = createMockResponse();
    await sendSSEEvent(res, { type: 'text_delta', data: { text: 'a' } });
    await sendSSEEvent(res, { type: 'done', data: { sessionId: '1' } });
    expect(res.write).toHaveBeenCalledTimes(2); // 1 call per event
  });

  it('waits for drain before resolving when write returns false', async () => {
    const mockRes = {
      write: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
      once: vi.fn((event: string, cb: () => void) => {
        if (event === 'drain') cb();
      }),
    };
    await sendSSEEvent(mockRes as unknown as Response, {
      type: 'text_delta',
      data: { text: 'hi' },
    });
    expect(mockRes.once).toHaveBeenCalledWith('drain', expect.any(Function));
    expect(mockRes.write).toHaveBeenCalledTimes(1);
  });

  it('does not wait when write returns true', async () => {
    const mockRes = { write: vi.fn().mockReturnValue(true), once: vi.fn() };
    await sendSSEEvent(mockRes as unknown as Response, { type: 'done', data: {} });
    expect(mockRes.once).not.toHaveBeenCalled();
  });

  it('endSSEStream calls res.end()', () => {
    const res = createMockResponse();
    endSSEStream(res);
    expect(res.end).toHaveBeenCalled();
  });
});
