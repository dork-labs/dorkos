import { describe, it, expect, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { startStream, appendStream, stopStream } from '../stream-api.js';

/** Create a mock WebClient with the unofficial streaming methods. */
function createMockClient() {
  return {
    chat: {
      startStream: vi.fn().mockResolvedValue({ stream_id: 'stream-123' }),
      appendStream: vi.fn().mockResolvedValue({}),
      stopStream: vi.fn().mockResolvedValue({}),
    },
  } as unknown as WebClient;
}

describe('startStream', () => {
  it('calls chat.startStream with channel and thread_ts', async () => {
    const client = createMockClient();
    const result = await startStream(client, 'C123', '1234.5678');

    expect(result).toBe('stream-123');
    const chat = (client as unknown as { chat: Record<string, ReturnType<typeof vi.fn>> }).chat;
    expect(chat.startStream).toHaveBeenCalledWith({ channel: 'C123', thread_ts: '1234.5678' });
  });

  it('passes undefined thread_ts when omitted', async () => {
    const client = createMockClient();
    await startStream(client, 'C456');

    const chat = (client as unknown as { chat: Record<string, ReturnType<typeof vi.fn>> }).chat;
    expect(chat.startStream).toHaveBeenCalledWith({ channel: 'C456', thread_ts: undefined });
  });

  it('returns empty string when stream_id is missing from response', async () => {
    const client = {
      chat: {
        startStream: vi.fn().mockResolvedValue({}),
        appendStream: vi.fn(),
        stopStream: vi.fn(),
      },
    } as unknown as WebClient;

    const result = await startStream(client, 'C789');
    expect(result).toBe('');
  });
});

describe('appendStream', () => {
  it('calls chat.appendStream with stream_id and text', async () => {
    const client = createMockClient();
    await appendStream(client, 'stream-abc', 'Hello world');

    const chat = (client as unknown as { chat: Record<string, ReturnType<typeof vi.fn>> }).chat;
    expect(chat.appendStream).toHaveBeenCalledWith({ stream_id: 'stream-abc', text: 'Hello world' });
  });

  it('propagates errors from the underlying API call', async () => {
    const client = {
      chat: {
        startStream: vi.fn(),
        appendStream: vi.fn().mockRejectedValue(new Error('append failed')),
        stopStream: vi.fn(),
      },
    } as unknown as WebClient;

    await expect(appendStream(client, 'stream-x', 'text')).rejects.toThrow('append failed');
  });
});

describe('stopStream', () => {
  it('calls chat.stopStream with stream_id', async () => {
    const client = createMockClient();
    await stopStream(client, 'stream-xyz');

    const chat = (client as unknown as { chat: Record<string, ReturnType<typeof vi.fn>> }).chat;
    expect(chat.stopStream).toHaveBeenCalledWith({ stream_id: 'stream-xyz' });
  });

  it('propagates errors from the underlying API call', async () => {
    const client = {
      chat: {
        startStream: vi.fn(),
        appendStream: vi.fn(),
        stopStream: vi.fn().mockRejectedValue(new Error('stop failed')),
      },
    } as unknown as WebClient;

    await expect(stopStream(client, 'stream-x')).rejects.toThrow('stop failed');
  });
});
