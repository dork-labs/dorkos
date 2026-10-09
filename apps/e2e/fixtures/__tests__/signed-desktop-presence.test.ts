import { EventEmitter } from 'node:events';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, it, vi, onTestFinished } from 'vitest';
import {
  crashOriginalSignedRenderer,
  captureOriginalSignedPresenceCohort,
  parseOriginalSignedPresence,
} from '../signed-desktop/presence.js';

it('captures a bounded immutable original cohort without reading journal paths', () => {
  const original = { pid: 123, birth: 'darwin-bsd-start:1:2' };
  const cohort = captureOriginalSignedPresenceCohort([original]);
  original.pid = 456;
  expect(cohort).toEqual([{ pid: 123, birth: 'darwin-bsd-start:1:2' }]);
  expect(Object.isFrozen(cohort)).toBe(true);
  expect(Object.isFrozen(cohort[0])).toBe(true);
  expect(captureOriginalSignedPresenceCohort([])).toEqual([]);
  expect(() => captureOriginalSignedPresenceCohort([original, original])).toThrow(
    'SIGNED_PRESENCE_NATIVE_COHORT_UNAVAILABLE'
  );
  expect(() =>
    captureOriginalSignedPresenceCohort([{ pid: 123, birth: 'darwin-bsd-start:invalid' }])
  ).toThrow('SIGNED_PRESENCE_NATIVE_COHORT_UNAVAILABLE');
  expect(() =>
    captureOriginalSignedPresenceCohort(
      Array.from({ length: 129 }, (_, i) => ({ pid: i + 1, birth: 'darwin-bsd-start:1:2' }))
    )
  ).toThrow('SIGNED_PRESENCE_NATIVE_COHORT_BOUND');
});

// SDK object/event controls only. These cannot qualify a macOS surface or physical crash.
function renderer() {
  const page = new EventEmitter();
  const reload = vi.fn(async () => {});
  const dispose = vi.fn(async () => {});
  const webContents = { isDestroyed: () => false, forcefullyCrashRenderer: vi.fn() };
  const window = { isDestroyed: () => false, webContents };
  const evaluate = vi.fn(async (effect: (value: typeof window) => void) => effect(window));
  const handle = { evaluate, dispose };
  const browserWindow = vi.fn(async () => handle);
  const app = { browserWindow };
  Object.assign(page, { reload });
  return {
    page,
    reload,
    dispose,
    evaluate,
    webContents,
    browserWindow,
    app: app as unknown as ElectronApplication,
    originalPage: page as unknown as Page,
  };
}

it('holds recovery until the exact original renderer crash event and disposes its handle', async () => {
  const f = renderer();
  const signal = new AbortController();
  let returned = false;
  const work = crashOriginalSignedRenderer(f.app, f.originalPage, signal.signal, () => {});
  void work.catch(() => {});
  onTestFinished(async () => {
    signal.abort();
    await Promise.allSettled([work]);
  });
  await vi.waitFor(() => expect(f.webContents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1));
  void work.then(
    () => {
      returned = true;
    },
    () => {
      returned = true;
    }
  );
  expect(f.reload).not.toHaveBeenCalled();
  expect(returned).toBe(false);
  f.page.emit('crash');
  await work;
  expect(f.browserWindow).toHaveBeenCalledWith(f.originalPage);
  expect(f.reload).toHaveBeenCalledTimes(1);
  expect(f.dispose).toHaveBeenCalledTimes(1);
  expect(f.page.listenerCount('crash')).toBe(0);
});

it.each([false, undefined])(
  'keeps original renderer producer rejection %s despite later handle refusal',
  async (cause) => {
    const f = renderer();
    f.evaluate.mockImplementationOnce(async () => {
      throw cause;
    });
    f.dispose.mockImplementationOnce(async () => {
      throw new Error('later disposal');
    });
    await expect(
      crashOriginalSignedRenderer(f.app, f.originalPage, new AbortController().signal, () => {})
    ).rejects.toBe(cause);
    expect(f.reload).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledTimes(1);
    expect(f.page.listenerCount('crash')).toBe(0);
  }
);

it('requires explicit fixture interaction and captures immutable constructor options', () => {
  const input = {
    executable: '/owned/Presence.app/Contents/MacOS/Presence',
    sha256: 'a'.repeat(64),
    interaction: true,
    probeSwitcher: true,
    crashRenderer: false,
  };
  const captured = parseOriginalSignedPresence(input);
  input.executable = '/different/Presence';
  expect(captured.executable).toBe('/owned/Presence.app/Contents/MacOS/Presence');
  expect(Object.isFrozen(captured)).toBe(true);
  expect(() => parseOriginalSignedPresence({ ...input, interaction: false })).toThrow(
    'SIGNED_PRESENCE_CONFIG_REFUSED'
  );
  expect(() => parseOriginalSignedPresence({ ...input, unsupported: true })).toThrow(
    'SIGNED_PRESENCE_CONFIG_REFUSED'
  );
});
