// @vitest-environment jsdom
import { expect, it, onTestFinished, vi } from 'vitest';
import type { BrowserInputTransport } from '@dorkos/shared/transport';
import {
  BrowserCanvasInput,
  BrowserCanvasInputRefusal,
  type BrowserRenderedInputContext,
} from '../lib/canvas-input';
// DOM and semantic port doubles; canonical draw DTOs here are local preconditions, never authority proof.
const binding = {
  browserId: 'input_browser_reference_0001',
  browserGeneration: 1,
  tabId: 'input_tab_reference_000001',
  navigationGeneration: 0,
  viewportVersion: 0,
  epoch: 0,
  inputGeneration: 0,
};
function fixture(capture = false) {
  const canvas = document.createElement('canvas');
  canvas.tabIndex = 0;
  const captured = new Set<number>();
  const takePointer = vi.fn((id: number) => {
    captured.add(id);
  });
  const releasePointer = vi.fn((id: number) => {
    captured.delete(id);
  });
  if (capture) {
    canvas.setPointerCapture = takePointer;
    canvas.releasePointerCapture = releasePointer;
  }
  document.body.append(canvas);
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    left: 100,
    top: 50,
    width: 640,
    height: 360,
  } as DOMRect);
  const identity = {},
    signal = new AbortController(),
    releases: Array<() => void> = [];
  let context: BrowserRenderedInputContext | undefined = {
    identity,
    controller: { binding, controllerId: 'input_controller_reference_001', status: 'ready' },
    viewer: {
      binding,
      viewerId: 'input_viewer_reference_0001',
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
    presentation: {
      frame: {
        binding,
        viewerId: 'input_viewer_reference_0001',
        frameId: 'input_frame_reference_00001',
        sequence: 1,
        width: 1280,
        height: 720,
        byteLength: 3,
        format: 'jpeg',
      },
      geometry: {
        cssViewport: { width: 1280, height: 720 },
        raster: { width: 2560, height: 1440, format: 'jpeg' },
        scaleX: 2,
        scaleY: 2,
      },
      pointer: { x: 20, y: 30, revision: 1 },
      rasterPointer: { x: 40, y: 60, revision: 1 },
    },
    receipt: {
      binding,
      viewerId: 'input_viewer_reference_0001',
      frameId: 'input_frame_reference_00001',
      sequence: 1,
      stage: 'drawn',
      drawnAt: '2026-10-05T12:00:00.000Z',
    },
  };
  const port: BrowserInputTransport = {
    inputBrowser: vi.fn<BrowserInputTransport['inputBrowser']>(async (command) => ({
      requestId: command.requestId,
      binding: command.binding,
      outcome: 'completed',
    })),
  };
  const failure = vi.fn();
  const adapter = new BrowserCanvasInput(
    canvas,
    port,
    identity,
    () => context,
    [signal.signal],
    failure
  );
  const accepted = new Set<unknown>();
  onTestFinished(async () => {
    let failed = false,
      first: unknown;
    const original = adapter.close();
    for (const close of [
      ...releases,
      async () => {
        try {
          await original;
        } catch (cause) {
          if (
            !accepted.has(cause) &&
            !(cause instanceof BrowserCanvasInputRefusal && cause.reason === 'stale')
          )
            throw cause;
        }
      },
      () => canvas.remove(),
      () => vi.restoreAllMocks(),
    ]) {
      try {
        await close();
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
    }
    if (failed) throw first;
  });
  return {
    canvas,
    captured,
    takePointer,
    releasePointer,
    adapter,
    port,
    failure,
    signal,
    releases,
    context: context!,
    set: (value: typeof context) => {
      context = value;
    },
    accept: (cause: unknown) => accepted.add(cause),
  };
}
const click = (canvas: HTMLCanvasElement) =>
  canvas.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: 420,
      clientY: 230,
      button: 0,
    })
  );
