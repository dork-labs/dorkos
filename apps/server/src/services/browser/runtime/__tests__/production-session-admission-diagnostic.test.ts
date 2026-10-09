import { expect, it, vi } from 'vitest';
const originals = vi.hoisted(() => ({ current: vi.fn(() => true), info: vi.fn() }));
vi.mock('../startup-mode.js', () => ({
  captureProductionBrowserMode: () => ({ current: originals.current }),
}));
vi.mock('../../../../lib/logger.js', () => ({ logger: { info: originals.info } }));
import { createProductionBrowserSession } from '../production-session.js';

it('uses original short-circuit decisions without entering absent network acquisition', async () => {
  originals.info.mockReset();
  originals.current.mockReset().mockReturnValue(true);
  const original = createProductionBrowserSession(
    {} as Parameters<typeof createProductionBrowserSession>[0]
  );
  expect(original.current()).toBe(false);
  expect(originals.info.mock.calls.at(-1)?.[1]).toEqual({ stage: 'session.grant', ordinal: 1 });
  expect(originals.current).toHaveBeenCalledOnce();
  originals.current.mockReturnValue(false);
  expect(original.current()).toBe(false);
  expect(originals.info.mock.calls.at(-1)?.[1]).toEqual({ stage: 'session.mode', ordinal: 2 });
  await original.close();
  const calls = originals.current.mock.calls.length;
  expect(original.current()).toBe(false);
  expect(originals.current).toHaveBeenCalledTimes(calls);
  expect(originals.info.mock.calls.at(-1)?.[1]).toEqual({ stage: 'session.closed', ordinal: 3 });
});
it.each([false, undefined])(
  'preserves original mode fault %s despite a throwing logger',
  async (cause) => {
    originals.current.mockImplementation(() => {
      throw cause;
    });
    originals.info.mockImplementation(() => {
      throw new Error('DIAGNOSTIC_ONLY');
    });
    const original = createProductionBrowserSession(
      {} as Parameters<typeof createProductionBrowserSession>[0]
    );
    let first: { value: unknown } | undefined;
    try {
      original.current();
    } catch (value) {
      first = { value };
    }
    expect(first).toEqual({ value: cause });
    await original.close();
  }
);
