/**
 * The viewer's touch gestures: drag down to close, drag sideways for the next
 * or previous picture.
 *
 * Pointer events, one finger only. A second finger is a pinch, which belongs to
 * the zoom surface, so it cancels whatever this hook had started and puts the
 * picture back. A mouse never starts a gesture: on a desktop, dragging is for
 * panning a zoomed picture, and a click outside it is how you close.
 *
 * @module shared/ui/image-lightbox/use-lightbox-gestures
 */
import { useLayoutEffect, useRef, type PointerEvent } from 'react';
import { animate, type MotionValue } from 'motion/react';

/** How far a finger moves before the hook decides which way it is going. */
const AXIS_LOCK_PX = 8;
/** How far down a drag must travel to close, absent a flick. */
const DISMISS_PX = 110;
/** How far sideways a drag must travel to change picture, absent a flick. */
const SWIPE_PX = 70;
/** A flick: px per ms past which a short drag still counts. */
const FLICK_VELOCITY = 0.5;
/** Any pointer moving this far is a drag, so the click it ends in is not a click. */
const CLICK_SLOP_PX = 6;

/** The spring a cancelled drag settles back with. */
export const SETTLE = { type: 'spring', stiffness: 520, damping: 42 } as const;

/** What the gestures move, and what they ask the viewer to do. */
export interface LightboxGestureOptions {
  /** The picture's offset and size, shared with the open and close animations. */
  x: MotionValue<number>;
  y: MotionValue<number>;
  scale: MotionValue<number>;
  /** The backdrop, 1 when fully drawn; a drag down lets the page show through. */
  backdrop: MotionValue<number>;
  /** Whether a gesture may start now: not while zoomed in, not mid-animation. */
  canGesture: () => boolean;
  /** Whether there is a picture in that direction (1 = next, -1 = previous). */
  canStep: (direction: 1 | -1) => boolean;
  /** The drag down went far enough: close. */
  onDismiss: () => void;
  /** The sideways drag went far enough: step that way. */
  onStep: (direction: 1 | -1) => void;
}

/** Where the one tracked finger started, and what it has turned out to be. */
interface Track {
  id: number;
  startX: number;
  startY: number;
  startTime: number;
  axis: 'x' | 'y' | null;
}

/**
 * Pointer handlers for the viewer's whole surface, plus a way to ask whether
 * the click that just arrived ended a drag.
 *
 * @param options - What the gestures move and what they call.
 */
export function useLightboxGestures(options: LightboxGestureOptions) {
  const opts = useRef(options);
  useLayoutEffect(() => {
    opts.current = options;
  });
  const pointers = useRef(new Set<number>());
  const track = useRef<Track | null>(null);
  const press = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);

  /** Put the picture back where it was, the drag abandoned. */
  const settle = () => {
    const { x, y, scale, backdrop } = opts.current;
    void animate(x, 0, SETTLE);
    void animate(y, 0, SETTLE);
    void animate(scale, 1, SETTLE);
    void animate(backdrop, 1, SETTLE);
  };

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    press.current = { x: event.clientX, y: event.clientY };
    dragged.current = false;
    if (event.pointerType === 'mouse') return;
    pointers.current.add(event.pointerId);
    if (pointers.current.size > 1) {
      // A second finger: this is a pinch, and the zoom surface owns it.
      if (track.current?.axis) settle();
      track.current = null;
      return;
    }
    track.current = opts.current.canGesture()
      ? {
          id: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          startTime: event.timeStamp,
          axis: null,
        }
      : null;
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (press.current) {
      const moved = Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y);
      if (moved > CLICK_SLOP_PX) dragged.current = true;
    }
    const t = track.current;
    if (!t || t.id !== event.pointerId) return;
    const dx = event.clientX - t.startX;
    const dy = event.clientY - t.startY;
    if (t.axis === null) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < AXIS_LOCK_PX) return;
      t.axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
    }
    const { x, y, scale, backdrop, canStep } = opts.current;
    if (t.axis === 'y') {
      const progress = Math.min(Math.abs(dy) / 320, 1);
      y.set(dy);
      scale.set(1 - progress * 0.12);
      backdrop.set(1 - progress * 0.7);
    } else {
      // Past the first or last picture the drag still moves, at a quarter of
      // the finger's speed, so the edge is felt rather than a dead stop.
      x.set(canStep(dx < 0 ? 1 : -1) ? dx : dx * 0.25);
    }
  };

  const onPointerEnd = (event: PointerEvent<HTMLElement>) => {
    pointers.current.delete(event.pointerId);
    const t = track.current;
    if (!t || t.id !== event.pointerId) return;
    track.current = null;
    if (t.axis === null) return;
    const elapsed = Math.max(event.timeStamp - t.startTime, 1);
    const { canStep, onDismiss, onStep } = opts.current;
    if (event.type === 'pointercancel') {
      settle();
      return;
    }
    if (t.axis === 'y') {
      const dy = event.clientY - t.startY;
      if (Math.abs(dy) > DISMISS_PX || Math.abs(dy) / elapsed > FLICK_VELOCITY) onDismiss();
      else settle();
      return;
    }
    const dx = event.clientX - t.startX;
    const direction = dx < 0 ? 1 : -1;
    const far = Math.abs(dx) > SWIPE_PX || Math.abs(dx) / elapsed > FLICK_VELOCITY;
    if (far && canStep(direction)) onStep(direction);
    else settle();
  };

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
    },
    /** Whether the click now arriving ended a drag, and so is not a click. */
    endedDrag: () => dragged.current,
  };
}
