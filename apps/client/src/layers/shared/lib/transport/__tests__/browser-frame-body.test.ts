import { expect, it, vi } from 'vitest';
import { encodeBrowserFrameBody } from '@dorkos/shared/browser-frame-wire';
import { readBrowserFrameBody } from '../browser-frame-body';

// Framing and entered-reader custody controls only; no fetch, browser image decode, native pixels or ACK.
function frame() {
  return encodeBrowserFrameBody(
    {
      frame: {
        binding: {
          browserId: 'browser_fixture_000000001',
          browserGeneration: 1,
          tabId: 'tab_fixture_00000000000001',
          navigationGeneration: 0,
          viewportVersion: 0,
          epoch: 0,
          inputGeneration: 0,
        },
        viewerId: 'viewer_fixture_00000000001',
        frameId: 'frame_fixture_000000000001',
        sequence: 0,
        width: 1280,
        height: 720,
        format: 'jpeg',
        byteLength: 3,
      },
      geometry: {
        cssViewport: { width: 1280, height: 720 },
        raster: { width: 2560, height: 1440, format: 'jpeg' },
        scaleX: 2,
        scaleY: 2,
      },
      pointer: null,
    },
    new Uint8Array([1, 2, 3])
  );
}
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function fake(reader: {
  read: () => Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel: (reason?: unknown) => Promise<void>;
  releaseLock: () => void;
}) {
  const getReader = vi.fn(() => reader);
  return { body: { getReader } as unknown as ReadableStream<Uint8Array>, getReader };
}

it('reads a real WHATWG stream across header/metadata/raster boundaries and releases its lock', async () => {
  const wire = frame();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of wire) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  const result = await readBrowserFrameBody(body);
  expect([...result.bytes]).toEqual([1, 2, 3]);
  expect(result.metadata.geometry.raster.width).toBe(2560);
  expect(result.metadata.pointer).toBeNull();
  expect(body.locked).toBe(false);
});
it('requires EOF; trailing second frames cancel the original reader once before lock release', async () => {
  const events: string[] = [];
  const reader = {
    read: vi.fn(async () => {
      events.push('read');
      return { done: false as const, value: frame() };
    }),
    cancel: vi.fn(async () => {
      events.push('cancel');
    }),
    releaseLock: vi.fn(() => {
      events.push('release');
    }),
  };
  const input = fake(reader);
  await expect(readBrowserFrameBody(input.body)).rejects.toThrow('trailing');
  expect(input.getReader).toHaveBeenCalledTimes(1);
  expect(reader.read).toHaveBeenCalledTimes(2);
  expect(reader.cancel).toHaveBeenCalledTimes(1);
  expect(events).toEqual(['read', 'read', 'cancel', 'release']);
});
it('rejects truncated EOF and oversized metadata before entering a second read', async () => {
  for (const value of [new Uint8Array([0xff, 0xff, 0xff, 0xff]), frame().subarray(0, 12)]) {
    const reader = {
      read: vi
        .fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>()
        .mockResolvedValueOnce({ done: false, value })
        .mockResolvedValue({ done: true, value: undefined }),
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn(() => {}),
    };
    await expect(readBrowserFrameBody(fake(reader).body)).rejects.toThrow();
    expect(reader.read).toHaveBeenCalledTimes(value.byteLength === 4 ? 1 : 2);
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  }
});
it('abort retains original pending read AND cancellation through settlement, then preserves the first reason', async () => {
  const pendingRead = deferred<ReadableStreamReadResult<Uint8Array>>(),
    pendingCancel = deferred<void>();
  const controller = new AbortController(),
    first = new Error('original abort');
  const reader = {
    read: vi.fn(() => pendingRead.promise),
    cancel: vi.fn(() => pendingCancel.promise),
    releaseLock: vi.fn(() => {}),
  };
  const running = readBrowserFrameBody(fake(reader).body, controller.signal);
  let settled = false;
  const observed = running.then(
    () => {
      settled = true;
      return 'success';
    },
    (error: unknown) => {
      settled = true;
      return error;
    }
  );
  controller.abort(first);
  await Promise.resolve();
  expect(reader.cancel).toHaveBeenCalledWith(first);
  pendingCancel.reject(new Error('later cancel failure'));
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(reader.releaseLock).not.toHaveBeenCalled();
  pendingRead.resolve({ done: true, value: undefined });
  expect(await observed).toBe(first);
  expect(reader.cancel).toHaveBeenCalledTimes(1);
  expect(reader.releaseLock).toHaveBeenCalledTimes(1);
});
it('already-aborted admission cancels without reading and awaits original cancellation', async () => {
  const controller = new AbortController();
  controller.abort('first');
  const pendingCancel = deferred<void>();
  const reader = {
    read: vi.fn(async () => ({ done: true as const, value: undefined })),
    cancel: vi.fn(() => pendingCancel.promise),
    releaseLock: vi.fn(() => {}),
  };
  const running = readBrowserFrameBody(fake(reader).body, controller.signal);
  const observed = running.catch((error: unknown) => error);
  await Promise.resolve();
  expect(reader.read).not.toHaveBeenCalled();
  expect(reader.releaseLock).not.toHaveBeenCalled();
  pendingCancel.resolve();
  expect(await observed).toBe('first');
});
it.each([undefined, null, false, 0, ''])(
  'retains a falsy read failure %s across cancellation/release failures',
  async (first) => {
    const reader = {
      read: vi.fn(() => Promise.reject(first)),
      cancel: vi.fn(async () => {
        throw new Error('cancel');
      }),
      releaseLock: vi.fn(() => {
        throw new Error('release');
      }),
    };
    let caught = false;
    try {
      await readBrowserFrameBody(fake(reader).body);
    } catch (error) {
      caught = true;
      expect(error).toBe(first);
    }
    expect(caught).toBe(true);
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  }
);
it('captures original method receivers before the first await', async () => {
  const pendingRead = deferred<ReadableStreamReadResult<Uint8Array>>();
  const reader = {
    read: vi.fn(() => pendingRead.promise),
    cancel: vi.fn(async () => {}),
    releaseLock: vi.fn(() => {}),
  };
  const originalRelease = reader.releaseLock;
  const running = readBrowserFrameBody(fake(reader).body);
  reader.releaseLock = vi.fn(() => {
    throw new Error('replacement');
  });
  pendingRead.resolve({ done: true, value: undefined });
  await expect(running).rejects.toThrow('truncated');
  expect(originalRelease).toHaveBeenCalledTimes(1);
  expect(reader.releaseLock).not.toHaveBeenCalled();
});
