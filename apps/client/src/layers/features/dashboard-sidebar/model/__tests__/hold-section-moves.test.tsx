// @vitest-environment jsdom
/**
 * Rows never move under the person using the panel (DOR-3092): while they are
 * in it, an agent drifting between a smart section and Direct messages stays
 * where it was, and the move lands when they leave.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { FocusEvent } from 'react';
import type { SidebarRowModel, SidebarSectionModel } from '../build-sidebar-model';
import { holdSectionMoves, membershipOf } from '../rules/hold-section-moves';
import { useHeldSections, useInside } from '../use-held-sections';

/** A row with `id`, carrying `count` as its unread count so in-place updates show. */
function row(id: string, count = 0): SidebarRowModel {
  const path = id.replace('agent:', '');
  return {
    key: id,
    target: id.startsWith('command:')
      ? { kind: 'command', commandId: 'message-someone' }
      : { kind: 'agent', path },
    glyph: { kind: 'agent-avatar', agentPath: path },
    primary: id,
    reservesVerbLine: false,
    unread: count > 0 ? { tier: 'directed', count } : { tier: 'none' },
    muted: false,
    draggable: true,
    reason: 'dms:agent',
  };
}

/** A section holding `rows`. */
function section(id: SidebarSectionModel['id'], rows: SidebarRowModel[]): SidebarSectionModel {
  return {
    id,
    label: String(id),
    collapsible: true,
    collapsed: false,
    rows,
    reason: 'section:dms',
  };
}

/** Each section's row ids, by section id. */
function idsOf(sections: readonly SidebarSectionModel[]): Record<string, string[]> {
  return Object.fromEntries(sections.map((s) => [s.id, s.rows.map((r) => r.key)]));
}

/** Ana is in "Active now"; Bo and Cy are in Direct messages. */
const BEFORE = [
  section('group:active', [row('agent:/ana')]),
  section('dms', [row('agent:/bo'), row('agent:/cy'), row('command:message-someone')]),
];
/** Ana stopped working (to Direct messages); Bo started (to "Active now"), with a count. */
const AFTER = [
  section('group:active', [row('agent:/bo', 3)]),
  section('dms', [row('agent:/ana'), row('agent:/cy'), row('command:message-someone')]),
];

describe('holdSectionMoves', () => {
  it('puts every moved row back where it was, wearing this frame’s data', () => {
    const held = holdSectionMoves(AFTER, membershipOf(BEFORE));
    expect(idsOf(held)).toEqual(idsOf(BEFORE));
    // Bo is still in Direct messages, and his new count still shows.
    const bo = held[1]!.rows.find((r) => r.primary === 'agent:/bo');
    expect(bo?.unread).toEqual({ tier: 'directed', count: 3 });
  });

  it('keeps a row this frame dropped, and lets a new one arrive', () => {
    const live = [
      section('group:active', [row('agent:/dee')]),
      section('dms', [row('agent:/bo'), row('agent:/cy'), row('command:message-someone')]),
    ];
    expect(idsOf(holdSectionMoves(live, membershipOf(BEFORE)))).toEqual({
      // Ana back at her own place, the newcomer after her.
      'group:active': ['agent:/ana', 'agent:/dee'],
      dms: ['agent:/bo', 'agent:/cy', 'command:message-someone'],
    });
  });

  it('never holds a door', () => {
    const live = [
      section('group:active', [row('agent:/ana')]),
      section('dms', [row('agent:/bo'), row('agent:/cy')]),
    ];
    expect(idsOf(holdSectionMoves(live, membershipOf(BEFORE))).dms).toEqual([
      'agent:/bo',
      'agent:/cy',
    ]);
  });

  it('hands back the live list itself when nothing moved', () => {
    expect(holdSectionMoves(BEFORE, membershipOf(BEFORE))).toBe(BEFORE);
  });
});

describe('useHeldSections', () => {
  it('holds moves while inside, and applies them on leave', () => {
    const { result, rerender } = renderHook(
      ({ live, inside, resetKey }) => useHeldSections(live, inside, resetKey),
      { initialProps: { live: BEFORE, inside: false, resetKey: 'prefs-1' } }
    );
    rerender({ live: BEFORE, inside: true, resetKey: 'prefs-1' });
    rerender({ live: AFTER, inside: true, resetKey: 'prefs-1' });
    expect(idsOf(result.current)).toEqual(idsOf(BEFORE));

    rerender({ live: AFTER, inside: false, resetKey: 'prefs-1' });
    expect(idsOf(result.current)).toEqual(idsOf(AFTER));
  });

  it('lets the person’s own change land at once, even inside', () => {
    const { result, rerender } = renderHook(
      ({ live, inside, resetKey }) => useHeldSections(live, inside, resetKey),
      { initialProps: { live: BEFORE, inside: true, resetKey: 'prefs-1' } }
    );
    // A drag rewrote the stored prefs, and the model moved with it.
    rerender({ live: AFTER, inside: true, resetKey: 'prefs-2' });
    expect(idsOf(result.current)).toEqual(idsOf(AFTER));
  });
});

describe('useInside', () => {
  /** A blur from inside `panel` whose focus lands on `next`. */
  function blur(panel: HTMLElement, next: Node | null): FocusEvent<HTMLElement> {
    return { relatedTarget: next, currentTarget: panel } as unknown as FocusEvent<HTMLElement>;
  }

  it('is inside while the pointer is over the panel, and not after it leaves', () => {
    const { result } = renderHook(() => useInside());
    act(() => result.current.handlers.onPointerEnter());
    expect(result.current.inside).toBe(true);
    act(() => result.current.handlers.onPointerLeave());
    expect(result.current.inside).toBe(false);
  });

  it('stays inside while focus moves between rows, and leaves when focus does', () => {
    const panel = document.createElement('div');
    const first = document.createElement('button');
    panel.append(first);
    const outside = document.createElement('button');
    const { result } = renderHook(() => useInside());
    act(() => result.current.handlers.onFocus());
    act(() => result.current.handlers.onBlur(blur(panel, first)));
    expect(result.current.inside).toBe(true);
    act(() => result.current.handlers.onBlur(blur(panel, outside)));
    expect(result.current.inside).toBe(false);
  });
});
