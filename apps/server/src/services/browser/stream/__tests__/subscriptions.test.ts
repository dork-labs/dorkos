import { parseBrowserResult } from '@dorkos/browser';
import { describe, expect, it, vi, onTestFinished } from 'vitest';
import { BrowserPixelSubscriptions, ViewerRefusal } from '../subscriptions.js';
import type { OriginalViewerAdmission } from '../subscriptions.js';
import type { PrivateBrowserCaptureDispatcher } from '@dorkos/browser/server-owner';
import type { BrowserBinding } from '@dorkos/shared/browser-schemas';

// Protocol-only producer doubles: these do not establish native capture, auth or actual rendering.
const binding: BrowserBinding = {
  browserId: 'B'.repeat(22),
  browserGeneration: 1,
  tabId: 'T'.repeat(22),
  navigationGeneration: 1,
  viewportVersion: 1,
  epoch: 0,
  inputGeneration: 0,
};
const origin = 'http://localhost:4242';
function nativeReceipt(value: unknown) {
  const result = parseBrowserResult(value);
  if (result.kind !== 'frame') throw new Error('Expected original frame fixture');
  return result;
}

function fixture(viewersPerBrowser?: number) {
  let current = true,
    sequence = 0;
  const actorIdentity = {},
    grantIdentity = {};
  const proof: OriginalViewerAdmission = Object.freeze({
    binding,
    actorIdentity,
    grantIdentity,
    refresh: async () => {
      if (!current) throw new ViewerRefusal('authority');
    },
    current: () => current,
  });
  const capture = vi.fn<PrivateBrowserCaptureDispatcher['capture']>(async () => ({
    bytes: new Uint8Array([1, 2]),
    receipt: nativeReceipt({
      kind: 'frame',
      binding,
      captureSequence: ++sequence,
      rasterWidth: 1,
      rasterHeight: 1,
      byteLength: 2,
      format: 'jpeg',
      width: 1,
      height: 1,
      pointer: null,
    }),
  }));
  const bank = new BrowserPixelSubscriptions({ capture }, undefined, undefined, viewersPerBrowser);
  return {
    bank,
    proof,
    capture,
    revoke: () => {
      current = false;
    },
  };
}
const receipt = (frame: Awaited<ReturnType<BrowserPixelSubscriptions['next']>>) => ({
  binding: frame.metadata.frame.binding,
  viewerId: frame.metadata.frame.viewerId,
  frameId: frame.metadata.frame.frameId,
  sequence: frame.metadata.frame.sequence,
  stage: 'drawn',
  drawnAt: new Date().toISOString(),
});