it('maps actual displayed content bounds to CSS pixels at 2x, preserving canonical pointer and original controller binding', async () => {
  const f = fixture(),
    pointer = f.context.presentation.pointer;
  click(f.canvas);
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(1));
  expect(vi.mocked(f.port.inputBrowser).mock.calls[0][0]).toMatchObject({
    kind: 'input',
    binding,
    steps: [{ kind: 'click', x: 640, y: 360, button: 'left' }],
  });
  expect(vi.mocked(f.port.inputBrowser).mock.calls[0][1]).toBe(f.context.controller.controllerId);
  expect(f.context.presentation.pointer).toBe(pointer);
});
it('rejects missing, mismatched, expired and barrier controller/render context before any producer', () => {
  const f = fixture();
  for (const value of [
    undefined,
    { ...f.context, identity: {} },
    { ...f.context, controller: { ...f.context.controller, status: 'barrier' as const } },
    { ...f.context, controller: { ...f.context.controller, controllerId: null } },
    { ...f.context, controller: { ...f.context.controller, binding: { ...binding, epoch: 1 } } },
    { ...f.context, viewer: { ...f.context.viewer, expiresAt: '2000-01-01T00:00:00.000Z' } },
    { ...f.context, receipt: { ...f.context.receipt, sequence: 2 } },
  ]) {
    f.set(value);
    click(f.canvas);
  }
  expect(f.port.inputBrowser).not.toHaveBeenCalled();
});
it('final recheck refuses ownership loss inside original canvas focus callback', () => {
  const f = fixture();
  vi.spyOn(f.canvas, 'focus').mockImplementation(() => f.set(undefined));
  click(f.canvas);
  expect(f.port.inputBrowser).not.toHaveBeenCalled();
});
it('focused keyboard emits one balanced key tap with modifiers, plain text and no IME/repeat approximation', async () => {
  const f = fixture();
  f.canvas.focus();
  f.canvas.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
  );
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(1));
  expect(vi.mocked(f.port.inputBrowser).mock.calls[0][0].steps).toEqual([
    { kind: 'keyDown', key: 'Control' },
    { kind: 'keyDown', key: 'ArrowLeft' },
    { kind: 'keyUp', key: 'ArrowLeft' },
    { kind: 'keyUp', key: 'Control' },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  f.canvas.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'é', bubbles: true, cancelable: true })
  );
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(2));
  expect(vi.mocked(f.port.inputBrowser).mock.calls[1][0].steps).toEqual([
    { kind: 'text', text: 'é' },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const fields of [
    { key: 'ArrowDown', repeat: true },
    { key: 'x', isComposing: true },
    { key: 'F1' },
  ])
    f.canvas.dispatchEvent(new KeyboardEvent('keydown', { ...fields, bubbles: true }));
  expect(f.port.inputBrowser).toHaveBeenCalledTimes(2);
});
it('wheel uses pixel deltas after a CSS mouse move and refuses line/page modes and outside content', async () => {
  const f = fixture();
  f.canvas.dispatchEvent(
    new WheelEvent('wheel', {
      clientX: 420,
      clientY: 230,
      deltaX: 4,
      deltaY: -8,
      deltaMode: 0,
      bubbles: true,
      cancelable: true,
    })
  );
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(1));
  expect(vi.mocked(f.port.inputBrowser).mock.calls[0][0].steps).toEqual([
    { kind: 'mouseMove', x: 640, y: 360 },
    { kind: 'wheel', deltaX: 4, deltaY: -8 },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const deltaMode of [1, 2])
    f.canvas.dispatchEvent(
      new WheelEvent('wheel', { clientX: 420, clientY: 230, deltaY: 1, deltaMode })
    );
  f.canvas.dispatchEvent(new MouseEvent('click', { clientX: 740, clientY: 230 }));
  expect(f.port.inputBrowser).toHaveBeenCalledTimes(1);
});
it.each([undefined, null, false, 0, ''])(
  'loss aborts/removes synchronously but joins held original and keeps its first falsy rejection (%s)',
  async (cause) => {
    const f = fixture();
    let reject!: (cause: unknown) => void;
    const held = new Promise<never>((_yes, no) => {
      reject = no;
    });
    f.releases.push(() => reject(cause));
    f.accept(cause);
    vi.mocked(f.port.inputBrowser).mockImplementationOnce(() => held);
    click(f.canvas);
    await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(1));
    // Trigger local disposal without manufacturing a preexisting failure.
    const original = f.adapter.close();
    let settled = false;
    void original.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    expect(vi.mocked(f.port.inputBrowser).mock.calls[0][2].aborted).toBe(true);
    click(f.canvas);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.port.inputBrowser).toHaveBeenCalledTimes(1);
    reject(cause);
    await expect(original).rejects.toBe(cause);
    expect(f.failure).toHaveBeenCalledWith(cause);
  }
);

it('retains serial keyboard ordering across a newer valid drawn frame in the same binding while the original is held', async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>((yes) => {
    release = yes;
  });
  f.releases.push(release);
  vi.mocked(f.port.inputBrowser).mockImplementationOnce(async (command) => {
    await held;
    return { requestId: command.requestId, binding: command.binding, outcome: 'completed' };
  });
  f.canvas.focus();
  f.canvas.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
  );
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(1));
  f.canvas.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'b', bubbles: true, cancelable: true })
  );
  expect(f.port.inputBrowser).toHaveBeenCalledTimes(1);
  f.set(successor(f.context));
  release();
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(2));
  expect(vi.mocked(f.port.inputBrowser).mock.calls.map((call) => call[0].steps)).toEqual([
    [{ kind: 'text', text: 'a' }],
    [{ kind: 'text', text: 'b' }],
  ]);
});

function successor(context: BrowserRenderedInputContext): BrowserRenderedInputContext {
  const frameId = 'input_successor_frame_reference_01';
  return {
    ...context,
    presentation: {
      ...context.presentation,
      frame: { ...context.presentation.frame, frameId, sequence: 2 },
    },
    receipt: { ...context.receipt, frameId, sequence: 2, drawnAt: '2026-10-05T12:00:01.000Z' },
  };
}
it('refuses queued coordinates from frame A at actual submit after frame B is drawn in the same binding', async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>((yes) => {
    release = yes;
  });
  f.releases.push(release);
  vi.mocked(f.port.inputBrowser).mockImplementationOnce(async (command) => {
    await held;
    return { requestId: command.requestId, binding: command.binding, outcome: 'completed' };
  });
  f.canvas.focus();
  f.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(1));
  click(f.canvas);
  f.set(successor(f.context));
  release();
  await vi.waitFor(() => expect(f.failure).toHaveBeenCalledTimes(1));
  expect(f.failure.mock.calls[0][0]).toMatchObject({ reason: 'stale' });
  expect(f.port.inputBrowser).toHaveBeenCalledTimes(1);
  await expect(f.adapter.close()).rejects.toMatchObject({ reason: 'stale' });
});
it('idle controller loss synchronously fences and reports the exact first cause once', async () => {
  const f = fixture(),
    cause = false;
  f.accept(cause);
  f.signal.abort(cause);
  expect(f.failure).toHaveBeenCalledExactlyOnceWith(cause);
  click(f.canvas);
  expect(f.port.inputBrowser).not.toHaveBeenCalled();
  await expect(f.adapter.close()).rejects.toBe(cause);
  expect(f.failure).toHaveBeenCalledTimes(1);
});
it('refuses modified ordinary pointer gestures and normalizes Mac Control-contextmenu to one secondary click', async () => {
  const f = fixture();
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
    f.canvas.dispatchEvent(
      new MouseEvent('click', {
        clientX: 420,
        clientY: 230,
        button: 0,
        bubbles: true,
        [modifier]: true,
      })
    );
    f.canvas.dispatchEvent(
      new WheelEvent('wheel', {
        clientX: 420,
        clientY: 230,
        deltaY: 2,
        bubbles: true,
        [modifier]: true,
      })
    );
  }
  expect(f.port.inputBrowser).not.toHaveBeenCalled();
  f.canvas.dispatchEvent(
    new MouseEvent('contextmenu', {
      clientX: 420,
      clientY: 230,
      button: 0,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
  );
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(1));
  expect(vi.mocked(f.port.inputBrowser).mock.calls[0][0].steps).toEqual([
    { kind: 'click', x: 640, y: 360, button: 'right' },
  ]);
});
it.each([false, true])(
  'Space is a balanced native key tap rather than text insertion (Shift %s)',
  async (shiftKey) => {
    const f = fixture();
    f.canvas.focus();
    f.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', shiftKey, bubbles: true }));
    await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(1));
    expect(vi.mocked(f.port.inputBrowser).mock.calls[0][0].steps).toEqual([
      ...(shiftKey ? [{ kind: 'keyDown', key: 'Shift' }] : []),
      { kind: 'keyDown', key: 'Space' },
      { kind: 'keyUp', key: 'Space' },
      ...(shiftKey ? [{ kind: 'keyUp', key: 'Shift' }] : []),
    ]);
  }
);

