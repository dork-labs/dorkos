import { it, expect, vi } from 'vitest';
import {
  installOriginalInputAcceptanceObserver,
  observeOriginalNativeInput,
} from '../acceptance-observer.js';
import { parseBrowserBinding } from '../../contracts.js';
import type { NativeInputTransport } from '../types.js';
const binding = parseBrowserBinding({
  browserId: 'browser_acceptance_control',
  browserGeneration: 1,
  tabId: 'tab_acceptance_control_01',
  navigationGeneration: 0,
  viewportVersion: 0,
  epoch: 0,
  inputGeneration: 0,
});
/** Unit delivery doubles test the private instrumentation, not real native acceptance. */
it('cannot report acknowledgement or release the observed transport before original native settlement', async () => {
  let settle!: () => void;
  const original = new Promise<void>((done) => {
    settle = done;
  });
  const after = vi.fn(async () => {});
  const fixture = installOriginalInputAcceptanceObserver({
    matches: () => true,
    admitted: () => {},
    resetPublished: () => {},
    afterNativeAcknowledgement: after,
    dispose: () => {},
  });
  const dispatch = vi.fn(() => original);
  const native: NativeInputTransport = {
    dispatch,
    cancelComposition: async () => {},
    cancelDrag: async () => {},
    cleanup: async () => {},
  };
  const wrapped = observeOriginalNativeInput(native, () => binding);
  const abort = new AbortController();
  let fulfilled = false;
  const call = wrapped.dispatch({ kind: 'mouseMove', x: 20, y: 20 }, abort.signal).then(() => {
    fulfilled = true;
  });
  try {
    abort.abort();
    await Promise.resolve();
    expect(after).not.toHaveBeenCalled();
    expect(fulfilled).toBe(false);
    settle();
    await call;
    expect(after).toHaveBeenCalledOnce();
    fixture.assertHealthy();
  } finally {
    settle();
    await call;
    fixture.close();
  }
});
it('keeps original falsy failure and captured cleanup receiver without publishing a false acknowledgement', async () => {
  const after = vi.fn(async () => {}),
    original = vi.fn(async () => {
      throw undefined;
    });
  const fixture = installOriginalInputAcceptanceObserver({
    matches: () => true,
    admitted: () => {},
    resetPublished: () => {},
    afterNativeAcknowledgement: after,
    dispose: () => {},
  });
  const native: NativeInputTransport = {
    dispatch: original,
    cancelComposition: async () => {},
    cancelDrag: async () => {},
    cleanup: async () => {},
  };
  const wrapped = observeOriginalNativeInput(native, () => binding);
  native.dispatch = vi.fn(async () => {});
  try {
    const result = await Promise.allSettled([
      wrapped.dispatch({ kind: 'keyUp', key: 'Shift' }, new AbortController().signal),
    ]);
    expect(result[0]).toEqual({ status: 'rejected', reason: undefined });
    expect(original).toHaveBeenCalledOnce();
    expect(native.dispatch).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  } finally {
    fixture.close();
  }
});