describe('original disposable pixel protocol', () => {
  it('requires exact prior delivery before a next frame and advances original capture sequence', async () => {
    const f = fixture();
    try {
      const viewer = f.bank.issue(f.proof, origin);
      const first = await f.bank.next(viewer.token, origin, f.proof.actorIdentity);
      const second = await f.bank.next(viewer.token, origin, f.proof.actorIdentity, receipt(first));
      expect(second.metadata.frame.sequence).toBeGreaterThan(first.metadata.frame.sequence);
      expect(second.metadata.frame.frameId).not.toBe(first.metadata.frame.frameId);
      expect(f.capture).toHaveBeenCalledTimes(2);
    } finally {
      await f.bank.close();
    }
  });

  it.each(['missing', 'wrong', 'replayed'] as const)(
    'rejects %s prior receipt at named protocol boundary',
    async (mode) => {
      const f = fixture();
      try {
        const viewer = f.bank.issue(f.proof, origin);
        const first = await f.bank.next(viewer.token, origin, f.proof.actorIdentity);
        let ack: unknown =
          mode === 'missing' ? undefined : { ...receipt(first), frameId: 'F'.repeat(22) };
        if (mode === 'replayed') {
          await f.bank.next(viewer.token, origin, f.proof.actorIdentity, receipt(first));
          ack = receipt(first);
        }
        await expect(
          f.bank.next(viewer.token, origin, f.proof.actorIdentity, ack)
        ).rejects.toMatchObject({ reason: 'receipt' });
        expect(f.capture).toHaveBeenCalledTimes(mode === 'replayed' ? 2 : 1);
      } finally {
        await f.bank.close();
      }
    }
  );

  it('keeps a stalled viewer independent and reconnect starts a new prior-frame lifetime', async () => {
    const f = fixture();
    try {
      const slow = f.bank.issue(f.proof, origin),
        peer = f.bank.issue(f.proof, origin);
      const slowFrame = await f.bank.next(slow.token, origin, f.proof.actorIdentity);
      const first = await f.bank.next(peer.token, origin, f.proof.actorIdentity);
      await f.bank.next(peer.token, origin, f.proof.actorIdentity, receipt(first));
      expect(f.capture).toHaveBeenCalledTimes(3);
      f.bank.disconnect(slow.token);
      const fresh = f.bank.issue(f.proof, origin);
      await expect(
        f.bank.next(fresh.token, origin, f.proof.actorIdentity, receipt(slowFrame))
      ).rejects.toMatchObject({ reason: 'receipt' });
      expect(f.proof.current()).toBe(true);
      expect(f.capture).toHaveBeenCalledTimes(3);
    } finally {
      await f.bank.close();
    }
  });

  it('fences matching original grant/session loss and refuses cross-origin ticket use', async () => {
    const f = fixture();
    try {
      const viewer = f.bank.issue(f.proof, origin);
      f.bank.grantLost({});
      await f.bank.next(viewer.token, origin, f.proof.actorIdentity);
      f.bank.grantLost(f.proof.grantIdentity!);
      await expect(f.bank.next(viewer.token, origin, f.proof.actorIdentity)).rejects.toMatchObject({
        reason: 'authority',
      });
      const second = f.bank.issue(f.proof, origin);
      f.bank.identityLost(f.proof.actorIdentity);
      await expect(f.bank.next(second.token, origin, f.proof.actorIdentity)).rejects.toMatchObject({
        reason: 'authority',
      });
      const third = f.bank.issue(f.proof, origin);
      await expect(
        f.bank.next(third.token, 'http://foreign.invalid', f.proof.actorIdentity)
      ).rejects.toMatchObject({ reason: 'authority' });
    } finally {
      await f.bank.close();
    }
  });

  it.each(['getter-close', 'getter-revoke', 'current-close'] as const)(
    'refuses issuance after exact final %s observation',
    async (mode) => {
      const f = fixture();
      let reads = 0,
        currentReads = 0;
      const original = f.proof;
      const proof: OriginalViewerAdmission = {
        binding: original.binding,
        get actorIdentity() {
          if (++reads === 2) {
            if (mode === 'getter-close') void f.bank.close();
            if (mode === 'getter-revoke') f.revoke();
          }
          return original.actorIdentity;
        },
        grantIdentity: original.grantIdentity,
        refresh: original.refresh,
        current: () => {
          currentReads++;
          if (mode === 'current-close') void f.bank.close();
          return original.current();
        },
      };
      try {
        expect(() => f.bank.issue(proof, origin)).toThrowError(new ViewerRefusal('authority'));
        expect(reads).toBe(2);
        expect(currentReads).toBe(1);
        expect(f.capture).not.toHaveBeenCalled();
      } finally {
        await f.bank.close();
      }
    }
  );

  it('reads the expiry clock after the original currentness callback', async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    vi.setSystemTime(new Date('2026-10-05T00:00:00.000Z'));
    const f = fixture();
    let crossExpiry = false;
    const proof: OriginalViewerAdmission = {
      ...f.proof,
      current: () => {
        if (crossExpiry) vi.setSystemTime(new Date('2026-10-05T00:00:30.001Z'));
        return true;
      },
    };
    try {
      const viewer = f.bank.issue(proof, origin);
      crossExpiry = true;
      await expect(f.bank.next(viewer.token, origin, proof.actorIdentity)).rejects.toMatchObject({
        reason: 'authority',
      });
      expect(f.capture).not.toHaveBeenCalled();
    } finally {
      await f.bank.close();
      vi.useRealTimers();
    }
  });

  it('freezes delivered metadata and isolates output mutation from private ACK custody', async () => {
    const f = fixture();
    try {
      const viewer = f.bank.issue(f.proof, origin);
      const first = await f.bank.next(viewer.token, origin, f.proof.actorIdentity);
      expect(Object.isFrozen(first.metadata)).toBe(true);
      expect(Object.isFrozen(first.metadata.frame)).toBe(true);
      expect(Object.isFrozen(first.metadata.geometry)).toBe(true);
      expect(Object.isFrozen(first.metadata.geometry.cssViewport)).toBe(true);
      expect(Object.isFrozen(first.metadata.geometry.raster)).toBe(true);
      expect(Reflect.set(first.metadata.geometry.raster, 'width', 99)).toBe(false);
      expect(Object.isFrozen(first.metadata.frame.binding)).toBe(true);
      expect(Reflect.set(first.metadata.frame, 'frameId', 'F'.repeat(22))).toBe(false);
      expect(Reflect.set(first.metadata.frame.binding, 'epoch', 9)).toBe(false);
      first.bytes[0] = 99;
      const second = await f.bank.next(viewer.token, origin, f.proof.actorIdentity, receipt(first));
      expect(second.bytes[0]).toBe(1);
      expect(second.metadata.frame.binding.epoch).toBe(0);
      expect(f.capture).toHaveBeenCalledTimes(2);
    } finally {
      await f.bank.close();
    }
  });

  it('fences authority loss during receipt inspection before another original capture', async () => {
    const f = fixture();
    try {
      const viewer = f.bank.issue(f.proof, origin);
      const first = await f.bank.next(viewer.token, origin, f.proof.actorIdentity);
      const prior = new Proxy(receipt(first), {
        getOwnPropertyDescriptor(target, key) {
          if (key === 'frameId') f.revoke();
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
      await expect(
        f.bank.next(viewer.token, origin, f.proof.actorIdentity, prior)
      ).rejects.toMatchObject({ reason: 'authority' });
      expect(f.capture).toHaveBeenCalledTimes(1);
    } finally {
      await f.bank.close();
    }
  });

  it('bounds retained originals after all viewers disconnect and joins all sixteen natural terminals', async () => {
    const f = fixture();
    type Capture = Awaited<ReturnType<PrivateBrowserCaptureDispatcher['capture']>>;
    const releases: Array<(value: Capture) => void> = [];
    const observed: Promise<unknown>[] = [];
    f.capture.mockImplementation(
      () =>
        new Promise<Capture>((resolve) => {
          releases.push(resolve);
        })
    );
    let close: Promise<unknown> | undefined;
    try {
      for (let i = 0; i < 16; i++) {
        const viewer = f.bank.issue(f.proof, origin);
        observed.push(
          f.bank.next(viewer.token, origin, f.proof.actorIdentity).catch((error: unknown) => error)
        );
        await vi.waitFor(() => expect(releases).toHaveLength(i + 1));
        f.bank.disconnect(viewer.token);
      }
      const excess = f.bank.issue(f.proof, origin);
      await expect(f.bank.next(excess.token, origin, f.proof.actorIdentity)).rejects.toMatchObject({
        reason: 'capacity',
      });
      expect(f.capture).toHaveBeenCalledTimes(16);
      expect(releases).toHaveLength(16);
      let finished = false;
      close = f.bank.close().finally(() => {
        finished = true;
      });
      const sample: Capture = {
        bytes: new Uint8Array([1, 2]),
        receipt: nativeReceipt({
          kind: 'frame',
          binding,
          captureSequence: 1,
          rasterWidth: 1,
          rasterHeight: 1,
          byteLength: 2,
          format: 'jpeg',
          width: 1,
          height: 1,
          pointer: null,
        }),
      };
      for (const release of releases.slice(0, 15)) release(sample);
      await Promise.all(observed.slice(0, 15));
      expect(finished).toBe(false);
      releases[15]!(sample);
      // The original requests still refuse; their actual permission cancellation does not fail cleanup.
      await expect(close).resolves.toBeUndefined();
      expect(await observed[15]).toMatchObject({ reason: 'authority' });
      expect(finished).toBe(true);
    } finally {
      // Even a failed control must release every original producer before closing custody.
      for (const release of releases)
        release({
          bytes: new Uint8Array([1, 2]),
          receipt: nativeReceipt({
            kind: 'frame',
            binding,
            captureSequence: 1,
            rasterWidth: 1,
            rasterHeight: 1,
            byteLength: 2,
            format: 'jpeg',
            width: 1,
            height: 1,
            pointer: null,
          }),
        });
      await Promise.all(observed);
      await (close ?? f.bank.close().catch(() => undefined));
    }
  });

  it('refuses a seventeenth live viewer before any capture', async () => {
    const f = fixture();
    try {
      for (let i = 0; i < 16; i++) f.bank.issue(f.proof, origin);
      expect(() => f.bank.issue(f.proof, origin)).toThrowError(new ViewerRefusal('capacity'));
      expect(f.capture).not.toHaveBeenCalled();
    } finally {
      await f.bank.close();
    }
  });

  it.each(['oversized', 'stale', 'nonmonotonic'] as const)(
    'rejects actual original %s capture at the capture boundary',
    async (mode) => {
      const f = fixture();
      try {
        const viewer = f.bank.issue(f.proof, origin);
        const first = await f.bank.next(viewer.token, origin, f.proof.actorIdentity);
        const original = f.capture.getMockImplementation()!;
        f.capture.mockImplementationOnce(async (command, authority) => {
          const value = await original(command, authority);
          if (mode === 'oversized') {
            const bytes = new Uint8Array(2 * 1024 * 1024 + 1);
            return { bytes, receipt: { ...value.receipt, byteLength: bytes.byteLength } };
          }
          if (mode === 'stale')
            return {
              ...value,
              receipt: nativeReceipt({
                ...value.receipt,
                binding: { ...binding, tabId: 'U'.repeat(22) },
              }),
            };
          return {
            ...value,
            receipt: { ...value.receipt, captureSequence: first.metadata.frame.sequence },
          };
        });
        await expect(
          f.bank.next(viewer.token, origin, f.proof.actorIdentity, receipt(first))
        ).rejects.toMatchObject({ reason: 'capture' });
        expect(f.capture).toHaveBeenCalledTimes(2);
      } finally {
        await f.bank.close();
      }
    }
  );

  it('does not let ticket possession borrow the original authenticated actor', async () => {
    const f = fixture();
    try {
      const viewer = f.bank.issue(f.proof, origin);
      await expect(f.bank.next(viewer.token, origin, {})).rejects.toMatchObject({
        reason: 'authority',
      });
      expect(f.capture).not.toHaveBeenCalled();
      await f.bank.next(viewer.token, origin, f.proof.actorIdentity);
    } finally {
      await f.bank.close();
    }
  });

  it('retains entered original capture through disconnect/close and suppresses late publication', async () => {
    const f = fixture();
    let release!: (value: Awaited<ReturnType<typeof f.capture>>) => void;
    const original = new Promise<Awaited<ReturnType<typeof f.capture>>>((yes) => {
      release = yes;
    });
    f.capture.mockImplementationOnce(() => original);
    const viewer = f.bank.issue(f.proof, origin);
    const operation = f.bank.next(viewer.token, origin, f.proof.actorIdentity);
    const observed = operation.catch((error: unknown) => error);
    onTestFinished(async () => {
      release({
        bytes: new Uint8Array([1, 2]),
        receipt: nativeReceipt({
          kind: 'frame',
          binding,
          captureSequence: 1,
          rasterWidth: 1,
          rasterHeight: 1,
          byteLength: 2,
          format: 'jpeg',
          width: 1,
          height: 1,
          pointer: null,
        }),
      });
      await observed;
      await f.bank.close();
    });
    await vi.waitFor(() => expect(f.capture).toHaveBeenCalledTimes(1));
    f.bank.disconnect(viewer.token);
    let terminal = false;
    const close = f.bank.close().finally(() => {
      terminal = true;
    });
    await Promise.resolve();
    expect(terminal).toBe(false);
    release({
      bytes: new Uint8Array([1, 2]),
      receipt: nativeReceipt({
        kind: 'frame',
        binding,
        captureSequence: 1,
        rasterWidth: 1,
        rasterHeight: 1,
        byteLength: 2,
        format: 'jpeg',
        width: 1,
        height: 1,
        pointer: null,
      }),
    });
    expect(await observed).toMatchObject({ reason: 'authority' });
    await expect(close).resolves.toBeUndefined();
    expect(terminal).toBe(true);
  });

  it('rejects renewed authority loss after capture before delivering pixels', async () => {
    const f = fixture();
    const original = f.capture.getMockImplementation()!;
    f.capture.mockImplementationOnce(async (command, authority) => {
      const value = await original(command, authority);
      f.revoke();
      return value;
    });
    try {
      const viewer = f.bank.issue(f.proof, origin);
      await expect(f.bank.next(viewer.token, origin, f.proof.actorIdentity)).rejects.toMatchObject({
        reason: 'authority',
      });
      expect(f.capture).toHaveBeenCalledTimes(1);
    } finally {
      await f.bank.close();
    }
  });
});

it('publishes exact 2x CSS/raster envelope and original pointer while correlating the unchanged drawn frame ACK', async () => {
  const f = fixture();
  let sequence = 0;
  const originalPointer = { x: 17, y: 11, revision: 3 };
  f.capture.mockImplementation(async () => ({
    bytes: new Uint8Array([1, 2]),
    receipt: nativeReceipt({
      kind: 'frame',
      binding,
      captureSequence: ++sequence,
      byteLength: 2,
      format: 'jpeg',
      width: 1280,
      height: 720,
      rasterWidth: 2560,
      rasterHeight: 1440,
      pointer: originalPointer,
    }),
  }));
  try {
    const viewer = f.bank.issue(f.proof, origin);
    const first = await f.bank.next(viewer.token, origin, f.proof.actorIdentity);
    expect(first.metadata.frame).toMatchObject({ width: 1280, height: 720 });
    expect(first.metadata.geometry).toEqual({
      cssViewport: { width: 1280, height: 720 },
      raster: { width: 2560, height: 1440, format: 'jpeg' },
      scaleX: 2,
      scaleY: 2,
    });
    expect(first.metadata.pointer).toEqual(originalPointer);
    expect(Object.isFrozen(first.metadata.pointer)).toBe(true);
    expect(Reflect.set(first.metadata.pointer!, 'x', 99)).toBe(false);
    const second = await f.bank.next(viewer.token, origin, f.proof.actorIdentity, receipt(first));
    expect(second.metadata.frame.sequence).toBe(2);
    expect(second.metadata.pointer).toEqual(originalPointer);
    expect(f.capture).toHaveBeenCalledTimes(2);
  } finally {
    await f.bank.close();
  }
});

it('navigation synchronously fences matching viewers and joins their held original capture only', async () => {
  const f = fixture();
  const original = f.capture.getMockImplementation()!;
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entry = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const originals: { pending?: ReturnType<BrowserPixelSubscriptions['next']> } = {};
  onTestFinished(async () => {
    release();
    await Promise.allSettled(originals.pending ? [originals.pending] : []);
    await f.bank.close();
  });
  f.capture.mockImplementation(async (...args) => {
    entered();
    await held;
    return original(...args);
  });
  const viewer = f.bank.issue(f.proof, origin);
  const pending = (originals.pending = f.bank.next(viewer.token, origin, f.proof.actorIdentity));
  // Preserve the original rejection before any assertion or navigation fence.
  const result = pending.then(
    (value) => ({ failed: false as const, value }),
    (reason) => ({ failed: true as const, reason })
  );
  await entry;
  await f.bank.bindingLost({ ...binding, tabId: 'U'.repeat(22) });
  expect(f.bank.viewerCount()).toBe(1);
  let joined = false;
  const drain = f.bank.bindingLost(binding).then(() => {
    joined = true;
  });
  expect(f.bank.viewerCount()).toBe(0);
  expect(() => f.bank.issue(f.proof, origin)).toThrow('authority');
  await Promise.resolve();
  expect(joined).toBe(false);
  expect(f.capture).toHaveBeenCalledTimes(1);
  release();
  await drain;
  expect((await result).failed).toBe(true);
  expect(joined).toBe(true);
});

it('navigation fencing refuses same-document-generation viewer reissue until a genuinely current successor proof', async () => {
  const f = fixture();
  try {
    await f.bank.bindingLost(binding);
    expect(() => f.bank.issue(f.proof, origin)).toThrow('authority');
    expect(() =>
      f.bank.issue({ ...f.proof, binding: { ...binding, epoch: 1, inputGeneration: 1 } }, origin)
    ).toThrow('authority');
    const successor = {
      ...binding,
      epoch: 1,
      inputGeneration: 1,
      navigationGeneration: binding.navigationGeneration + 1,
    };
    const issued = f.bank.issue({ ...f.proof, binding: successor }, origin);
    expect(issued.binding).toEqual(successor);
    expect(f.bank.viewerCount()).toBe(1);
  } finally {
    await f.bank.close();
  }
});

it('retains exact navigation-retired cleanup custody without allowing another frame or foreign identity', async () => {
  const f = fixture();
  onTestFinished(() => f.bank.close());
  const viewer = f.bank.issue(f.proof, origin);
  await f.bank.bindingLost(binding);
  expect(f.bank.viewerCount()).toBe(0);
  expect(f.bank.ownsTicket(viewer.token)).toBe(true);
  await expect(f.bank.next(viewer.token, origin, f.proof.actorIdentity)).rejects.toThrow(
    'authority'
  );
  expect(f.capture).not.toHaveBeenCalled();
  expect(() => f.bank.disconnectFor(viewer.token, {})).toThrow('authority');
  expect(f.bank.ownsTicket(viewer.token)).toBe(true);
  f.bank.disconnectFor(viewer.token, f.proof.actorIdentity);
  expect(f.bank.ownsTicket(viewer.token)).toBe(false);
  expect(() => f.bank.disconnectFor(viewer.token, f.proof.actorIdentity)).toThrow('authority');
});

it('bounds retained navigation cleanup originals and reuses only an actually consumed slot', async () => {
  const f = fixture();
  onTestFinished(() => f.bank.close());
  const retired: string[] = [];
  for (let generation = 0; generation < 64; generation++) {
    const original = Object.freeze({
      ...binding,
      navigationGeneration: binding.navigationGeneration + generation,
      epoch: binding.epoch + generation,
      inputGeneration: binding.inputGeneration + generation,
    });
    const viewer = f.bank.issue(Object.freeze({ ...f.proof, binding: original }), origin);
    retired.push(viewer.token);
    await f.bank.bindingLost(original);
  }
  const next = Object.freeze({
    ...binding,
    navigationGeneration: binding.navigationGeneration + 64,
    epoch: binding.epoch + 64,
    inputGeneration: binding.inputGeneration + 64,
  });
  expect(() => f.bank.issue(Object.freeze({ ...f.proof, binding: next }), origin)).toThrow(
    'capacity'
  );
  expect(() => f.bank.disconnectFor(retired[0]!, {})).toThrow('authority');
  expect(() => f.bank.issue(Object.freeze({ ...f.proof, binding: next }), origin)).toThrow(
    'capacity'
  );
  f.bank.disconnectFor(retired[0]!, f.proof.actorIdentity);
  const viewer = f.bank.issue(Object.freeze({ ...f.proof, binding: next }), origin);
  expect(f.bank.viewerCount()).toBe(1);
  f.bank.disconnectFor(viewer.token, f.proof.actorIdentity);
});

it('joins the old viewer capture before acknowledged renewal admits its successor', async () => {
  const f = fixture();
  const originalCapture = f.capture.getMockImplementation()!;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.capture.mockImplementationOnce(async (...args) => {
    entered();
    await held;
    return originalCapture(...args);
  });
  const viewer = f.bank.issue(f.proof, origin);
  const old = f.bank.next(viewer.token, origin, f.proof.actorIdentity);
  const oldResult = old.then(
    () => ({ rejected: false }),
    () => ({ rejected: true })
  );
  let renewed = false;
  const duties: Promise<unknown>[] = [oldResult];
  onTestFinished(async () => {
    release();
    await Promise.allSettled(duties);
    await f.bank.close();
  });
  await started;
  const peer = f.bank.issue(f.proof, origin);
  await f.bank.next(peer.token, origin, f.proof.actorIdentity);
  const disconnected = Promise.resolve(f.bank.disconnectFor(viewer.token, f.proof.actorIdentity));
  const successor = disconnected.then(async () => {
    renewed = true;
    const fresh = f.bank.issue(f.proof, origin);
    return f.bank.next(fresh.token, origin, f.proof.actorIdentity);
  });
  duties.push(disconnected, successor);
  expect(f.bank.ownsTicket(viewer.token)).toBe(false);
  await Promise.resolve();
  expect(renewed).toBe(false);
  expect(f.capture).toHaveBeenCalledTimes(2);
  release();
  await successor;
  expect((await oldResult).rejected).toBe(true);
  expect(renewed).toBe(true);
  expect(f.capture).toHaveBeenCalledTimes(3);
});

it.each([false, undefined])(
  'retains original capture rejection %s through disconnect join',
  async (cause) => {
    const f = fixture();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.capture.mockImplementationOnce(async () => {
      entered();
      await held;
      throw cause;
    });
    const viewer = f.bank.issue(f.proof, origin);
    const old = f.bank.next(viewer.token, origin, f.proof.actorIdentity);
    const oldResult = old.then(
      () => ({ rejected: false, value: null }),
      (value: unknown) => ({ rejected: true, value })
    );
    const duties: Promise<unknown>[] = [oldResult];
    onTestFinished(async () => {
      release();
      await Promise.allSettled(duties);
      const close = await f.bank.close().then(
        () => ({ rejected: false, value: null }),
        (value: unknown) => ({ rejected: true, value })
      );
      if (close.rejected) expect(close.value).toBe(cause);
    });
    await started;
    const disconnected = Promise.resolve(f.bank.disconnectFor(viewer.token, f.proof.actorIdentity));
    const result = disconnected.then(
      () => ({ rejected: false, value: null }),
      (value: unknown) => ({ rejected: true, value })
    );
    duties.push(result);
    release();
    expect(await result).toEqual({ rejected: true, value: cause });
    expect(await oldResult).toEqual({ rejected: true, value: cause });
  }
);

it('keeps only original terminal cleanup after actual lease expiry during a held capture', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-07T00:00:00.000Z'));
  const f = fixture();
  const originalCapture = f.capture.getMockImplementation()!;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const duties: Promise<unknown>[] = [];
  onTestFinished(async () => {
    release();
    try {
      await Promise.allSettled(duties);
      await f.bank.close();
    } finally {
      vi.useRealTimers();
    }
  });
  f.capture.mockImplementationOnce(async (...args) => {
    entered();
    await held;
    return originalCapture(...args);
  });
  const viewer = f.bank.issue(f.proof, origin);
  const old = f.bank.next(viewer.token, origin, f.proof.actorIdentity);
  const oldResult = old.then(
    () => ({ rejected: false }),
    () => ({ rejected: true })
  );
  duties.push(oldResult);
  await started;
  vi.advanceTimersByTime(30_000);
  expect(f.bank.viewerCount()).toBe(0);
  expect(f.bank.ownsTicket(viewer.token)).toBe(true);
  expect(() => f.bank.disconnectFor(viewer.token, {})).toThrow('authority');
  await expect(f.bank.next(viewer.token, origin, f.proof.actorIdentity)).rejects.toThrow(
    'authority'
  );
  let acknowledged = false;
  const disconnected = Promise.resolve(
    f.bank.disconnectFor(viewer.token, f.proof.actorIdentity)
  ).then(() => {
    acknowledged = true;
  });
  duties.push(disconnected);
  await Promise.resolve();
  expect(acknowledged).toBe(false);
  expect(f.capture).toHaveBeenCalledOnce();
  release();
  await disconnected;
  expect((await oldResult).rejected).toBe(true);
  expect(f.bank.ownsTicket(viewer.token)).toBe(false);
  const successor = f.bank.issue(f.proof, origin);
  await f.bank.next(successor.token, origin, f.proof.actorIdentity);
  expect(f.capture).toHaveBeenCalledTimes(2);
});

it('automatically removes expired terminal custody only after its original capture returns', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const originalCapture = f.capture.getMockImplementation()!;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const duties: Promise<unknown>[] = [];
  onTestFinished(async () => {
    release();
    try {
      await Promise.allSettled(duties);
      await f.bank.close();
    } finally {
      vi.useRealTimers();
    }
  });
  f.capture.mockImplementationOnce(async (...args) => {
    entered();
    await held;
    return originalCapture(...args);
  });
  const viewer = f.bank.issue(f.proof, origin);
  const old = f.bank.next(viewer.token, origin, f.proof.actorIdentity);
  const result = old.then(
    () => ({ rejected: false }),
    () => ({ rejected: true })
  );
  duties.push(result);
  await started;
  vi.advanceTimersByTime(30_000);
  expect(f.bank.ownsTicket(viewer.token)).toBe(true);
  release();
  await result;
  await Promise.resolve();
  expect(f.bank.ownsTicket(viewer.token)).toBe(false);
  expect(() => f.bank.disconnectFor(viewer.token, f.proof.actorIdentity)).toThrow('authority');
});