it('intentional navigation disposal removes listeners now but joins the exact original POST cancellation', async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>((yes) => {
    release = yes;
  });
  f.releases.push(release);
  vi.mocked(f.port.inputBrowser).mockImplementationOnce(async (_command, _controller, signal) => {
    await held;
    signal.throwIfAborted();
    throw new Error('original abort was required');
  });
  f.canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 200, clientY: 100 }));
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(1));
  let settled = false;
  const original = f.adapter.disposeForNavigation();
  expect(f.adapter.disposeForNavigation()).toBe(original);
  void original.then(() => {
    settled = true;
  });
  f.canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 200, clientY: 100 }));
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(f.port.inputBrowser).toHaveBeenCalledTimes(1);
  release();
  await original;
  expect(f.failure).not.toHaveBeenCalled();
});

it('separates an idle old-context loss primary from actually completed input/listener cleanup', async () => {
  const f = fixture();
  const original = new Error('original replaced controller');
  f.accept(original);
  f.signal.abort(original);
  const observed = await f.adapter.settleForSuccessor();
  expect(observed).toEqual({
    settled: true,
    cleanup: { failed: false },
    primary: { failed: true, first: original },
  });
  expect(f.port.inputBrowser).not.toHaveBeenCalled();
});

it('retains rejected original submitted body as unknown cleanup even when listener teardown succeeds', async () => {
  const f = fixture();
  f.accept(undefined);
  vi.mocked(f.port.inputBrowser).mockRejectedValueOnce(undefined);
  click(f.canvas);
  await vi.waitFor(() => expect(f.failure).toHaveBeenCalledTimes(1));
  expect(await f.adapter.settleForSuccessor()).toEqual({
    settled: true,
    cleanup: { failed: true, first: undefined },
    primary: { failed: true, first: undefined },
  });
  expect(f.port.inputBrowser).toHaveBeenCalledTimes(1);
});

