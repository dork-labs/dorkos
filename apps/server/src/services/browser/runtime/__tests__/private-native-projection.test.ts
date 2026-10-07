import { EventEmitter } from 'node:events';
import { expect, it, vi, onTestFinished } from 'vitest';
import {
  createOriginalNativeProjectionReceiver,
  createOriginalNativeProjectionSender,
  readOriginalProcessNativeProjection,
  readOriginalConnectDenialBank,
  type OriginalNativeChannel,
  type OriginalViewerCensus,
} from '../private-native-projection.js';
import type { PrivateBrowserRetirementReceiver } from '@dorkos/browser/server-owner';

const manager = { pid: 21, birth: 'darwin-bsd-start:100:1' };
const supervisor = { pid: 22, birth: 'darwin-bsd-start:100:2' };
const root = { pid: 23, birth: 'darwin-bsd-start:100:3' };
const browserId = 'B'.repeat(22);
function receiver(generation = 0, ordinary = () => true) {
  // Only the resource callback's original receiver fields are consumed by this unit seam.
  return { browserId, browserGeneration: generation, isOrdinary: ordinary } as Pick<
    PrivateBrowserRetirementReceiver,
    'browserId' | 'browserGeneration' | 'isOrdinary'
  > as PrivateBrowserRetirementReceiver;
}
const original = () => ({ manager, supervisor, root, identities: [root], complete: true });
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function pair() {
  const a = new EventEmitter(),
    b = new EventEmitter();
  const sent: { from: string; value: object }[] = [];
  let connected = true;
  const disconnect = () => {
    if (!connected) return;
    connected = false;
    a.emit('disconnect');
    b.emit('disconnect');
  };
  const port = (from: string, own: EventEmitter, peer: EventEmitter): OriginalNativeChannel => ({
    send(value, callback) {
      sent.push({ from, value });
      queueMicrotask(() => {
        if (!connected) {
          callback(new Error('ORIGINAL_CHANNEL_RETURNED'));
          return;
        }
        peer.emit('message', value);
        callback(undefined);
      });
      return false; // Genuine backpressure is not a send completion or failure.
    },
    disconnect,
    on: (event, callback) => {
      own.on(event, callback);
    },
    off: (event, callback) => {
      own.off(event, callback);
    },
  });
  return { a, b, sent, child: port('child', a, b), parent: port('parent', b, a), disconnect };
}
it('joins original retained validator before SDK admission and retains each actual generation', async () => {
  const channel = pair();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const retain = vi
    .fn()
    .mockImplementationOnce(() => held)
    .mockResolvedValue(undefined);
  const parent = createOriginalNativeProjectionReceiver({
    channel: channel.parent,
    pid: manager.pid,
    retainBirth: retain,
    retainViewerSample: async () => {},
  });
  const child = createOriginalNativeProjectionSender(channel.child, manager.pid);
  let admitted = false;
  const opening = child.resources.onOriginalChild(receiver(), original()).then(() => {
    admitted = true;
  });
  await turn();
  expect(parent.births()).toHaveLength(1);
  expect(admitted).toBe(false);
  expect(
    channel.sent.filter((row) => (row.value as { type: string }).type === 'original-native-ack')
  ).toHaveLength(0);
  release();
  await opening;
  await child.resources.onOriginalChild(receiver(1), original());
  expect(parent.births().map((row) => row.browserGeneration)).toEqual([0, 1]);
  await child.close();
  await parent.close();
});
it.each([false, undefined])(
  'keeps original falsy validator failure %s while refusing launch',
  async (value) => {
    const channel = pair();
    const parent = createOriginalNativeProjectionReceiver({
      channel: channel.parent,
      pid: manager.pid,
      retainBirth: async () => {
        throw value;
      },
      retainViewerSample: async () => {},
    });
    const child = createOriginalNativeProjectionSender(channel.child, manager.pid);
    const opening = child.resources.onOriginalChild(receiver(), original());
    await expect(opening).rejects.toThrow();
    expect(parent.births()).toHaveLength(1);
    let thrown = false;
    try {
      parent.assertCurrent();
    } catch (cause) {
      thrown = true;
      expect(Object.is(cause, value)).toBe(true);
    }
    expect(thrown).toBe(true);
    await expect(parent.close()).rejects.toBe(value);
    await expect(child.close()).rejects.toThrow();
  }
);
it('retains unknown original cohort and emits an actual refused ACK', async () => {
  const channel = pair();
  const parent = createOriginalNativeProjectionReceiver({
    channel: channel.parent,
    pid: manager.pid,
    retainBirth: async () => {},
    retainViewerSample: async () => {},
  });
  const child = createOriginalNativeProjectionSender(channel.child, manager.pid);
  await expect(
    child.resources.onOriginalChild(receiver(), { ...original(), complete: false })
  ).rejects.toThrow();
  expect(parent.births()[0]?.complete).toBe(false);
  expect(channel.sent.some((row) => (row.value as { accepted?: boolean }).accepted === false)).toBe(
    true
  );
  await expect(parent.close()).rejects.toThrow('ORIGINAL_NATIVE_COMPLETE_BIRTH_REQUIRED');
  await expect(child.close()).rejects.toThrow();
});
it('rejects substituted generation ACK without releasing the held original', async () => {
  const channel = pair();
  let release!: () => void;
  const held = new Promise<void>((yes) => {
    release = yes;
  });
  const parent = createOriginalNativeProjectionReceiver({
    channel: channel.parent,
    pid: manager.pid,
    retainBirth: () => held,
    retainViewerSample: async () => {},
  });
  const child = createOriginalNativeProjectionSender(channel.child, manager.pid);
  const opening = child.resources.onOriginalChild(receiver(), original());
  const rejected = expect(opening).rejects.toThrow('ORIGINAL_NATIVE_ACK_MISMATCH');
  await turn();
  const message = channel.sent.find(
    (row) => (row.value as { type: string }).type === 'original-native-birth'
  )!.value as { nonce: string; sequence: number };
  channel.a.emit('message', {
    type: 'original-native-ack',
    version: 1,
    nonce: message.nonce,
    sequence: message.sequence,
    browserId,
    browserGeneration: 1,
    accepted: true,
  });
  await rejected;
  let returned = false;
  const closing = parent.close().then(
    () => {
      returned = true;
    },
    () => {
      returned = true;
    }
  );
  await turn();
  expect(returned).toBe(false);
  release();
  await closing;
  await expect(child.close()).rejects.toThrow();
});
it('does not substitute ACK for an original held send callback', async () => {
  const channel = pair();
  const originalSend = channel.child.send;
  let complete!: (value: unknown) => void;
  channel.child.send = (value, callback) =>
    originalSend(value, (error) => {
      if ((value as { type: string }).type === 'original-native-birth') complete = callback;
      else callback(error);
    });
  const parent = createOriginalNativeProjectionReceiver({
    channel: channel.parent,
    pid: manager.pid,
    retainBirth: async () => {},
    retainViewerSample: async () => {},
  });
  const child = createOriginalNativeProjectionSender(channel.child, manager.pid);
  let admitted = false;
  const opening = child.resources.onOriginalChild(receiver(), original()).then(() => {
    admitted = true;
  });
  await turn();
  expect(parent.births()).toHaveLength(1);
  expect(admitted).toBe(false);
  complete(undefined);
  await opening;
  await child.close();
  await parent.close();
});
it('EOF rejects waiting launch but retains its original validator join and known births', async () => {
  const channel = pair();
  let release!: () => void;
  const held = new Promise<void>((yes) => {
    release = yes;
  });
  const parent = createOriginalNativeProjectionReceiver({
    channel: channel.parent,
    pid: manager.pid,
    retainBirth: () => held,
    retainViewerSample: async () => {},
  });
  const child = createOriginalNativeProjectionSender(channel.child, manager.pid);
  const opening = child.resources.onOriginalChild(receiver(), original());
  const rejected = expect(opening).rejects.toThrow('ORIGINAL_NATIVE_CHANNEL_EOF');
  await turn();
  channel.disconnect();
  await rejected;
  expect(parent.births()).toHaveLength(1);
  let joined = false;
  const closing = parent.close().then(
    () => {
      joined = true;
    },
    () => {
      joined = true;
    }
  );
  await turn();
  expect(joined).toBe(false);
  release();
  await closing;
  await expect(child.close()).rejects.toThrow();
});
it('consumes actual canonical viewer sample and captures original consumer before replacement', async () => {
  const channel = pair(),
    consume = vi.fn(async () => {});
  const options = {
    channel: channel.parent,
    pid: manager.pid,
    retainBirth: async () => {},
    retainViewerSample: consume,
  };
  const parent = createOriginalNativeProjectionReceiver(options);
  const child = createOriginalNativeProjectionSender(channel.child, manager.pid);
  options.retainViewerSample = vi.fn(async () => {
    throw false;
  });
  child.viewerSamples({
    at: 1,
    binding: {
      browserId,
      browserGeneration: 0,
      tabId: 'T'.repeat(22),
      navigationGeneration: 0,
      viewportVersion: 0,
      epoch: 0,
      inputGeneration: 0,
    },
    viewerId: 'V'.repeat(22),
    pendingFrames: 1,
    pendingBytes: 100,
    encodingMs: 2,
    droppedFrames: 0,
    closed: false,
  });
  await turn();
  expect(consume).toHaveBeenCalledOnce();
  expect(options.retainViewerSample).not.toHaveBeenCalled();
  await child.close();
  await parent.close();
});

