import { EventEmitter } from 'node:events';
import { leaseFixture } from '../../local-browser/__tests__/page-leases-fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startChromeScreencast } from '../chrome-screencast.js';

// A tiny JPEG header with a 640×480 SOF. The transport does not decode page pixels.
const image = Buffer.from([255, 216, 255, 192, 0, 11, 8, 1, 224, 2, 128, 1, 1, 17, 0, 255, 217]);
const fixtures: Awaited<ReturnType<typeof leaseFixture>>[] = [];
async function fixture() {
  const f = await leaseFixture();
  fixtures.push(f);
  await f.open('chat-a');
  const page = f.contexts[0].pages[0];
  page.navigate('https://example.com');
  const handle = await f.service.pageBroker.captureViewerLease('chat-a', {
    ownerId: 'owner',
    appSessionId: 'app',
    clientInstanceId: 'client',
    viewerId: 'viewer',
  });
  const cdp = Object.assign(new EventEmitter(), {
    send: vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({})),
    detach: vi.fn(async () => undefined),
  });
  const attach = vi.mocked(f.contexts[0].context.newCDPSession);
  attach.mockResolvedValue(cdp as never);
  attach.mockClear();
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
  return { cdp, page, handle, receive, emit, attach };
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});

describe('owned Chrome page stream', () => {
  it('bounds attachment and detaches a session that arrives after its deadline', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    let finish!: (value: Awaited<ReturnType<typeof f.attach>>) => void;
    f.attach.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = startChromeScreencast(f.handle, f.receive);
    const result = expect(pending).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(3_001);
    await result;
    await expect(startChromeScreencast(f.handle, vi.fn())).rejects.toMatchObject({ code: 'busy' });
    expect(f.attach).toHaveBeenCalledTimes(1);
    finish(f.cdp as never);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.cdp.detach).toHaveBeenCalledTimes(1);
    expect(f.cdp.send).not.toHaveBeenCalledWith('Page.startScreencast', expect.anything());
  });

  it('bounds teardown even when the protocol stop never settles', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const stop = await startChromeScreencast(f.handle, f.receive);
    f.cdp.send.mockImplementationOnce(() => new Promise(() => undefined));
    let stopped = false;
    const closing = stop()
      .catch(() => undefined)
      .then(() => {
        stopped = true;
      });
    f.emit(1);
    expect(f.receive).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_001);
    expect(stopped).toBe(true);
    expect(f.cdp.detach).toHaveBeenCalledTimes(1);
    await closing;
  });

  it('uses one page CDP session and acknowledges frames independently of viewers', async () => {
    const f = await fixture();
    const stop = await startChromeScreencast(f.handle, f.receive);
    expect(f.cdp.send).toHaveBeenCalledWith('Page.startScreencast', {
      format: 'jpeg',
      quality: 70,
      maxWidth: 1280,
      maxHeight: 960,
      everyNthFrame: 1,
    });
    f.emit(37);
    expect(f.receive).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 640,
        height: 480,
        bytes: image,
        generation: f.handle.facts().navigationGeneration + 1,
        sequence: 1,
      })
    );
    expect(f.cdp.send).toHaveBeenCalledWith('Page.screencastFrameAck', { sessionId: 37 });
    await stop();
    expect(f.cdp.detach).toHaveBeenCalledTimes(1);

    f.emit(38);
    expect(f.receive).toHaveBeenCalledTimes(1);
  });

  it('acknowledges oversized or malformed frames without publishing their content', async () => {
    const f = await fixture();
    const stop = await startChromeScreencast(f.handle, f.receive);
    f.emit(1, Buffer.alloc(2 * 1024 * 1024 + 1));
    f.emit(2, Buffer.from('not-an-image'));
    expect(f.receive).not.toHaveBeenCalled();
    expect(f.cdp.send).toHaveBeenCalledWith('Page.screencastFrameAck', { sessionId: 1 });
    expect(f.cdp.send).toHaveBeenCalledWith('Page.screencastFrameAck', { sessionId: 2 });
    await stop();
  });

  it('bounds delivery rate while still acknowledging Chrome', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const stop = await startChromeScreencast(f.handle, f.receive);
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

  it('never starts another producer while a prior physical stop is unresolved', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const stop = await startChromeScreencast(f.handle, f.receive);
    let release!: () => void;
    f.cdp.send.mockImplementationOnce(
      () =>
        new Promise<Record<string, never>>((resolve) => {
          release = () => resolve({});
        })
    );
    const closing = stop().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(3_001);
    await closing;
    await expect(startChromeScreencast(f.handle, vi.fn())).rejects.toMatchObject({ code: 'busy' });
    expect(f.attach).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1);
    const replacement = await startChromeScreencast(f.handle, vi.fn());
    expect(f.attach).toHaveBeenCalledTimes(2);
    await replacement();
  });
});