// Pointer capture below is a DOM double; assertions observe actual semantic port calls, not native pixels.
function dragEvent(
  canvas: HTMLCanvasElement,
  type: string,
  x: number,
  y: number,
  options: MouseEventInit = {}
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    ...options,
  });
  Object.defineProperties(event, {
    pointerId: { value: 7 },
    pointerType: { value: 'mouse' },
    isPrimary: { value: true },
  });
  canvas.dispatchEvent(event);
}
it('submits one balanced 2x CSS drag only on release, using a fresh drawn frame, and consumes the subsequent click', async () => {
  const f = fixture(true);
  dragEvent(f.canvas, 'pointerdown', 150, 100);
  dragEvent(f.canvas, 'pointermove', 200, 120);
  expect(f.captured.has(7)).toBe(true);
  expect(f.port.inputBrowser).not.toHaveBeenCalled();
  f.set({
    ...f.context,
    presentation: {
      ...f.context.presentation,
      frame: {
        ...f.context.presentation.frame,
        frameId: 'input_frame_reference_00002',
        sequence: 2,
      },
    },
    receipt: { ...f.context.receipt, frameId: 'input_frame_reference_00002', sequence: 2 },
  });
  dragEvent(f.canvas, 'pointerup', 250, 150);
  f.canvas.dispatchEvent(
    new MouseEvent('click', { detail: 1, bubbles: true, clientX: 250, clientY: 150 })
  );
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(1));
  expect(vi.mocked(f.port.inputBrowser).mock.calls[0][0].steps).toEqual([
    { kind: 'mouseMove', x: 100, y: 100 },
    { kind: 'mouseDown', button: 'left' },
    { kind: 'mouseMove', x: 200, y: 140 },
    { kind: 'mouseMove', x: 300, y: 200 },
    { kind: 'mouseUp', button: 'left' },
  ]);
  expect(f.captured.size).toBe(0);
  expect(f.context.presentation.pointer).toEqual({ x: 20, y: 30, revision: 1 });
});
it('bounds a long modified drag to sixteen balanced steps without queuing native downs', async () => {
  const f = fixture(true),
    modifiers = { shiftKey: true, ctrlKey: true, altKey: true, metaKey: true };
  dragEvent(f.canvas, 'pointerdown', 150, 100, modifiers);
  for (let n = 0; n < 200; n++) dragEvent(f.canvas, 'pointermove', 151 + n, 120, modifiers);
  expect(f.port.inputBrowser).not.toHaveBeenCalled();
  dragEvent(f.canvas, 'pointerup', 400, 150, modifiers);
  f.canvas.dispatchEvent(
    new MouseEvent('contextmenu', {
      detail: 0,
      bubbles: true,
      clientX: 400,
      clientY: 150,
      button: 2,
    })
  );
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(1));
  const steps = vi.mocked(f.port.inputBrowser).mock.calls[0][0].steps;
  expect(steps).toHaveLength(16);
  expect(steps.slice(0, 4)).toEqual(
    ['Shift', 'Control', 'Alt', 'Meta'].map((key) => ({ kind: 'keyDown', key }))
  );
  expect(steps.slice(-5)).toEqual([
    { kind: 'mouseUp', button: 'left' },
    ...['Meta', 'Alt', 'Control', 'Shift'].map((key) => ({ kind: 'keyUp', key })),
  ]);
  expect(steps.at(-6)).toEqual({ kind: 'mouseMove', x: 600, y: 200 });
});
it.each(['pointercancel', 'lostpointercapture', 'blur'])(
  'drops an unsubmitted drag on %s and releases capture',
  (type) => {
    const f = fixture(true);
    dragEvent(f.canvas, 'pointerdown', 150, 100);
    dragEvent(f.canvas, 'pointermove', 250, 150);
    dragEvent(f.canvas, type, 250, 150);
    dragEvent(f.canvas, 'pointerup', 250, 150);
    expect(f.captured.size).toBe(0);
    expect(f.port.inputBrowser).not.toHaveBeenCalled();
  }
);
it.each(['controller', 'viewer', 'viewport', 'binding'])(
  'discards collected coordinates when original %s ownership changes',
  (kind) => {
    const f = fixture(true);
    dragEvent(f.canvas, 'pointerdown', 150, 100);
    dragEvent(f.canvas, 'pointermove', 250, 150);
    if (kind === 'controller')
      f.set({
        ...f.context,
        controller: { ...f.context.controller, controllerId: 'input_controller_reference_002' },
      });
    if (kind === 'viewer')
      f.set({
        ...f.context,
        viewer: { ...f.context.viewer, viewerId: 'input_viewer_reference_0002' },
      });
    if (kind === 'viewport')
      vi.mocked(f.canvas.getBoundingClientRect).mockReturnValue({
        left: 100,
        top: 50,
        width: 320,
        height: 180,
      } as DOMRect);
    if (kind === 'binding') f.set(undefined);
    dragEvent(f.canvas, 'pointerup', 250, 150);
    expect(f.port.inputBrowser).not.toHaveBeenCalled();
    expect(f.captured.size).toBe(0);
  }
);
it('a stationary pointer gesture preserves exactly one ordinary click', async () => {
  const f = fixture(true);
  dragEvent(f.canvas, 'pointerdown', 150, 100);
  dragEvent(f.canvas, 'pointerup', 150, 100);
  f.canvas.dispatchEvent(
    new MouseEvent('click', { bubbles: true, clientX: 150, clientY: 100, detail: 1 })
  );
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(1));
  expect(vi.mocked(f.port.inputBrowser).mock.calls[0][0].steps).toEqual([
    { kind: 'click', x: 100, y: 100, button: 'left' },
  ]);
});
it('pending-capacity refusal never submits a drag down and joins the earlier original POST', async () => {
  const f = fixture(true);
  let release!: () => void;
  const held = new Promise<void>((yes) => {
    release = yes;
  });
  f.releases.push(release);
  vi.mocked(f.port.inputBrowser).mockImplementationOnce(async (command) => {
    await held;
    return { requestId: command.requestId, binding: command.binding, outcome: 'completed' };
  });
  click(f.canvas);
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(1));
  for (let n = 0; n < 16; n++) click(f.canvas);
  dragEvent(f.canvas, 'pointerdown', 150, 100);
  dragEvent(f.canvas, 'pointermove', 250, 150);
  dragEvent(f.canvas, 'pointerup', 250, 150);
  const reason = f.failure.mock.calls[0][0];
  expect(reason).toBeInstanceOf(BrowserCanvasInputRefusal);
  expect(reason.reason).toBe('capacity');
  f.accept(reason);
  let settled = false;
  const close = f.adapter.close();
  void close.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(f.port.inputBrowser).toHaveBeenCalledTimes(1);
  expect(f.captured.size).toBe(0);
  release();
  await expect(close).rejects.toBe(reason);
});
it('a released drag queued behind held typing refuses an advanced frame at actual submission', async () => {
  const f = fixture(true);
  let release!: () => void;
  const held = new Promise<void>((yes) => {
    release = yes;
  });
  f.releases.push(release);
  vi.mocked(f.port.inputBrowser).mockImplementationOnce(async (command) => {
    await held;
    return { requestId: command.requestId, binding: command.binding, outcome: 'completed' };
  });
  f.canvas.focus();
  f.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(1));
  dragEvent(f.canvas, 'pointerdown', 150, 100);
  dragEvent(f.canvas, 'pointermove', 250, 150);
  dragEvent(f.canvas, 'pointerup', 250, 150);
  f.set({
    ...f.context,
    presentation: {
      ...f.context.presentation,
      frame: {
        ...f.context.presentation.frame,
        frameId: 'input_frame_reference_00002',
        sequence: 2,
      },
    },
    receipt: { ...f.context.receipt, frameId: 'input_frame_reference_00002', sequence: 2 },
  });
  release();
  await vi.waitFor(() => expect(f.failure).toHaveBeenCalledTimes(1));
  const reason = f.failure.mock.calls[0][0];
  expect(reason).toBeInstanceOf(BrowserCanvasInputRefusal);
  expect(reason.reason).toBe('stale');
  f.accept(reason);
  await expect(f.adapter.close()).rejects.toBe(reason);
  expect(f.port.inputBrowser).toHaveBeenCalledTimes(1);
});

