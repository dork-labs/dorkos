import { EventEmitter } from 'node:events';
import type { Page } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startChromeScreencast } from '../chrome-screencast.js';

// A tiny JPEG header with a 640×480 SOF. The transport does not decode page pixels.
const image = Buffer.from([255, 216, 255, 192, 0, 11, 8, 1, 224, 2, 128, 1, 1, 17, 0, 255, 217]);
function fixture() {
  const cdp = Object.assign(new EventEmitter(), {
    send: vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({})),
    detach: vi.fn(async () => undefined),
  });
  const attach = vi.fn(async () => cdp);
  const page = Object.assign(new EventEmitter(), {
    context: () => ({ newCDPSession: attach }),
    mainFrame: () => 'main-frame',
  });
  const receive = vi.fn();
  const emit = (sessionId: number, bytes = image) =>
    cdp.emit('Page.screencastFrame', {
      sessionId,
      data: bytes.toString('base64'),
      metadata: {
        deviceWidth: 640,
        deviceHeight: 480,
        pageScaleFactor: 1,
        offsetTop: 0,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
      },
    });
  return { cdp, page, receive, emit, attach };
}
afterEach(() => vi.useRealTimers());

describe('owned Chrome page stream', () => {
  it('bounds attachment and detaches a session that arrives after its deadline', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finish!: (value: typeof f.cdp) => void;
    f.attach.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = startChromeScreencast(f.page as unknown as Page, f.receive);
    const result = expect(pending).rejects.toThrow('viewer_unavailable');
    await vi.advanceTimersByTimeAsync(3_001);
    await result;
    finish(f.cdp);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.cdp.detach).toHaveBeenCalledTimes(1);
    expect(f.cdp.send).not.toHaveBeenCalledWith('Page.startScreencast', expect.anything());
  });

  it('bounds teardown even when the protocol stop never settles', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const stop = await startChromeScreencast(f.page as unknown as Page, f.receive);
    f.cdp.send.mockImplementationOnce(() => new Promise(() => undefined));
    let stopped = false;
    const closing = stop().then(() => {
      stopped = true;
    });
    f.emit(1);
    expect(f.receive).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_001);
    expect(stopped).toBe(true);
    expect(f.cdp.detach).toHaveBeenCalledTimes(1);
    await closing;
  });

  it('uses one page CDP session and acknowledges frames independently of viewers', async () => {
    const f = fixture();
    const stop = await startChromeScreencast(f.page as unknown as Page, f.receive);
    expect(f.cdp.send).toHaveBeenCalledWith('Page.startScreencast', {
      format: 'jpeg',
      quality: 70,
      maxWidth: 1280,
      maxHeight: 960,
      everyNthFrame: 1,
    });
    f.emit(37);
    expect(f.receive).toHaveBeenCalledWith(
      expect.objectContaining({ width: 640, height: 480, bytes: image, generation: 1, sequence: 1 })
    );
    expect(f.cdp.send).toHaveBeenCalledWith('Page.screencastFrameAck', { sessionId: 37 });
    await stop();
    expect(f.cdp.detach).toHaveBeenCalledTimes(1);
    expect(f.page.listenerCount('framenavigated')).toBe(0);
    f.emit(38);
    expect(f.receive).toHaveBeenCalledTimes(1);
  });

  it('acknowledges oversized or malformed frames without publishing their content', async () => {
    const f = fixture();
    const stop = await startChromeScreencast(f.page as unknown as Page, f.receive);
    f.emit(1, Buffer.alloc(2 * 1024 * 1024 + 1));
    f.emit(2, Buffer.from('not-an-image'));
    expect(f.receive).not.toHaveBeenCalled();
    expect(f.cdp.send).toHaveBeenCalledWith('Page.screencastFrameAck', { sessionId: 1 });
    expect(f.cdp.send).toHaveBeenCalledWith('Page.screencastFrameAck', { sessionId: 2 });
    await stop();
  });

  it('bounds delivery rate while still acknowledging Chrome', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const stop = await startChromeScreencast(f.page as unknown as Page, f.receive);
    for (let i = 0; i < 100; i++) f.emit(i);
    expect(f.receive).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(84);
    f.emit(101);
    expect(f.receive).toHaveBeenCalledTimes(2);
    expect(
      f.cdp.send.mock.calls.filter(([method]) => method === 'Page.screencastFrameAck')
    ).toHaveLength(101);
    await stop();
  });

  it('tears down its own session on navigation without closing Chrome', async () => {
    const f = fixture();
    const stop = await startChromeScreencast(f.page as unknown as Page, f.receive);
    f.page.emit('framenavigated', 'main-frame');
    f.emit(1);
    expect(f.receive).not.toHaveBeenCalled();
    await stop();
    expect(f.cdp.detach).toHaveBeenCalledTimes(1);
  });
});
