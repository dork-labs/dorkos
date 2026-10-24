/**
 * The phone's thread sheet: what a swipe has to be to close it, and that it
 * cuts rather than slides for a reader who asked for less motion.
 *
 * jsdom has no pointer geometry, so the swipe itself is a browser concern
 * (`apps/e2e/tests/rooms/threads/phone-thread-sheet.spec.ts`); what is pinned here is
 * the rule it is judged by and the transition it is handed.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const motionProps = vi.hoisted(() => ({ last: {} as Record<string, unknown> }));
const reduced = vi.hoisted(() => ({ on: false }));

vi.mock('motion/react', () => ({
  useReducedMotion: () => reduced.on,
  motion: {
    div: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => {
      motionProps.last = props;
      return <div data-testid={props['data-testid'] as string}>{children}</div>;
    },
  },
}));

import {
  RoomThreadSheet,
  SHEET_SWIPE_CLOSE_DISTANCE,
  SHEET_SWIPE_CLOSE_VELOCITY,
  swipeCloses,
} from '../ui/RoomThreadSheet';

afterEach(() => {
  cleanup();
  reduced.on = false;
});

describe('swipeCloses', () => {
  it('closes on a swipe that travels far enough to the right', () => {
    expect(
      swipeCloses({ offset: { x: SHEET_SWIPE_CLOSE_DISTANCE + 1, y: 0 }, velocity: { x: 0, y: 0 } })
    ).toBe(true);
  });

  it('closes on a quick flick, however short', () => {
    expect(
      swipeCloses({
        offset: { x: 20, y: 0 },
        velocity: { x: SHEET_SWIPE_CLOSE_VELOCITY + 1, y: 0 },
      })
    ).toBe(true);
  });

  it('springs back from a slow drag that stops short, or one to the left', () => {
    expect(swipeCloses({ offset: { x: 40, y: 0 }, velocity: { x: 50, y: 0 } })).toBe(false);
    expect(swipeCloses({ offset: { x: -200, y: 0 }, velocity: { x: -900, y: 0 } })).toBe(false);
  });
});

describe('RoomThreadSheet', () => {
  it('draws the thread, slides in from the right, and drags only rightward', () => {
    render(
      <RoomThreadSheet onClose={() => {}}>
        <p>the thread</p>
      </RoomThreadSheet>
    );
    expect(screen.getByTestId('room-thread-sheet')).toHaveTextContent('the thread');
    expect(motionProps.last.initial).toEqual({ x: '100%' });
    expect(motionProps.last.exit).toEqual({ x: '100%' });
    expect(motionProps.last.drag).toBe('x');
    expect(motionProps.last.dragDirectionLock).toBe(true);
    expect(motionProps.last.dragElastic).toEqual({ left: 0, right: 0.9 });
  });

  it('closes when a swipe is released past the line', () => {
    const onClose = vi.fn();
    render(
      <RoomThreadSheet onClose={onClose}>
        <p>the thread</p>
      </RoomThreadSheet>
    );
    const onDragEnd = motionProps.last.onDragEnd as (event: unknown, info: unknown) => void;
    onDragEnd(null, { offset: { x: 10, y: 0 }, velocity: { x: 0, y: 0 } });
    expect(onClose).not.toHaveBeenCalled();
    onDragEnd(null, { offset: { x: 300, y: 0 }, velocity: { x: 0, y: 0 } });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('cuts rather than slides under a reduced-motion preference', () => {
    reduced.on = true;
    render(
      <RoomThreadSheet onClose={() => {}}>
        <p>the thread</p>
      </RoomThreadSheet>
    );
    expect(motionProps.last.initial).toEqual({ x: 0 });
    expect(motionProps.last.exit).toEqual({ x: 0 });
    expect(motionProps.last.transition).toEqual({ duration: 0 });
  });
});
