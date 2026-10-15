/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import type {
  ClientRect,
  CollisionDetection,
  DroppableContainer,
  KeyboardCoordinateGetter,
} from '@dnd-kit/core';
import { enterDesktopShell, leaveDesktopShell } from '@/test-helpers/desktop-shell';
import { tabLinkUrl } from '../lib/tab-link';
import {
  TAB_DRAG_INSTRUCTIONS,
  buildTabAnnouncements,
  clampToSide,
  reorderIndices,
  sameSideCollision,
  sameSideKeyboardCoordinates,
  sideBounds,
} from '../lib/tab-reorder';

afterEach(leaveDesktopShell);

describe('tabLinkUrl', () => {
  it('in a browser, is this origin plus the tab location', () => {
    expect(tabLinkUrl('/session?session=abc')).toBe(
      `${window.location.origin}/session?session=abc`
    );
    expect(tabLinkUrl('/')).toBe(`${window.location.origin}/`);
  });

  it('in the desktop app, is a dorkos:// link that survives a restart', () => {
    enterDesktopShell();
    expect(tabLinkUrl('/session?session=abc&dir=%2Ftmp')).toBe(
      'dorkos://session?session=abc&dir=%2Ftmp'
    );
    expect(tabLinkUrl('/channels?id=room-1')).toBe('dorkos://channels?id=room-1');
  });

  it('in the desktop app, falls back to the origin for the dashboard, which a deep link cannot name', () => {
    enterDesktopShell();
    expect(tabLinkUrl('/')).toBe(`${window.location.origin}/`);
    expect(tabLinkUrl('/?settings=open')).toBe(`${window.location.origin}/?settings=open`);
  });
});

/** A one-row rect at `left`, 100px wide. */
function rect(left: number): ClientRect {
  return { left, right: left + 100, top: 0, bottom: 30, width: 100, height: 30 };
}

describe('sameSideCollision', () => {
  const pinned = new Set(['p1', 'p2']);
  const detect: CollisionDetection = sameSideCollision((id) => pinned.has(id));
  const rects = new Map([
    ['p1', rect(0)],
    ['p2', rect(100)],
    ['a', rect(200)],
    ['b', rect(300)],
  ]);
  const containers = [...rects.keys()].map((id) => ({ id }) as unknown as DroppableContainer);

  const over = (activeId: string, at: number) =>
    detect({
      active: { id: activeId } as never,
      collisionRect: rect(at),
      droppableRects: rects as never,
      droppableContainers: containers,
      pointerCoordinates: null,
    })[0]?.id;

  it('never offers an unpinned tab a place among pinned ones', () => {
    expect(over('b', 0)).toBe('a');
  });

  it('never offers a pinned tab a place among unpinned ones', () => {
    expect(over('p1', 300)).toBe('p2');
  });

  it('offers the nearest place on the tab’s own side', () => {
    expect(over('a', 300)).toBe('b');
    expect(over('p2', 0)).toBe('p1');
  });
});

describe('buildTabAnnouncements', () => {
  const names: Record<string, string> = { a: 'Activity', b: 'Schedules' };
  const order = ['a', 'b'];
  const say = buildTabAnnouncements({
    nameOf: (id) => names[id],
    indexOf: (id) => order.indexOf(id),
    count: () => order.length,
  });
  const active = { id: 'a' } as never;
  const overB = { id: 'b' } as never;

  it('speaks each step in plain words', () => {
    expect(say.onDragStart({ active })).toBe('Picked up Activity.');
    expect(say.onDragOver({ active, over: overB } as never)).toBe(
      'Activity is over position 2 of 2.'
    );
    expect(say.onDragEnd({ active, over: overB } as never)).toBe(
      'Activity dropped at position 2 of 2.'
    );
    expect(say.onDragEnd({ active, over: null } as never)).toBe('Activity put back.');
    expect(say.onDragCancel({ active, over: null } as never)).toBe(
      'Move cancelled. Activity put back.'
    );
  });
});