it('keeps an unarmed original IPC process inert before channel/send getters', () => {
  const channel = Object.getOwnPropertyDescriptor(process, 'channel');
  const send = Object.getOwnPropertyDescriptor(process, 'send');
  const touched = vi.fn(() => {
    throw new Error('UNARMED_IPC_TOUCHED');
  });
  Object.defineProperty(process, 'channel', { configurable: true, get: touched });
  Object.defineProperty(process, 'send', { configurable: true, get: touched });
  try {
    expect(readOriginalProcessNativeProjection(false)).toBeUndefined();
    expect(touched).not.toHaveBeenCalled();
  } finally {
    if (channel) Object.defineProperty(process, 'channel', channel);
    else Reflect.deleteProperty(process, 'channel');
    if (send) Object.defineProperty(process, 'send', send);
    else Reflect.deleteProperty(process, 'send');
  }
});
it('refuses late original revocation after a genuine retained ACK', async () => {
  const channel = pair();
  let ordinary = true;
  const parent = createOriginalNativeProjectionReceiver({
    channel: channel.parent,
    pid: manager.pid,
    retainBirth: async () => {
      ordinary = false;
    },
    retainViewerSample: async () => {},
  });
  const child = createOriginalNativeProjectionSender(channel.child, manager.pid);
  await expect(
    child.resources.onOriginalChild(
      receiver(0, () => ordinary),
      original()
    )
  ).rejects.toThrow('ORIGINAL_NATIVE_PRODUCER_REVOKED');
  expect(parent.births()).toHaveLength(1);
  await expect(parent.close()).rejects.toThrow('ORIGINAL_NATIVE_CHANNEL_CLOSED');
  await expect(child.close()).rejects.toThrow();
});
it.each([false, undefined])('retains original synchronous send failure %s', async (value) => {
  const channel = pair();
  channel.child.send = () => {
    throw value;
  };
  const child = createOriginalNativeProjectionSender(channel.child, manager.pid);
  await expect(child.resources.onOriginalChild(receiver(), original())).rejects.toBe(value);
  await expect(child.close()).rejects.toBe(value);
});

