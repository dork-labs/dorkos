import { it, expect, vi, beforeEach } from 'vitest';
const logging = vi.hoisted(() => {
  const sink = vi.fn();
  return { sink, current: { info: sink } };
});
const clock = vi.hoisted(() => vi.fn(() => 0));
vi.mock('node:perf_hooks', () => ({ performance: { now: clock } }));
const sink = logging.sink;
vi.mock('../../../../lib/logger.js', () => ({
  get logger() {
    return logging.current;
  },
}));
beforeEach(() => {
  sink.mockReset();
  clock.mockReset().mockReturnValue(0);
  logging.current = { info: sink };
});
import { observeOriginalStartupPhase } from '../original-phase-diagnostic.js';
it.each([undefined, false, new Error('original stage')])(
  'diagnostic failure cannot replace original %s',
  async (value) => {
    sink.mockImplementation(() => {
      throw new Error('diagnostic failure');
    });
    let entered = 0;
    const original = observeOriginalStartupPhase('mode.native-journal', () => {
      entered++;
      throw value;
    });
    await expect(original).rejects.toBe(value);
    expect(entered).toBe(1);
  }
);
it('diagnostics emit fixed stage and primitive failure without reading original error properties', async () => {
  sink.mockReset();
  const value = Object.create(null, {
    message: {
      get() {
        throw new Error('unknown getter');
      },
    },
  });
  await expect(
    observeOriginalStartupPhase('mode.verify-existing', async () => {
      throw value;
    })
  ).rejects.toBe(value);
  expect(sink.mock.calls.map((call) => call[1].event)).toEqual(['start', 'failed']);
  expect(sink.mock.calls[1]?.[1]).toMatchObject({
    phase: 'mode.verify-existing',
    failure: 'opaque',
  });
});

it('a replaced logger export is captured per phase with its exact original receiver', async () => {
  const current = {
    info: vi.fn(function (this: unknown, _message: unknown, _record: unknown) {
      expect(this).toBe(current);
    }),
  };
  logging.current = current;
  expect(await observeOriginalStartupPhase('mode.inspect-initial', async () => 17)).toBe(17);
  expect(sink).not.toHaveBeenCalled();
  expect(current.info).toHaveBeenCalledTimes(2);
  expect(current.info.mock.calls.map((call) => call[1])).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ event: 'start' }),
      expect.objectContaining({ event: 'settled' }),
    ])
  );
});
it('unknown logger getter failure cannot replace an original producer rejection', async () => {
  logging.current = Object.defineProperty({}, 'info', {
    get() {
      throw false;
    },
  }) as typeof logging.current;
  await expect(
    observeOriginalStartupPhase('mode.native-journal', () => {
      throw undefined;
    })
  ).rejects.toBeUndefined();
});

it.each([
  'session.authorize-workspace',
  'session.network-open',
  'owner.resolve-package',
  'owner.verify-existing',
  'owner.inspect-existing',
  'owner.engine-open',
  'storage.read-input',
  'storage.verify-build',
  'storage.resolve-config',
  'storage.inspect-installation',
  'storage.native-journal',
  'storage.qualification-grant',
] as const)('retains the original held %s producer and its exact settlement', async (phase) => {
  let release!: (value: object) => void;
  const value = Object.freeze({ original: true });
  const held = new Promise<object>((resolve) => {
    release = resolve;
  });
  const producer = vi.fn(() => held);
  const work = observeOriginalStartupPhase(phase, producer);
  let settled = false;
  void work.then(() => {
    settled = true;
  });
  try {
    await Promise.resolve();
    expect(producer).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    expect(sink.mock.calls.map((call) => call[1].event)).toEqual(['start']);
    release(value);
    expect(await work).toBe(value);
    expect(sink.mock.calls.map((call) => call[1].event)).toEqual(['start', 'settled']);
  } finally {
    release(value);
    await work;
  }
});

it.each([false, undefined])('unavailable diagnostic clock preserves original %s', async (value) => {
  clock.mockImplementation(() => {
    throw new Error('clock unavailable');
  });
  const producer = vi.fn(() => {
    throw value;
  });
  await expect(observeOriginalStartupPhase('storage.read-input', producer)).rejects.toBe(value);
  expect(producer).toHaveBeenCalledTimes(1);
  expect(sink).not.toHaveBeenCalled();
});
it('unavailable diagnostic clock preserves successful original settlement', async () => {
  clock.mockImplementation(() => {
    throw false;
  });
  const value = Object.freeze({ original: true });
  const producer = vi.fn(() => value);
  expect(await observeOriginalStartupPhase('storage.read-input', producer)).toBe(value);
  expect(producer).toHaveBeenCalledTimes(1);
  expect(sink).not.toHaveBeenCalled();
});