describe('sameSideKeyboardCoordinates', () => {
  const pinned = new Set(['p1', 'p2']);
  const getter: KeyboardCoordinateGetter = sameSideKeyboardCoordinates((id) => pinned.has(id));
  const rects = new Map([
    ['p1', rect(0)],
    ['p2', rect(100)],
    ['a', rect(200)],
    ['b', rect(300)],
  ]);
  /** A container map shaped like dnd-kit's: a Map with `getEnabled` and `toArray`. */
  function containers() {
    const map = new Map<string, DroppableContainer>();
    for (const id of rects.keys()) {
      const node = document.createElement('div');
      map.set(id, { id, disabled: false, node: { current: node }, data: { current: {} } } as never);
    }
    return Object.assign(map, {
      getEnabled: () => [...map.values()],
      toArray: () => [...map.values()],
    });
  }
  const step = (activeId: string, key: string) =>
    getter(new KeyboardEvent('keydown', { code: key }), {
      active: activeId,
      currentCoordinates: { x: rects.get(activeId)!.left, y: 0 },
      context: {
        active: { id: activeId },
        collisionRect: rects.get(activeId),
        droppableRects: rects,
        droppableContainers: containers(),
        over: null,
        scrollableAncestors: [],
      } as never,
    });

  it('will not step the first unpinned tab left into the pinned ones', () => {
    // The repro: [p1*][p2*][a][b], lift a, press ArrowLeft.
    expect(step('a', 'ArrowLeft')).toBeUndefined();
  });

  it('still steps within its own side', () => {
    expect(step('a', 'ArrowRight')).toMatchObject({ x: 300 });
    expect(step('p2', 'ArrowLeft')).toMatchObject({ x: 0 });
  });

  it('will not step the last pinned tab right into the unpinned ones', () => {
    expect(step('p2', 'ArrowRight')).toBeUndefined();
  });
});

describe('clampToSide', () => {
  const bounds = sideBounds([rect(200), rect(300)]);
  const clamp = clampToSide(() => bounds);
  const move = (x: number, from = rect(300)) =>
    clamp({ transform: { x, y: 0, scaleX: 1, scaleY: 1 }, activeNodeRect: from } as never).x;

  it('measures the span of one side', () => {
    expect(bounds).toEqual({ left: 200, right: 400 });
    expect(sideBounds([])).toBeNull();
  });

  it('holds the dragged tab inside its side', () => {
    expect(move(-250)).toBe(-100); // would cross into the pinned tabs
    expect(move(80)).toBe(0); // past the last tab
    expect(move(-40)).toBe(-40); // a move inside the side is untouched
  });

  it('leaves the transform alone with no span measured', () => {
    const free = clampToSide(() => null);
    expect(
      free({ transform: { x: -999, y: 0, scaleX: 1, scaleY: 1 }, activeNodeRect: rect(0) } as never)
        .x
    ).toBe(-999);
  });
});

describe('reorderIndices', () => {
  const ids = ['p', 'a', 'b', 'c'];

  it('maps a finished drag to the from and to positions', () => {
    expect(reorderIndices(ids, 'a', 'b')).toEqual([1, 2]);
    expect(reorderIndices(ids, 'c', 'a')).toEqual([3, 1]);
  });

  it('is null for a drop on nothing, on itself, or on a tab that is gone', () => {
    expect(reorderIndices(ids, 'a', null)).toBeNull();
    expect(reorderIndices(ids, 'a', undefined)).toBeNull();
    expect(reorderIndices(ids, 'a', 'a')).toBeNull();
    expect(reorderIndices(ids, 'a', 'gone')).toBeNull();
  });
});

describe('TAB_DRAG_INSTRUCTIONS', () => {
  it('stays inside the 15-word cap for app copy', () => {
    expect(TAB_DRAG_INSTRUCTIONS.draggable.split(/\s+/).length).toBeLessThanOrEqual(15);
  });
});
