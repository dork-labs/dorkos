import { describe, it, expect, vi } from 'vitest';
import { initSSEStream, sendSSEEvent, endSSEStream } from '../../services/stream-adapter.js';
import type { StreamEvent } from '@lifeos/shared/types';

function createMockResponse() {
  return {
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
  } as any;
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

  it('sendSSEEvent produces correct SSE format', () => {
    const res = createMockResponse();
    const event: StreamEvent = {
      type: 'text_delta',
      data: { text: 'hello' },
    };
    sendSSEEvent(res, event);
    expect(res.write).toHaveBeenCalledWith('event: text_delta\n');
    expect(res.write).toHaveBeenCalledWith('data: {"text":"hello"}\n\n');
  });

  it('multiple events produce correct format', () => {
    const res = createMockResponse();
    sendSSEEvent(res, { type: 'text_delta', data: { text: 'a' } });
    sendSSEEvent(res, { type: 'done', data: { sessionId: '1' } });
    expect(res.write).toHaveBeenCalledTimes(4); // 2 calls per event
  });

  it('endSSEStream calls res.end()', () => {
    const res = createMockResponse();
    endSSEStream(res);
    expect(res.end).toHaveBeenCalled();
  });
});
