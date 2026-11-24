// @vitest-environment jsdom
/** Long press, on a touch screen, over the sidebar's one menu surface (P4 AC-3). */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Pin, FolderInput, Trash2, ListFilter } from 'lucide-react';
import { TIMING } from '@/layers/shared/lib/constants';
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

/** A list with one of every node kind the sheet has to walk. */
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

/**
 * Press and hold ON A GIVEN ELEMENT, and let go on it.
 *
 * **Deliberately not {@link press}.** That helper always releases with a click
 * on the ROW, which clears the surface's own "this press opened the menu" latch
 * before anything else can see it — so a press that begins and ends INSIDE an
 * open menu is a case it structurally cannot express. Two reachable defects
 * lived in exactly that gap.
 *
 * @param element - What the finger is on for the whole gesture.
 * @param holdMs - How long it stays down.
 */
function holdOn(element: HTMLElement, holdMs = 700) {
  fireEvent.pointerDown(element, { button: 0, clientX: 100, clientY: 200 });
  act(() => {
    vi.advanceTimersByTime(holdMs);
  });
  fireEvent.pointerUp(element);
  fireEvent.click(element);
}

/** The long-press sheet, or `null` when no sheet is up. */
const sheet = () => screen.queryByTestId('sidebar-menu-sheet');

/** What may be counted as something the operator can choose. */
const NOT_A_SUBMENU_TRIGGER = ':not([aria-haspopup])';

/** Every addressable menu entry in an open surface, by its stable id. */
function itemIds(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll(`[data-menu-item-id]${NOT_A_SUBMENU_TRIGGER}`))
    .map((el) => el.getAttribute('data-menu-item-id')!)
    .sort();
}

/** Every choosable menu row in an open surface: its name, its role, and whether it is ticked. */
function itemNames(root: HTMLElement): string[] {
  return Array.from(
    root.querySelectorAll(
      ['menuitem', 'menuitemcheckbox', 'menuitemradio']
        .map((role) => `[role="${role}"]${NOT_A_SUBMENU_TRIGGER}`)
        .join(',')
    )
  )
    .map((el) => {
      const checked = el.getAttribute('aria-checked');
      return `${(el.textContent ?? '').trim()} [${el.getAttribute('role')}${
        checked === null ? '' : ` checked=${checked}`
      }]`;
    })
    .sort();
}

// jsdom implements no pointer capture, and vaul claims it on every press inside the sheet (that
// is how a drawer follows a drag).
beforeAll(() => {
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
});

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

  it('does not let the ghost click after a long press choose whatever is now where the row used to be', () => {
    // **The sheet rises to COVER the row that opened it.** The browser follows a touch release
    // with a compatibility `click` fired at the press's own screen position — the same fact
    // `press()`'s trailing `click(target)` exists to swallow.
    renderSurface();
    const root = surfaceRoot();
    fireEvent.pointerDown(root, { button: 0, clientX: 100, clientY: 200 });
    act(() => {
      vi.advanceTimersByTime(700);
    });
    fireEvent.pointerUp(root);
    expect(sheet()).not.toBeNull();

    // The ghost click, landing on a real row of the sheet rather than on the
    // row that opened it.
    const item = within(sheet()!).getByRole('menuitem', { name: /Pin agent/ });
    fireEvent.click(item);

    expect(onPin).not.toHaveBeenCalled();
    expect(sheet()).toHaveAttribute('data-state', 'open');

    // …and the sheet is not left deaf afterwards — a real, later tap on the same row still runs
    // it, which is what tells this apart from a sheet that swallows every click forever.
    fireEvent.click(item);
    expect(onPin).toHaveBeenCalledTimes(1);
  });

  it('offers exactly what the "⋮" offers — every leaf, submenus included', () => {
    // **The AC, asserted between two renderings rather than against a literal.** The kebab hides
    // a submenu's contents behind its trigger, so the desktop side has to be walked into; the
    // sheet has nowhere to hide them, so its list is flat.
    renderSurface();
    press({ holdMs: 700 });
    const sheetRoot = sheet()!;
    const sheetIds = itemIds(sheetRoot);
    const sheetNames = itemNames(sheetRoot);
    // The two levels the kebab hides behind a trigger are NAMED in the sheet rather than dropped,
    // which is what makes flattening honest — read while the sheet is still in the document.
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
    // **One submenu at a time, and the union of what each showed.** Radix keeps exactly one sub
    // open — opening Sort closes Move — so a single sweep after opening both reads one of them
    // and silently loses the other.
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
    // Named with their state, so a rendering that dropped the tick differs.
    expect(sheetNames).toContain('Clients [menuitemcheckbox checked=true]');
    expect(sheetNames).toContain('Experiments [menuitemcheckbox checked=false]');
    expect(sheetNames).toContain('Name [menuitemradio checked=true]');
    expect(sheetNames).toContain('Recently used [menuitemradio checked=false]');
  });

  it('runs a sheet row that is held rather than tapped', () => {
    // **A menu is portalled OUT of the row's DOM, but not out of its React tree.** React replays
    // synthetic events along the tree it rendered, so a press held on a row INSIDE the open sheet
    // ran the surface's own gesture handlers: the timer latched "this press opened the menu", and
    // the release click was swallowed by the guard meant for the row underneath.
    renderSurface();
    press({ holdMs: 700 });
    const item = within(sheet()!).getByRole('menuitem', { name: /Pin agent/ });

    holdOn(item, 700);
    expect(onPin).toHaveBeenCalledTimes(1);
  });

  it('runs the chosen action and puts itself away', () => {
    renderSurface();
    press({ holdMs: 700 });
    const open = sheet();
    expect(open).toHaveAttribute('data-state', 'open');

    fireEvent.click(within(open!).getByRole('menuitem', { name: /Pin agent/ }));
    expect(onPin).toHaveBeenCalledTimes(1);
    // **The slide-out is a browser fact, and jsdom cannot see it.** vaul animates the sheet away
    // with a real `@keyframes slideToBottom` it injects into the document, and Radix's `Presence`
    // holds the content mounted until that animation ends. jsdom computes no animation for it at
    // all, so `Presence` has nothing to wait on and unmounts on the spot — which is exactly what
    expect(sheet()).toBeNull();
  });

  it('does not mount a right-click menu on touch, so one press cannot open two menus', () => {
    // Radix's own `ContextMenuTrigger` carries a 700ms touch long-press.
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
});
