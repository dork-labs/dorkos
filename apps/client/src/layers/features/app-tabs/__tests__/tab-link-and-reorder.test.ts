/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { ClientRect, CollisionDetection, DroppableContainer } from '@dnd-kit/core';
import { enterDesktopShell, leaveDesktopShell } from '@/test-helpers/desktop-shell';
import { tabLinkUrl } from '../lib/tab-link';
import { buildTabAnnouncements, sameSideCollision } from '../lib/tab-reorder';

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