it('display/session loss drops an unsubmitted drag and retains the original loss reason', async () => {
  const f = fixture(true),
    reason = new Error('original display loss');
  f.accept(reason);
  dragEvent(f.canvas, 'pointerdown', 150, 100);
  dragEvent(f.canvas, 'pointermove', 250, 150);
  f.signal.abort(reason);
  dragEvent(f.canvas, 'pointerup', 250, 150);
  expect(f.port.inputBrowser).not.toHaveBeenCalled();
  expect(f.captured.size).toBe(0);
  await expect(f.adapter.close()).rejects.toBe(reason);
});

it('ownership replacement at a new terminal endpoint cannot turn the discarded drag into a successor click', () => {
  const f = fixture(true);
  dragEvent(f.canvas, 'pointerdown', 150, 100);
  dragEvent(f.canvas, 'pointermove', 200, 120);
  f.set({
    ...f.context,
    controller: { ...f.context.controller, controllerId: 'input_controller_reference_002' },
  });
  dragEvent(f.canvas, 'pointerup', 250, 150);
  f.canvas.dispatchEvent(
    new MouseEvent('click', { detail: 1, bubbles: true, clientX: 250, clientY: 150 })
  );
  expect(f.port.inputBrowser).not.toHaveBeenCalled();
  expect(f.captured.size).toBe(0);
});
it('cancelled capture retains the original pointer until its terminal endpoint click is consumed', () => {
  const f = fixture(true);
  dragEvent(f.canvas, 'pointerdown', 150, 100);
  dragEvent(f.canvas, 'pointermove', 200, 120);
  dragEvent(f.canvas, 'lostpointercapture', 200, 120);
  dragEvent(f.canvas, 'pointerup', 250, 150);
  f.canvas.dispatchEvent(
    new MouseEvent('click', { detail: 1, bubbles: true, clientX: 250, clientY: 150 })
  );
  expect(f.port.inputBrowser).not.toHaveBeenCalled();
});

it.each(['controller', 'binding', 'geometry', 'modifiers'])(
  'cancelled stationary %s replacement cannot produce a successor click',
  (kind) => {
    const f = fixture(true);
    dragEvent(f.canvas, 'pointerdown', 150, 100);
    if (kind === 'controller')
      f.set({
        ...f.context,
        controller: { ...f.context.controller, controllerId: 'input_controller_reference_002' },
      });
    if (kind === 'binding') {
      const successor = { ...binding, epoch: 1, inputGeneration: 1 };
      f.set({
        ...f.context,
        controller: { ...f.context.controller, binding: successor },
        viewer: { ...f.context.viewer, binding: successor },
        presentation: {
          ...f.context.presentation,
          frame: { ...f.context.presentation.frame, binding: successor },
        },
        receipt: { ...f.context.receipt, binding: successor },
      });
    }
    if (kind === 'geometry')
      vi.mocked(f.canvas.getBoundingClientRect).mockReturnValue({
        left: 100,
        top: 50,
        width: 320,
        height: 180,
      } as DOMRect);
    dragEvent(f.canvas, 'pointerup', 150, 100, { shiftKey: kind === 'modifiers' });
    f.canvas.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 150, clientY: 100, detail: 1 })
    );
    expect(f.port.inputBrowser).not.toHaveBeenCalled();
    expect(f.captured.size).toBe(0);
  }
);
it('stationary original capture release reentrancy cannot publish a successor click', () => {
  const f = fixture(true);
  f.releasePointer.mockImplementationOnce((id) => {
    f.captured.delete(id);
    f.set({
      ...f.context,
      controller: { ...f.context.controller, controllerId: 'input_controller_reference_002' },
    });
  });
  dragEvent(f.canvas, 'pointerdown', 150, 100);
  dragEvent(f.canvas, 'pointerup', 150, 100);
  f.canvas.dispatchEvent(
    new MouseEvent('click', { bubbles: true, clientX: 150, clientY: 100, detail: 1 })
  );
  expect(f.port.inputBrowser).not.toHaveBeenCalled();
});