it('joins an original HELLO callback before early startup close and still disconnects on READY rejection', async () => {
  const channel = pair();
  const send = channel.child.send;
  let release!: (value: unknown) => void;
  channel.child.send = (message, callback) =>
    send(message, () => {
      release = callback;
    });
  const disconnect = vi.fn(channel.child.disconnect);
  channel.child.disconnect = disconnect;
  const child = createOriginalNativeProjectionSender(channel.child, manager.pid);
  await turn();
  let returned = false;
  const closing = child.close().finally(() => {
    returned = true;
  });
  const failed = expect(closing).rejects.toThrow('ORIGINAL_NATIVE_CHANNEL_CLOSED');
  await turn();
  expect(returned).toBe(false);
  expect(disconnect).not.toHaveBeenCalled();
  release(undefined);
  await failed;
  expect(disconnect).toHaveBeenCalledOnce();
});
it.each([false, undefined])(
  'closes original IPC after HELLO send callback/throw failure %s',
  async (value) => {
    const channel = pair();
    const disconnect = vi.fn(channel.child.disconnect);
    channel.child.disconnect = disconnect;
    channel.child.send = (_message, callback) => {
      if (value === undefined) throw value;
      queueMicrotask(() => callback(value));
      return true;
    };
    const child = createOriginalNativeProjectionSender(channel.child, manager.pid);
    await turn();
    await expect(child.close()).rejects.toBe(value);
    expect(disconnect).toHaveBeenCalledOnce();
  }
);

