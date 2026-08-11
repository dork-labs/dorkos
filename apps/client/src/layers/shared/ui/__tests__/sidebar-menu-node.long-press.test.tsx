// @vitest-environment jsdom
/**
 * Long press, on a touch screen, over the sidebar's one menu surface (P4 AC-3).
 *
 * **Everything here is the real surface.** `SidebarMenuSurface` is rendered
 * with a real node list — submenu, choices, separators and all — and the
 * assertions read the DOM the three renderers produce. The only thing faked is
 * the viewport, because that is the one fact jsdom genuinely does not have.
 *
 * **Every gesture case moves the clock or the pointer, and says so.** The two
 * shapes this file is most at risk of shipping are a "long press" that never
 * advanced a timer (so it is asserting on a synchronous open that does not
 * exist) and a "scroll cancelled it" that never moved. Each case below is
 * paired with the observation that makes its negative meaningful: the same
 * gesture with one thing changed DOES open the sheet.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Pin, FolderInput, Trash2, ListFilter } from 'lucide-react';
import { LONG_PRESS_DRIFT_PX, TIMING } from '@/layers/shared/lib';
import { SidebarMenuSurface, type SidebarMenuNode } from '../sidebar-menu-node';

// ── The viewport, which is the one thing jsdom cannot answer ────────────────
let phone = false;
function useEmulatedViewport() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => {
      const maxWidth = /max-width:\s*(\d+)px/.exec(query);
      // 390 is the width every mobile assertion in this repo is written for.
      const matches = maxWidth === null ? false : phone && 390 <= Number(maxWidth[1]);
      return {
        matches,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      };
    },
  });
}

const onPin = vi.fn();
const onDelete = vi.fn();
const onMoveTo = vi.fn();
const onSort = vi.fn();

/**
 * A list with one of every node kind the sheet has to walk.
 *
 * The submenu is the interesting one: the "⋮" hides its contents behind a
 * hover, and the sheet has nowhere to hide them — so this is where a renderer
 * that quietly dropped a level would show up.
 */
function nodes(): SidebarMenuNode[] {
  return [
    { kind: 'action', id: 'pin', label: 'Pin agent', icon: Pin, run: onPin },
    {
      kind: 'submenu',
      id: 'move-to-group',
      label: 'Move to group',
      icon: FolderInput,
      items: [
        { kind: 'choice', id: 'group-a', label: 'Clients', checked: true, run: onMoveTo },
        { kind: 'choice', id: 'group-b', label: 'Experiments', checked: false, run: onMoveTo },
      ],
    },
    {
      kind: 'radio',
      id: 'sort',
      label: 'Sort by',
      icon: ListFilter,
      value: 'name',
      options: [
        { value: 'name', label: 'Name' },
        { value: 'recent', label: 'Recently used' },
      ],
      onChange: onSort,
    },
    { kind: 'separator', id: 'sep' },
    {
      kind: 'action',
      id: 'delete',
      label: 'Delete group',
      icon: Trash2,
      destructive: true,
      opensInput: true,
      run: onDelete,
    },
  ];
}

const onSelect = vi.fn();

function renderSurface() {
  return render(
    <SidebarMenuSurface nodes={nodes()} actionsLabel="Scout actions">
      <button type="button" data-testid="row" onClick={onSelect}>
        Scout
      </button>
    </SidebarMenuSurface>
  );
}

/** The surface's own root — the element the gesture handlers are on. */
const surfaceRoot = () => screen.getByTestId('row').parentElement!;

/**
 * Press, hold, and let go — with the clock actually moving.
 *
 * @param options.holdMs - How long the finger stays down. Below
 *   `TIMING.LONG_PRESS_MS` this is a tap.
 * @param options.driftPx - How far it travels mid-hold, which is what a scroll
 *   beginning on this row looks like.
 */
function press({ holdMs = 700, driftPx = 0 }: { holdMs?: number; driftPx?: number } = {}) {
  const target = screen.getByTestId('row');
  const root = surfaceRoot();
  fireEvent.pointerDown(root, { button: 0, clientX: 100, clientY: 200 });
  if (driftPx > 0) {
    fireEvent.pointerMove(root, { button: 0, clientX: 100, clientY: 200 + driftPx });
  }
  act(() => {
    vi.advanceTimersByTime(holdMs);
  });
  fireEvent.pointerUp(root);
  // The browser follows a release with a click on whatever was pressed. The
  // surface has to swallow exactly the one that ended a long press.
  fireEvent.click(target);
}