it.each([false, true])(
  'pre-pointerup contextmenu submits one secondary click and prevents the host menu (Control=%s)',
  async (ctrlKey) => {
    const f = fixture(true),
      button = ctrlKey ? 0 : 2;
    dragEvent(f.canvas, 'pointerdown', 150, 100, { ctrlKey, button, buttons: ctrlKey ? 1 : 2 });
    const menu = new MouseEvent('contextmenu', {
      detail: 0,
      bubbles: true,
      cancelable: true,
      clientX: 150,
      clientY: 100,
      button,
      ctrlKey,
    });
    f.canvas.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    dragEvent(f.canvas, 'pointerup', 150, 100, { ctrlKey, button });
    f.canvas.dispatchEvent(
      new MouseEvent('auxclick', {
        detail: 1,
        bubbles: true,
        clientX: 150,
        clientY: 100,
        button: 2,
      })
    );
    f.canvas.dispatchEvent(
      new MouseEvent('click', { detail: 1, bubbles: true, clientX: 150, clientY: 100, button: 0 })
    );
    await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(1));
    expect(vi.mocked(f.port.inputBrowser).mock.calls[0][0].steps).toEqual([
      { kind: 'click', x: 100, y: 100, button: 'right' },
    ]);
    expect(f.captured.size).toBe(0);
  }
);
it('an early contextmenu during a moved right drag prevents the host menu without duplicating remote actions', async () => {
  const f = fixture(true);
  dragEvent(f.canvas, 'pointerdown', 150, 100, { button: 2, buttons: 2 });
  dragEvent(f.canvas, 'pointermove', 200, 120, { button: 2, buttons: 2 });
  const menu = new MouseEvent('contextmenu', {
    detail: 0,
    bubbles: true,
    cancelable: true,
    clientX: 200,
    clientY: 120,
    button: 2,
  });
  f.canvas.dispatchEvent(menu);
  expect(menu.defaultPrevented).toBe(true);
  expect(f.port.inputBrowser).not.toHaveBeenCalled();
  dragEvent(f.canvas, 'pointerup', 250, 150, { button: 2 });
  f.canvas.dispatchEvent(
    new MouseEvent('auxclick', { detail: 1, bubbles: true, clientX: 250, clientY: 150, button: 2 })
  );
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(1));
  expect(
    vi
      .mocked(f.port.inputBrowser)
      .mock.calls[0][0].steps.filter((step) => step.kind === 'mouseDown' || step.kind === 'mouseUp')
  ).toEqual([
    { kind: 'mouseDown', button: 'right' },
    { kind: 'mouseUp', button: 'right' },
  ]);
});
it('early stationary contextmenu cannot cross changed controller ownership', () => {
  const f = fixture(true);
  dragEvent(f.canvas, 'pointerdown', 150, 100, { button: 2, buttons: 2 });
  f.set({
    ...f.context,
    controller: { ...f.context.controller, controllerId: 'input_controller_reference_002' },
  });
  const menu = new MouseEvent('contextmenu', {
    detail: 0,
    bubbles: true,
    cancelable: true,
    clientX: 150,
    clientY: 100,
    button: 2,
  });
  f.canvas.dispatchEvent(menu);
  dragEvent(f.canvas, 'pointerup', 150, 100, { button: 2 });
  f.canvas.dispatchEvent(
    new MouseEvent('auxclick', { detail: 1, bubbles: true, clientX: 150, clientY: 100, button: 2 })
  );
  expect(menu.defaultPrevented).toBe(true);
  expect(f.port.inputBrowser).not.toHaveBeenCalled();
});

it('stationary compatibility click cannot cross a controller replacement after pointerup', () => {
  const f = fixture(true);
  dragEvent(f.canvas, 'pointerdown', 150, 100);
  dragEvent(f.canvas, 'pointerup', 150, 100);
  f.set({
    ...f.context,
    controller: { ...f.context.controller, controllerId: 'input_controller_reference_002' },
  });
  f.canvas.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: 150,
      clientY: 100,
      detail: 1,
    })
  );
  expect(f.port.inputBrowser).not.toHaveBeenCalled();
});
it('ignored nonprimary pointerdown cannot clear the original stationary click admission', () => {
  const f = fixture(true);
  dragEvent(f.canvas, 'pointerdown', 150, 100);
  dragEvent(f.canvas, 'pointerup', 150, 100);
  const ignored = new MouseEvent('pointerdown', { bubbles: true, clientX: 150, clientY: 100 });
  Object.defineProperties(ignored, {
    pointerId: { value: 8 },
    pointerType: { value: 'touch' },
    isPrimary: { value: false },
  });
  f.canvas.dispatchEvent(ignored);
  f.set({
    ...f.context,
    controller: { ...f.context.controller, controllerId: 'input_controller_reference_002' },
  });
  f.canvas.dispatchEvent(
    new MouseEvent('click', { bubbles: true, clientX: 150, clientY: 100, detail: 1 })
  );
  expect(f.port.inputBrowser).not.toHaveBeenCalled();
});
it('zero-detail programmatic click keeps current-context semantics independently of an old stationary gesture', async () => {
  const f = fixture(true);
  dragEvent(f.canvas, 'pointerdown', 150, 100);
  dragEvent(f.canvas, 'pointerup', 150, 100);
  f.set({
    ...f.context,
    controller: { ...f.context.controller, controllerId: 'input_controller_reference_002' },
  });
  f.canvas.dispatchEvent(
    new MouseEvent('click', { bubbles: true, clientX: 150, clientY: 100, detail: 0 })
  );
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(1));
  expect(vi.mocked(f.port.inputBrowser).mock.calls[0][1]).toBe('input_controller_reference_002');
});

it.each([
  ['contextmenu', 'auxclick'],
  ['auxclick', 'contextmenu'],
] as const)('post-up secondary events %s→%s submit exactly once', async (first, second) => {
  const f = fixture(true);
  dragEvent(f.canvas, 'pointerdown', 150, 100, { button: 2, buttons: 2 });
  dragEvent(f.canvas, 'pointerup', 150, 100, { button: 2 });
  for (const type of [first, second])
    f.canvas.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: 150,
        clientY: 100,
        button: 2,
        detail: type === 'auxclick' ? 1 : 0,
      })
    );
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(1));
  expect(vi.mocked(f.port.inputBrowser).mock.calls[0][0].steps).toEqual([
    { kind: 'click', x: 100, y: 100, button: 'right' },
  ]);
});
it('a genuine new pointerdown admits a second click rather than swallowing double-click gestures', async () => {
  const f = fixture(true);
  for (let n = 0; n < 2; n++) {
    dragEvent(f.canvas, 'pointerdown', 150, 100);
    dragEvent(f.canvas, 'pointerup', 150, 100);
    f.canvas.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 150, clientY: 100, detail: n + 1 })
    );
    await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(n + 1));
  }
});

it('zero-detail programmatic click is not swallowed by a completed drag compatibility-click fence', async () => {
  const f = fixture(true);
  dragEvent(f.canvas, 'pointerdown', 150, 100);
  dragEvent(f.canvas, 'pointermove', 250, 150);
  dragEvent(f.canvas, 'pointerup', 250, 150);
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(1));
  f.canvas.dispatchEvent(
    new MouseEvent('click', { bubbles: true, clientX: 250, clientY: 150, detail: 0 })
  );
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(2));
  expect(vi.mocked(f.port.inputBrowser).mock.calls[1][0].steps).toEqual([
    { kind: 'click', x: 300, y: 200, button: 'left' },
  ]);
});