it('retains original zero and occupied viewer census only after its exact browser birth', async () => {
  const channel = pair(),
    consume = vi.fn(async (_value: OriginalViewerCensus) => {});
  const options = {
    channel: channel.parent,
    pid: manager.pid,
    retainBirth: async () => {},
    retainViewerSample: async () => {},
    retainViewerCensus: consume,
  };
  const parent = createOriginalNativeProjectionReceiver(options);
  const child = createOriginalNativeProjectionSender(channel.child, manager.pid);
  await child.resources.onOriginalChild(receiver(), original());
  const census = child.viewerSamples.census!({ browserId, browserGeneration: 0 });
  options.retainViewerCensus = vi.fn(async () => {
    throw false;
  });
  census({ at: 1, subscriptions: 0, closed: false });
  census({ at: 2, subscriptions: 1, closed: false });
  census({ at: 3, subscriptions: 0, closed: true });
  await turn();
  expect(consume.mock.calls.map(([value]) => value)).toEqual([
    expect.objectContaining({
      browserId,
      browserGeneration: 0,
      at: 1,
      subscriptions: 0,
      closed: false,
      sequence: 1,
    }),
    expect.objectContaining({
      browserId,
      browserGeneration: 0,
      at: 2,
      subscriptions: 1,
      closed: false,
      sequence: 2,
    }),
    expect.objectContaining({
      browserId,
      browserGeneration: 0,
      at: 3,
      subscriptions: 0,
      closed: true,
      sequence: 3,
    }),
  ]);
  expect(options.retainViewerCensus).not.toHaveBeenCalled();
  await child.close();
  await parent.close();
});
it('an unobserved original browser generation cannot qualify a zero-viewer census', async () => {
  const channel = pair(),
    consume = vi.fn(async (_value: OriginalViewerCensus) => {});
  const parent = createOriginalNativeProjectionReceiver({
    channel: channel.parent,
    pid: manager.pid,
    retainBirth: async () => {},
    retainViewerSample: async () => {},
    retainViewerCensus: consume,
  });
  const child = createOriginalNativeProjectionSender(channel.child, manager.pid);
  await child.resources.onOriginalChild(receiver(), original());
  child.viewerSamples.census!({ browserId, browserGeneration: 1 })({
    at: 1,
    subscriptions: 0,
    closed: false,
  });
  await turn();
  expect(consume).not.toHaveBeenCalled();
  expect(() => parent.assertCurrent()).toThrow('VIEWER_CENSUS_CORRELATION');
  await expect(parent.close()).rejects.toThrow('VIEWER_CENSUS_CORRELATION');
  await expect(child.close()).rejects.toThrow();
});
it.each([false, undefined])(
  'held original census consumer failure %s joins before closure',
  async (cause) => {
    const channel = pair();
    let release!: () => void;
    const held = new Promise<void>((yes) => {
      release = yes;
    });
    const consume = vi.fn(async () => {
      await held;
      throw cause;
    });
    const parent = createOriginalNativeProjectionReceiver({
      channel: channel.parent,
      pid: manager.pid,
      retainBirth: async () => {},
      retainViewerSample: async () => {},
      retainViewerCensus: consume,
    });
    const child = createOriginalNativeProjectionSender(channel.child, manager.pid);
    await child.resources.onOriginalChild(receiver(), original());
    child.viewerSamples.census!({ browserId, browserGeneration: 0 })({
      at: 1,
      subscriptions: 0,
      closed: false,
    });
    await turn();
    expect(consume).toHaveBeenCalledOnce();
    let returned = false;
    const closing = parent.close().finally(() => {
      returned = true;
    });
    void closing.catch(() => {});
    await turn();
    expect(returned).toBe(false);
    release();
    await expect(closing).rejects.toBe(cause);
    await expect(child.close()).rejects.toThrow();
  }
);

