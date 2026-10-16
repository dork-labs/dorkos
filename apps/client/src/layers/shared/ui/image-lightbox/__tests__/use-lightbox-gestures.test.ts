/**
 * The viewer's finger gestures, fed pointer events by hand: jsdom has no
 * touch screen, and what matters is which way a drag is read and what it asks.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { MotionValue } from 'motion/react';
import { useLightboxGestures, type LightboxGestureOptions } from '../use-lightbox-gestures';

/** A motion value that remembers what it was set to. */
function value(initial: number) {
  let current = initial;
  return {
    get: () => current,
    set: vi.fn((next: number) => {
      current = next;
    }),
  } as unknown as MotionValue<number> & { set: ReturnType<typeof vi.fn> };
}

function setup(overrides: Partial<LightboxGestureOptions> = {}) {
  const options = {
    x: value(0),
    y: value(0),
    scale: value(1),
    backdrop: value(1),
    canGesture: () => true,
    canStep: () => true,
    onDismiss: vi.fn(),
    onStep: vi.fn(),
    ...overrides,
  };
  const { result } = renderHook(() => useLightboxGestures(options));
  return { options, result };
}

let clock = 0;
/** A pointer event as React hands one over; time moves 100ms per event. */
function pointer(type: string, x: number, y: number, extra: Partial<PointerEvent> = {}) {
  clock += 100;
  return {
    type,
    pointerId: 1,
    pointerType: 'touch',
    clientX: x,
    clientY: y,
    timeStamp: clock,
    ...extra,
  } as unknown as React.PointerEvent<HTMLElement>;
}

/** Drag one finger from one point to another in a few steps. */
function drag(
  handlers: ReturnType<typeof useLightboxGestures>['handlers'],
  from: [number, number],
  to: [number, number]
) {
  act(() => {
    handlers.onPointerDown(pointer('pointerdown', ...from));
    for (let i = 1; i <= 4; i += 1) {
      const x = from[0] + ((to[0] - from[0]) * i) / 4;
      const y = from[1] + ((to[1] - from[1]) * i) / 4;
      handlers.onPointerMove(pointer('pointermove', x, y));
    }
    handlers.onPointerUp(pointer('pointerup', ...to));
  });
}

describe('useLightboxGestures', () => {
  it('closes on a long drag down, moving the picture with the finger', () => {
    const { options, result } = setup();

    drag(result.current.handlers, [100, 100], [104, 300]);

    expect(options.y.set).toHaveBeenCalledWith(200);
    expect(options.onDismiss).toHaveBeenCalledTimes(1);
    expect(options.onStep).not.toHaveBeenCalled();
  });

  it('settles back from a short, slow drag down', () => {
    const { options, result } = setup();

    drag(result.current.handlers, [100, 100], [100, 140]);

    expect(options.onDismiss).not.toHaveBeenCalled();
  });

  it('steps to the next picture on a drag left, and the previous on a drag right', () => {
    const { options, result } = setup();

    drag(result.current.handlers, [300, 100], [100, 104]);
    drag(result.current.handlers, [100, 100], [300, 96]);

    expect(options.onStep).toHaveBeenNthCalledWith(1, 1);
    expect(options.onStep).toHaveBeenNthCalledWith(2, -1);
    expect(options.onDismiss).not.toHaveBeenCalled();
  });

  it('only gives a little past the last picture, and does not step', () => {
    const { options, result } = setup({ canStep: () => false });

    drag(result.current.handlers, [300, 100], [100, 100]);

    expect(options.x.set).toHaveBeenLastCalledWith(-50);
    expect(options.onStep).not.toHaveBeenCalled();
  });

  it('leaves a second finger to the pinch', () => {
    const { options, result } = setup();
    const { handlers } = result.current;

    act(() => {
      handlers.onPointerDown(pointer('pointerdown', 100, 100));
      handlers.onPointerMove(pointer('pointermove', 100, 200));
      handlers.onPointerDown(pointer('pointerdown', 200, 200, { pointerId: 2 }));
      handlers.onPointerMove(pointer('pointermove', 100, 400));
      handlers.onPointerUp(pointer('pointerup', 100, 400));
    });

    expect(options.onDismiss).not.toHaveBeenCalled();
  });

  it('never starts from a mouse, and not while zoomed in', () => {
    const mouse = setup();
    act(() => {
      const { handlers } = mouse.result.current;
      handlers.onPointerDown(pointer('pointerdown', 100, 100, { pointerType: 'mouse' }));
      handlers.onPointerMove(pointer('pointermove', 100, 400, { pointerType: 'mouse' }));
      handlers.onPointerUp(pointer('pointerup', 100, 400, { pointerType: 'mouse' }));
    });
    expect(mouse.options.onDismiss).not.toHaveBeenCalled();

    const zoomed = setup({ canGesture: () => false });
    drag(zoomed.result.current.handlers, [100, 100], [100, 400]);
    expect(zoomed.options.onDismiss).not.toHaveBeenCalled();
  });

  it('marks the click that ends a drag, and not a tap', () => {
    const { result } = setup();

    drag(result.current.handlers, [100, 100], [100, 140]);
    expect(result.current.endedDrag()).toBe(true);

    act(() => {
      result.current.handlers.onPointerDown(pointer('pointerdown', 100, 100));
      result.current.handlers.onPointerUp(pointer('pointerup', 101, 101));
    });
    expect(result.current.endedDrag()).toBe(false);
  });
});