// DOM controls exercise the owned event receiver and queue; these are not OS IME acceptance.
it('preserves UTF-16 preedit selection and commits once through the original input queue', async () => {
  const f = fixture();
  f.canvas.focus();
  const ime = document.activeElement as HTMLTextAreaElement;
  expect(ime.tagName).toBe('TEXTAREA');
  expect(ime.style.left).toBe('100px');
  ime.dispatchEvent(new CompositionEvent('compositionstart'));
  ime.value = '😀中';
  ime.setSelectionRange(2, 3);
  ime.dispatchEvent(new InputEvent('input', { isComposing: true }));
  ime.dispatchEvent(new KeyboardEvent('keydown', { key: '中', isComposing: true }));
  ime.dispatchEvent(new CompositionEvent('compositionend', { data: '😀中' }));
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(2));
  const calls = vi.mocked(f.port.inputBrowser).mock.calls;
  expect(calls.map(([request]) => request.steps)).toEqual([
    [{ kind: 'composition', text: '😀中', selectionStart: 2, selectionEnd: 3 }],
    [{ kind: 'compositionCommit', text: '😀中' }],
  ]);
  expect(ime.value).toBe('');
  await f.adapter.close();
  expect(ime.isConnected).toBe(false);
});
it('blur cancels preedit through the original queue and clears local plaintext', async () => {
  const f = fixture();
  f.canvas.focus();
  const ime = document.activeElement as HTMLTextAreaElement;
  ime.dispatchEvent(new CompositionEvent('compositionstart'));
  ime.value = '中文';
  ime.setSelectionRange(2, 2);
  ime.dispatchEvent(new InputEvent('input', { isComposing: true }));
  ime.blur();
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(2));
  expect(vi.mocked(f.port.inputBrowser).mock.calls[1][0].steps).toEqual([
    { kind: 'composition', text: '', selectionStart: 0, selectionEnd: 0 },
  ]);
  expect(ime.value).toBe('');
});
it('does not commit a preedit into a replacement controller lifetime', async () => {
  const f = fixture();
  f.canvas.focus();
  const ime = document.activeElement as HTMLTextAreaElement;
  ime.dispatchEvent(new CompositionEvent('compositionstart'));
  f.set({
    ...f.context,
    controller: { ...f.context.controller, controllerId: 'replacement_controller_00001' },
  });
  ime.dispatchEvent(new CompositionEvent('compositionend', { data: '中文' }));
  await Promise.resolve();
  expect(f.port.inputBrowser).not.toHaveBeenCalled();
  expect(ime.value).toBe('');
});

// Event-controlled editable receiver tests; physical phone keyboard and OS clipboard UX are unrun.
it('accepts virtual-keyboard beforeinput text and balanced delete without keydown', async () => {
  const f = fixture();
  f.canvas.focus();
  const ime = document.activeElement as HTMLTextAreaElement;
  const inserted = new InputEvent('beforeinput', {
    inputType: 'insertText',
    data: 'mobile',
    cancelable: true,
  });
  ime.dispatchEvent(inserted);
  expect(inserted.defaultPrevented).toBe(true);
  const deleted = new InputEvent('beforeinput', {
    inputType: 'deleteContentBackward',
    cancelable: true,
  });
  ime.dispatchEvent(deleted);
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(2));
  expect(vi.mocked(f.port.inputBrowser).mock.calls.map(([request]) => request.steps)).toEqual([
    [{ kind: 'text', text: 'mobile' }],
    [
      { kind: 'keyDown', key: 'Backspace' },
      { kind: 'keyUp', key: 'Backspace' },
    ],
  ]);
  expect(ime.value).toBe('');
});
it('captures the pre-mutation lifetime for noncancelable edits and clears the original local proxy', async () => {
  const f = fixture();
  f.canvas.focus();
  const ime = document.activeElement as HTMLTextAreaElement;
  ime.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: '中文' }));
  ime.value = '中文';
  ime.setSelectionRange(2, 2);
  ime.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: null }));
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(1));
  expect(vi.mocked(f.port.inputBrowser).mock.calls[0][0].steps).toEqual([
    { kind: 'text', text: '中文' },
  ]);
  expect(ime.value).toBe('');
  ime.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'late' }));
  f.set({
    ...f.context,
    controller: { ...f.context.controller, controllerId: 'replacement_controller_00001' },
  });
  ime.value = 'late';
  ime.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'late' }));
  await Promise.resolve();
  expect(f.port.inputBrowser).toHaveBeenCalledTimes(1);
  expect(ime.value).toBe('');
});
it('accepts ordinary input-only insertion once while preserving original focus authority', async () => {
  const f = fixture();
  f.canvas.focus();
  const ime = document.activeElement as HTMLTextAreaElement;
  ime.value = 'phone';
  ime.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'phone' }));
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(1));
  expect(vi.mocked(f.port.inputBrowser).mock.calls[0][0].steps).toEqual([
    { kind: 'text', text: 'phone' },
  ]);
  expect(ime.value).toBe('');
});
it('reads only the actual user paste event plain text and preserves native paste key chords', async () => {
  const f = fixture();
  f.canvas.focus();
  const ime = document.activeElement as HTMLTextAreaElement;
  const chord = new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, cancelable: true });
  ime.dispatchEvent(chord);
  expect(chord.defaultPrevented).toBe(false);
  const getData = vi.fn(() => 'pasted text');
  const paste = new Event('paste', { cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { getData } });
  ime.dispatchEvent(paste);
  expect(getData).toHaveBeenCalledExactlyOnceWith('text/plain');
  expect(paste.defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(1));
  expect(vi.mocked(f.port.inputBrowser).mock.calls[0][0].steps).toEqual([
    { kind: 'text', text: 'pasted text' },
  ]);
});
it('refuses clipboard getter reentrant controller replacement before original producer admission', async () => {
  const f = fixture();
  f.canvas.focus();
  const ime = document.activeElement as HTMLTextAreaElement;
  const paste = new Event('paste', { cancelable: true });
  Object.defineProperty(paste, 'clipboardData', {
    value: {
      getData: () => {
        f.set({
          ...f.context,
          controller: { ...f.context.controller, controllerId: 'replacement_controller_00001' },
        });
        return 'wrong lifetime';
      },
    },
  });
  ime.dispatchEvent(paste);
  await Promise.resolve();
  expect(f.port.inputBrowser).not.toHaveBeenCalled();
});
it('consumes the original composition tail once and admits a later ordinary edit', async () => {
  const f = fixture();
  f.canvas.focus();
  const ime = document.activeElement as HTMLTextAreaElement;
  ime.dispatchEvent(new CompositionEvent('compositionstart'));
  ime.value = '中';
  ime.setSelectionRange(1, 1);
  ime.dispatchEvent(
    new InputEvent('input', { inputType: 'insertCompositionText', data: '中', isComposing: true })
  );
  ime.dispatchEvent(new CompositionEvent('compositionend', { data: '中' }));
  ime.value = '中';
  ime.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: '中' }));
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(2));
  expect(ime.value).toBe('');
  ime.dispatchEvent(
    new InputEvent('beforeinput', { inputType: 'insertText', data: '中', cancelable: true })
  );
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(3));
  expect(vi.mocked(f.port.inputBrowser).mock.calls[2][0].steps).toEqual([
    { kind: 'text', text: '中' },
  ]);
});
it('refuses local replacement/autocorrection instead of guessing a remote text range', async () => {
  const f = fixture();
  f.canvas.focus();
  const ime = document.activeElement as HTMLTextAreaElement;
  const replace = new InputEvent('beforeinput', {
    inputType: 'insertReplacementText',
    data: 'guess',
    cancelable: true,
  });
  ime.dispatchEvent(replace);
  expect(replace.defaultPrevented).toBe(true);
  expect(f.port.inputBrowser).not.toHaveBeenCalled();
});