it('retains original CONNECT denial only for an accepted original browser generation', async () => {
  const channel = pair();
  const retained = vi.fn(async () => {});
  const parent = createOriginalNativeProjectionReceiver({
    channel: channel.parent,
    pid: manager.pid,
    retainBirth: async () => {},
    retainViewerSample: async () => {},
    retainConnectDenial: retained,
  });
  const child = createOriginalNativeProjectionSender(channel.child, manager.pid);
  await child.resources.onOriginalChild(receiver(), original());
  child.connectDenials({
    browserId,
    browserGeneration: 0,
    authority: 'denied.example:443',
    outcome: 'denied',
    beforeDial: true,
    reason: 'ADMIN_DENIED',
  });
  await turn();
  expect(parent.connectDenials()).toHaveLength(1);
  expect(readOriginalConnectDenialBank(parent)).toEqual(parent.connectDenials());
  expect(() =>
    readOriginalConnectDenialBank({ connectDenials: () => parent.connectDenials() })
  ).toThrow('ORIGINAL_NATIVE_CONNECT_BANK_REQUIRED');
  expect(parent.connectDenials()[0]).toMatchObject({
    browserId,
    browserGeneration: 0,
    authority: 'denied.example:443',
    reason: 'ADMIN_DENIED',
    beforeDial: true,
  });
  expect(retained).toHaveBeenCalledTimes(1);
  await child.close();
  await parent.close();
});

it('unknown generation CONNECT telemetry is refused and cannot become an observed denial', async () => {
  const channel = pair();
  const parent = createOriginalNativeProjectionReceiver({
    channel: channel.parent,
    pid: manager.pid,
    retainBirth: async () => {},
    retainViewerSample: async () => {},
  });
  const child = createOriginalNativeProjectionSender(channel.child, manager.pid);
  await child.resources.onOriginalChild(receiver(), original());
  child.connectDenials({
    browserId,
    browserGeneration: 1,
    authority: 'denied.example:443',
    outcome: 'denied',
    beforeDial: true,
    reason: 'ADMIN_DENIED',
  });
  await turn();
  expect(parent.connectDenials()).toEqual([]);
  expect(() => parent.assertCurrent()).toThrow('ORIGINAL_NATIVE_CONNECT_DENIAL_CORRELATION');
  await Promise.allSettled([child.close(), parent.close()]);
});

it.each([false, undefined])(
  'CONNECT acceptance bank preserves original retained sink failure %s',
  async (failure) => {
    const channel = pair();
    const parent = createOriginalNativeProjectionReceiver({
      channel: channel.parent,
      pid: manager.pid,
      retainBirth: async () => {},
      retainViewerSample: async () => {},
      retainConnectDenial: async () => {
        throw failure;
      },
    });
    const child = createOriginalNativeProjectionSender(channel.child, manager.pid);
    await child.resources.onOriginalChild(receiver(), original());
    child.connectDenials({
      browserId,
      browserGeneration: 0,
      authority: 'denied.example:443',
      outcome: 'denied',
      beforeDial: true,
      reason: 'ADMIN_DENIED',
    });
    await turn();
    expect(parent.connectDenials()).toHaveLength(1);
    let thrown = false;
    try {
      readOriginalConnectDenialBank(parent);
    } catch (value) {
      thrown = true;
      expect(Object.is(value, failure)).toBe(true);
    }
    expect(thrown).toBe(true);
    await Promise.allSettled([child.close(), parent.close()]);
  }
);

it('held birth validation retains physical custody without admitting CONNECT denial evidence', async () => {
  const channel = pair();
  let release!: () => void;
  const held = new Promise<void>((yes) => {
    release = yes;
  });
  const retained = vi.fn(async () => {});
  const parent = createOriginalNativeProjectionReceiver({
    channel: channel.parent,
    pid: manager.pid,
    retainBirth: () => held,
    retainViewerSample: async () => {},
    retainConnectDenial: retained,
  });
  const child = createOriginalNativeProjectionSender(channel.child, manager.pid);
  const opening = child.resources.onOriginalChild(receiver(), original());
  void opening.catch(() => {});
  onTestFinished(async () => {
    release();
    await Promise.allSettled([opening, child.close(), parent.close()]);
  });
  await turn();
  expect(parent.births()).toHaveLength(1);
  expect(
    channel.sent.filter((row) => (row.value as { type: string }).type === 'original-native-ack')
  ).toEqual([]);
  child.connectDenials({
    browserId,
    browserGeneration: 0,
    authority: 'denied.example:443',
    outcome: 'denied',
    beforeDial: true,
    reason: 'ADMIN_DENIED',
  });
  await turn();
  expect(parent.connectDenials()).toEqual([]);
  expect(retained).not.toHaveBeenCalled();
  expect(() => readOriginalConnectDenialBank(parent)).toThrow(
    'ORIGINAL_NATIVE_CONNECT_DENIAL_CORRELATION'
  );
  release();
  await expect(opening).rejects.toThrow();
});
