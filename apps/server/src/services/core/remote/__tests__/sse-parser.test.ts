/**
 * The strict event-stream parser the command stream reads with (DOR-2086).
 */
import { describe, expect, it } from 'vitest';

import { SSE_MAX_EVENT_BYTES, SseOverflowError, SseParser } from '../sse-parser.js';

describe('SseParser', () => {
  it('dispatches on a blank line, joining data lines with LF', () => {
    const parser = new SseParser();
    expect(parser.feed('data: {"a":\ndata: 1}\n\n')).toEqual([
      { event: 'message', data: '{"a":\n1}', id: undefined },
    ]);
  });

  it('accepts CRLF, LF and lone CR, including a CRLF split across chunks', () => {
    const parser = new SseParser();
    expect(parser.feed('data: one\r')).toEqual([]);
    // The LF that completes the CRLF must not read as a second, blank line.
    expect(parser.feed('\n\r\n')).toEqual([{ event: 'message', data: 'one', id: undefined }]);
    expect(parser.feed('data: two\r\rdata: three\n\n')).toEqual([
      { event: 'message', data: 'two', id: undefined },
      { event: 'message', data: 'three', id: undefined },
    ]);
  });

  it('ignores comments, unknown fields and events without data', () => {
    const parser = new SseParser();
    expect(parser.feed(': keepalive\n\nfoo: bar\nevent: x\n\n')).toEqual([]);
  });

  it('keeps the event name, the last id and only an all-digit retry', () => {
    const parser = new SseParser();
    expect(parser.feed('retry: 2500\nid: 7\nevent: command\ndata: x\n\n')).toEqual([
      { event: 'command', data: 'x', id: '7' },
    ]);
    expect(parser.retryMs).toBe(2500);
    parser.feed('retry: 10s\n\n');
    expect(parser.retryMs).toBe(2500);
  });

  it('drops one leading byte-order mark', () => {
    expect(new SseParser().feed('﻿data: x\n\n')).toEqual([
      { event: 'message', data: 'x', id: undefined },
    ]);
  });

  it('refuses an event that outgrows the size bound, buffered or not', () => {
    expect(() => new SseParser().feed(`data: ${'x'.repeat(SSE_MAX_EVENT_BYTES)}\n`)).toThrow(
      SseOverflowError
    );
    expect(() => new SseParser().feed('d'.repeat(SSE_MAX_EVENT_BYTES + 1))).toThrow(
      SseOverflowError
    );
  });
});