it('consumes both phases of a noncancelable composition tail without repeating the commit', async () => {
  const f = fixture();
  f.canvas.focus();
  const ime = document.activeElement as HTMLTextAreaElement;
  ime.dispatchEvent(new CompositionEvent('compositionstart'));
  ime.dispatchEvent(new CompositionEvent('compositionend', { data: '中' }));
  ime.dispatchEvent(
    new InputEvent('beforeinput', { inputType: 'insertCompositionText', data: '中' })
  );
  ime.value = '中';
  ime.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: '中' }));
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(1));
  expect(vi.mocked(f.port.inputBrowser).mock.calls[0][0].steps).toEqual([
    { kind: 'compositionCommit', text: '中' },
  ]);
  expect(ime.value).toBe('');
});
it.each(['preedit', 'commit'])(
  'cancels acknowledged native preedit after malformed %s on the same original authority',
  async (phase) => {
    const f = fixture();
    f.canvas.focus();
    const ime = document.activeElement as HTMLTextAreaElement;
    ime.dispatchEvent(new CompositionEvent('compositionstart'));
    ime.value = '中';
    ime.setSelectionRange(1, 1);
    ime.dispatchEvent(new InputEvent('input', { isComposing: true }));
    await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(1));
    if (phase === 'preedit') {
      ime.value = '中'.repeat(683);
      ime.setSelectionRange(683, 683);
      ime.dispatchEvent(new InputEvent('input', { isComposing: true }));
    } else ime.dispatchEvent(new CompositionEvent('compositionend', { data: '中'.repeat(683) }));
    await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(2));
    expect(vi.mocked(f.port.inputBrowser).mock.calls[1][0].steps).toEqual([
      { kind: 'composition', text: '', selectionStart: 0, selectionEnd: 0 },
    ]);
    expect(ime.value).toBe('');
  }
);

it('retains falsy local clearing failure while removing the receiver, aborting and joining original input', async () => {
  const f = fixture();
  f.canvas.focus();
  f.accept(false);
  const ime = document.activeElement as HTMLTextAreaElement;
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  f.releases.push(release);
  vi.mocked(f.port.inputBrowser).mockImplementationOnce(async (_command, _controller, signal) => {
    await held;
    signal.throwIfAborted();
    throw new Error('original abort required');
  });
  ime.dispatchEvent(
    new InputEvent('beforeinput', { inputType: 'insertText', data: 'owned', cancelable: true })
  );
  await vi.waitFor(() => expect(f.port.inputBrowser).toHaveBeenCalledTimes(1));
  Object.defineProperty(ime, 'value', {
    set: () => {
      throw false;
    },
  });
  const original = f.adapter.close();
  let returned = false;
  void original.then(
    () => {
      returned = true;
    },
    () => {
      returned = true;
    }
  );
  expect(ime.isConnected).toBe(false);
  expect(vi.mocked(f.port.inputBrowser).mock.calls[0][2].aborted).toBe(true);
  await Promise.resolve();
  expect(returned).toBe(false);
  release();
  await expect(original).rejects.toBe(false);
  expect(f.port.inputBrowser).toHaveBeenCalledTimes(1);
});

it('keeps the owned candidate anchor inside the viewport when the canvas is partly clipped', () => {
  const f = fixture();
  vi.mocked(f.canvas.getBoundingClientRect).mockReturnValue({
    left: -50,
    top: -30,
    width: 640,
    height: 360,
  } as DOMRect);
  f.canvas.focus();
  const ime = document.activeElement as HTMLTextAreaElement;
  expect(ime.style.left).toBe('0px');
  expect(ime.style.top).toBe('0px');
  expect(f.port.inputBrowser).not.toHaveBeenCalled();
});
