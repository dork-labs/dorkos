import { it, expect, vi, beforeEach } from 'vitest';
const logging = vi.hoisted(() => {
  const sink = vi.fn();
  return { sink, current: { info: sink } };
});
const sink = logging.sink;
vi.mock('../../../../lib/logger.js', () => ({
  get logger() {
    return logging.current;
  },
}));
beforeEach(() => {
  sink.mockReset();
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