it('enforces a lower constructor viewer ceiling before proof getters and retains existing capture bounds', async () => {
  const f = fixture(1);
  onTestFinished(async () => {
    await f.bank.close();
  });
  f.bank.issue(f.proof, origin);
  const read = vi.fn(() => {
    throw new Error('EXCESS_VIEWER_GETTER');
  });
  const proof = Object.defineProperty({ ...f.proof }, 'binding', { get: read });
  expect(() => f.bank.issue(proof, origin)).toThrow('capacity');
  expect(read).not.toHaveBeenCalled();
  expect(f.bank.viewerCount()).toBe(1);
  expect(f.capture).not.toHaveBeenCalled();
});
it('rechecks the captured viewer ceiling after the original authority callback reenters issue', async () => {
  const f = fixture(1);
  onTestFinished(async () => {
    await f.bank.close();
  });
  const proof: OriginalViewerAdmission = {
    ...f.proof,
    current: () => {
      f.bank.issue(f.proof, origin);
      return true;
    },
  };
  expect(() => f.bank.issue(proof, origin)).toThrow('authority');
  expect(f.bank.viewerCount()).toBe(1);
  expect(f.capture).not.toHaveBeenCalled();
});
it.each([0, 17, 1.5, NaN])(
  'refuses invalid constructor viewer ceiling %s before capture getters',
  (limit) => {
    const read = vi.fn(() => {
      throw new Error('CAPTURE_GETTER');
    });
    const engine = Object.defineProperty({ capture: vi.fn() }, 'capture', { get: read });
    expect(() => new BrowserPixelSubscriptions(engine, undefined, undefined, limit)).toThrow(
      'capacity'
    );
    expect(read).not.toHaveBeenCalled();
  }
);