/** The long-press sheet, or `null` when no sheet is up. */
const sheet = () => screen.queryByTestId('sidebar-menu-sheet');

/**
 * What may be counted as something the operator can choose.
 *
 * **A submenu trigger is not an action, and excluding it is the whole point of
 * the comparison.** "Move to group ›" opens more menu; it does nothing to the
 * row. The kebab has two of them because a hover menu needs somewhere to put a
 * second level, and the sheet has none because it has no second level to put
 * anything in. Counting them would make the two renderings differ by exactly
 * the thing they are allowed to differ by, and no assertion could survive it.
 * Radix marks them, so this reads the marking rather than a list of labels.
 */
const NOT_A_SUBMENU_TRIGGER = ':not([aria-haspopup])';

/** Every addressable menu entry in an open surface, by its stable id. */
function itemIds(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll(`[data-menu-item-id]${NOT_A_SUBMENU_TRIGGER}`))
    .map((el) => el.getAttribute('data-menu-item-id')!)
    .sort();
}

/** Every choosable menu row in an open surface, by its accessible name. */
function itemNames(root: HTMLElement): string[] {
  return Array.from(
    root.querySelectorAll(
      ['menuitem', 'menuitemcheckbox', 'menuitemradio']
        .map((role) => `[role="${role}"]${NOT_A_SUBMENU_TRIGGER}`)
        .join(',')
    )
  )
    .map((el) => (el.textContent ?? '').trim())
    .sort();
}

beforeEach(() => {
  phone = true;
  useEmulatedViewport();
  vi.useFakeTimers();
  onPin.mockClear();
  onDelete.mockClear();
  onMoveTo.mockClear();
  onSort.mockClear();
  onSelect.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('the long-press sheet (P4 AC-3)', () => {
  it('opens on a sustained press', () => {
    renderSurface();
    expect(sheet()).toBeNull();
    press({ holdMs: TIMING.LONG_PRESS_MS + 50 });
    expect(sheet()).not.toBeNull();
  });

  it('does not open for a tap — and the identical gesture held longer does', () => {
    renderSurface();
    // The negative. Everything about this is the long press except the clock.
    press({ holdMs: TIMING.LONG_PRESS_MS - 50 });
    expect(sheet()).toBeNull();
    // "X did not happen" is only worth reading beside X happening.
    press({ holdMs: TIMING.LONG_PRESS_MS + 50 });
    expect(sheet()).not.toBeNull();
  });

  it('stands down when the press turns into a scroll — and does not when it stays still', () => {
    renderSurface();
    // A scroll that begins on a row: same finger, same duration, moving.
    press({ holdMs: 700, driftPx: LONG_PRESS_DRIFT_PX + 5 });
    expect(sheet()).toBeNull();

    // The pair: the same 700ms with no travel opens it. Without this the case
    // above would pass against a surface with no long press at all.
    press({ holdMs: 700, driftPx: 0 });
    expect(sheet()).not.toBeNull();
  });

  it('leaves the row alone: the press that opened the menu does not also open the row', () => {
    renderSurface();
    press({ holdMs: 700 });
    expect(sheet()).not.toBeNull();
    expect(onSelect).not.toHaveBeenCalled();

    // …and the row is not left deaf afterwards. A suppression that never
    // cleared would be indistinguishable from this test's first assertion.
    fireEvent.click(screen.getByTestId('row'));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('offers exactly what the "⋮" offers — every leaf, submenus included', () => {
    // **The AC, asserted between two renderings rather than against a literal.**
    // The kebab hides a submenu's contents behind its trigger, so the desktop
    // side has to be walked into; the sheet has nowhere to hide them, so its
    // list is flat. What must match is the set of things you can actually
    // choose.
    renderSurface();
    press({ holdMs: 700 });
    const sheetRoot = sheet()!;
    const sheetIds = itemIds(sheetRoot);
    const sheetNames = itemNames(sheetRoot);
    // The two levels the kebab hides behind a trigger are NAMED in the sheet
    // rather than dropped, which is what makes flattening honest — read while
    // the sheet is still in the document.
    expect(within(sheetRoot).getByText('Move to group')).toBeInTheDocument();
    expect(within(sheetRoot).getByText('Sort by')).toBeInTheDocument();
    cleanup();

    phone = false;
    useEmulatedViewport();
    renderSurface();
    // Radix opens a dropdown on `pointerdown`, not on the click after it.
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Scout actions' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    });
    const menu = screen.getByRole('menu');
    // **One submenu at a time, and the union of what each showed.** Radix keeps
    // exactly one sub open — opening Sort closes Move — so a single sweep after
    // opening both reads one of them and silently loses the other. That is not
    // a hole in the menu; it is how a hover menu works, and it is why the sheet
    // exists at all on a screen with no hover.
    // `ArrowRight` on the trigger is how this repo's other parity test opens a
    // Radix submenu, and it needs no timers.
    const kebabIds = new Set(itemIds(document.body));
    const kebabNames = new Set(itemNames(document.body));
    for (const label of ['Move to group', 'Sort by']) {
      fireEvent.keyDown(screen.getByText(label), { key: 'ArrowRight' });
      for (const id of itemIds(document.body)) kebabIds.add(id);
      for (const name of itemNames(document.body)) kebabNames.add(name);
    }
    expect(menu).toBeInTheDocument();

    expect(sheetIds).toEqual([...kebabIds].sort());
    expect(sheetNames).toEqual([...kebabNames].sort());
    // Not vacuously equal: both are the real list, and the list has content.
    expect(sheetIds).toContain('pin');
    expect(sheetIds).toContain('delete');
    expect(sheetNames).toContain('Clients');
    expect(sheetNames).toContain('Recently used');
  });

  it('stands down on the "⋮", which opens its own menu on the way down', () => {
    // Radix opens a dropdown on `pointerdown`. A press held on the kebab used
    // to open that at 0ms and this sheet at 500ms — two menus, one gesture.
    renderSurface();
    const kebab = screen.getByRole('button', { name: 'Scout actions' });
    fireEvent.pointerDown(kebab, { button: 0, clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(900);
    });
    fireEvent.pointerUp(kebab);
    expect(sheet()).toBeNull();

    // The pair: the same press one element over — on the row — does open it,
    // so the silence above is the yield rather than a gesture that never works.
    press({ holdMs: 900 });
    expect(sheet()).not.toBeNull();
  });

  it('runs the chosen action and puts itself away', () => {
    renderSurface();
    press({ holdMs: 700 });
    fireEvent.click(within(sheet()!).getByRole('menuitem', { name: /Pin agent/ }));
    expect(onPin).toHaveBeenCalledTimes(1);
    // The sheet is dismissed, which is a state flip rather than an unmount:
    // vaul keeps the content mounted through its slide-out, and that animation
    // is driven by frames rather than by the timers this test controls.
    expect(sheet()).toHaveAttribute('data-state', 'closed');
  });

  it('writes a radio choice back through the node that owns it', () => {
    renderSurface();
    press({ holdMs: 700 });
    fireEvent.click(within(sheet()!).getByRole('menuitemradio', { name: 'Recently used' }));
    expect(onSort).toHaveBeenCalledWith('recent');
  });

  it('does not mount a right-click menu on touch, so one press cannot open two menus', () => {
    // Radix's own `ContextMenuTrigger` carries a 700ms touch long-press. Left
    // mounted under this one it would fire 200ms after the sheet, over the top
    // of it. The trigger's absence is what makes that impossible.
    renderSurface();
    expect(document.querySelector('[data-slot="context-menu-trigger"]')).toBeNull();

    // The pair: at pointer width it IS mounted, so the assertion above is
    // about the device rather than about the component never having one.
    cleanup();
    phone = false;
    useEmulatedViewport();
    renderSurface();
    expect(document.querySelector('[data-slot="context-menu-trigger"]')).not.toBeNull();
  });

  it('draws no sheet and arms no gesture at pointer width', () => {
    cleanup();
    phone = false;
    useEmulatedViewport();
    renderSurface();
    press({ holdMs: 900 });
    expect(sheet()).toBeNull();
    // The row still works, which is what says the press reached it at all.
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('shows the "⋮" at rest on touch and hides it at rest under a pointer', () => {
    // DOR-1083's shape, at the surface every row and header shares: a control
    // revealed by hover is a control a finger cannot find.
    renderSurface();
    expect(screen.getByRole('button', { name: 'Scout actions' }).className).toContain(
      'opacity-100'
    );

    cleanup();
    phone = false;
    useEmulatedViewport();
    renderSurface();
    expect(screen.getByRole('button', { name: 'Scout actions' }).className).toContain('opacity-0');
  });
});
