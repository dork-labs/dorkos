// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { SIDEBAR_DRAGGING_ATTRIBUTE } from '@/layers/shared/model';
import { SidebarDnd } from '../ui/dnd/SidebarDnd';
import {
  Sortable,
  sidebarDndData,
  sidebarRowDndId,
  SIDEBAR_DRAG_ROOT_ATTRIBUTE,
} from '../ui/dnd/SidebarDndPrimitives';

let mockIsMobile = false;
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useIsMobile: () => mockIsMobile,
}));

/**
 * Every write the drag layer asks for. Held out here rather than made fresh
 * inside the mock factory: a `vi.fn()` created per call records into an object
 * no test can read, which is how "did this drop persist anything?" went unasked.
 */
const mockUpdateSidebar = vi.fn();

vi.mock('@/layers/entities/config', () => ({
  useSidebarPrefs: () => ({
    pinned: [],
    groups: [],
    sections: {},
    muted: [],
    gettingStarted: { retired: [] },
    digest: {},
  }),
  useUpdateSidebarPrefs: () => ({
    update: mockUpdateSidebar,
    updateAsync: vi.fn(),
    isPending: false,
    isError: false,
  }),
}));

/**
 * A drag source shaped like the real one: a root that measures and announces,
 * a `<button>` row inside it that takes focus and the drag's activators, and a
 * "⋮"-shaped sibling beside the row.
 *
 * **The shape is the subject.** The fixture used to put everything on one node,
 * which is why it could assert `tabindex="0"` on a drag root the actual panel
 * has always stamped `-1` (DOR-1746). The panel's real answer is a root out of
 * the tab order with the keyboard's landing spot inside it, so that is what is
 * drawn here.
 */
function Row() {
  return (
    <SidebarDnd displayNames={{ '/a': 'alpha' }} rooms={[]}>
      <Sortable
        id="ungrouped::agent:/a"
        data={sidebarDndData('ungrouped', { kind: 'agent', path: '/a' })}
      >
        {(b) => (
          <div ref={b.setNodeRef} {...b.rootProps} data-testid="drag-root">
            <button type="button" {...b.activatorProps} data-testid="row">
              alpha
            </button>
            <button type="button" data-testid="nested-action">
              New session
            </button>
          </div>
        )}
      </Sortable>
    </SidebarDnd>
  );
}

/**
 * Whether the row is off the ground, read the way the sidebar's own roving focus
 * reads it: the mark the drag layer stamps on a root while it is dragging. The
 * drag root is not a `role="button"` and so carries no `aria-pressed` to ask
 * instead (DOR-1418).
 */
function isDragging(): boolean {
  return screen.getByTestId('drag-root').hasAttribute(SIDEBAR_DRAGGING_ATTRIBUTE);
}

describe('SidebarDnd', () => {
  beforeAll(() => {
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    // dnd-kit scrolls the active node into view on keyboard drag start; jsdom
    // has no scrollIntoView implementation.
    Element.prototype.scrollIntoView = vi.fn();
  });
  beforeEach(() => {
    mockIsMobile = false;
    mockUpdateSidebar.mockClear();
  });
  afterEach(() => cleanup());

  it('enables drag on desktop: the ROW announces itself as sortable', () => {
    render(<Row />);
    // On the row, not the root that wraps it. `aria-roledescription` is spoken
    // when the element carrying it takes focus, and only the row ever does —
    // so it goes where its other half, the keyboard instructions, went
    // (DOR-1746). The root is named by a mark instead.
    expect(screen.getByTestId('row').getAttribute('aria-roledescription')).toBe('sortable');
    expect(screen.getByTestId('drag-root').getAttribute('aria-roledescription')).toBeNull();
    expect(screen.getByTestId('drag-root').hasAttribute(SIDEBAR_DRAG_ROOT_ATTRIBUTE)).toBe(true);
  });

  it('keeps the drag root out of the tab order, where the panel keeps it (DOR-1746)', () => {
    render(<Row />);
    // dnd-kit's default is `0`, and the sidebar's roving focus stamped it back
    // to `-1` in the real panel — so the drag root was a keyboard drag's only
    // possible starting point AND unreachable by any key. The root declares
    // `-1` itself now, and the row below is the reachable half.
    expect(screen.getByTestId('drag-root').getAttribute('tabindex')).toBe('-1');
    expect(screen.getByTestId('row').getAttribute('tabindex')).toBeNull();
  });

  it('wraps the row in a container role, never a second button (DOR-1418)', () => {
    render(<Row />);
    const root = screen.getByTestId('drag-root');
    // dnd-kit defaults a draggable to `role="button"`, which around a row that
    // CONTAINS a button is axe's `nested-interactive` — 21 of them on the
    // sidebar. `group` is a container role, so it is allowed focusable content.
    // It has to be SPELLED: dnd-kit reads `role` with a `= defaultRole`
    // fallback, so omitting it asks for `button` rather than for nothing.
    expect(root.getAttribute('role')).toBe('group');
    expect(root.querySelector('button')).not.toBeNull();
  });

  it('describes the ROW with the keyboard instructions, not the root nothing focuses', () => {
    render(<Row />);
    // dnd-kit's "To pick up a sortable item, press space…" is read out when the
    // element carrying it takes focus. On the root that was never — it is not in
    // the tab order — so the instructions travel with the activator (DOR-1746).
    expect(screen.getByTestId('row').getAttribute('aria-describedby')).toMatch(/DndDescribedBy/);
    expect(screen.getByTestId('drag-root').getAttribute('aria-describedby')).toBeNull();
  });

  it('disables drag on mobile: no drag handlers or sortable role attach in the Sheet', () => {
    mockIsMobile = true;
    render(<Row />);
    const root = screen.getByTestId('drag-root');
    expect(root.getAttribute('tabindex')).toBeNull();
    expect(root.getAttribute('role')).toBeNull();
    expect(root.hasAttribute(SIDEBAR_DRAG_ROOT_ATTRIBUTE)).toBe(false);
    expect(screen.getByTestId('row').getAttribute('aria-roledescription')).toBeNull();
    expect(screen.getByTestId('row').getAttribute('aria-describedby')).toBeNull();
  });

  // The activators ride the ROW, which is the element the sidebar's roving focus
  // can put focus on. A keydown anywhere else — the "⋮", a glyph action, a
  // rename field — never reaches them.

  it('starts a keyboard drag from Space on the row itself', () => {
    render(<Row />);
    const row = screen.getByTestId('row');
    fireEvent.keyDown(row, { code: 'Space' });
    expect(isDragging()).toBe(true);
    // End the drag so cleanup unmounts an idle tree.
    fireEvent.keyDown(row, { code: 'Escape' });
  });

  it('leaves Enter to the row, which opens what the row points at', () => {
    render(<Row />);
    const row = screen.getByTestId('row');
    // dnd-kit starts a drag on Enter by default. Harmless while the activator
    // was a wrapper nothing could focus; on the row's own button it would have
    // meant Enter no longer opened the conversation (DOR-1746).
    fireEvent.keyDown(row, { code: 'Enter' });
    expect(isDragging()).toBe(false);
  });

  it('does NOT start a keyboard drag from a control beside the row', () => {
    render(<Row />);
    const nested = screen.getByTestId('nested-action');
    fireEvent.keyDown(nested, { code: 'Enter' });
    fireEvent.keyDown(nested, { code: 'Space' });
    expect(isDragging()).toBe(false);
  });

  it('writes nothing when a lifted row is put straight back down (DOR-1746)', async () => {
    // Every write here carries the WHOLE `ui.sidebar` section, so a drop that
    // resolves to no change still PATCHed the server with what it already had.
    // A mouse made that hard to do by accident; Space-then-Space is one reflex,
    // and a keyboard reader who thinks better of a drag should not be billed a
    // config write for changing their mind.
    render(<Row />);
    const row = screen.getByTestId('row');
    fireEvent.keyDown(row, { code: 'Space' });
    expect(isDragging()).toBe(true);

    // dnd-kit arms the sensor's own document listener in a `setTimeout`, so the
    // drop has to be fired on the next turn to be heard at all.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.keyDown(row, { code: 'Space' });

    // The drag really did end — otherwise "no write" would be true for the
    // uninteresting reason that nothing happened.
    expect(isDragging()).toBe(false);
    expect(mockUpdateSidebar).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Node identity + data (rooms-in-groups, DOR-581)
// ---------------------------------------------------------------------------

describe('sidebar row dnd nodes', () => {
  const roomRef = { kind: 'room', roomId: 'r1' } as const;
  const agentRef = { kind: 'agent', path: '/repo/ana' } as const;

  it('keeps an agent and a room apart even when their spellings would collide', () => {
    // A room whose id happens to read like a path must not answer to the same
    // dnd id as the agent at that path, or dnd-kit measures the wrong node.
    const collidingRoom = { kind: 'room', roomId: '/repo/ana' } as const;
    // Exact strings, not just inequality: the kind discriminator inside
    // sidebarItemKey is what keeps the namespaces disjoint.
    expect(sidebarRowDndId('ungrouped', agentRef)).toBe('ungrouped::agent:/repo/ana');
    expect(sidebarRowDndId('ungrouped', collidingRoom)).toBe('ungrouped::room:/repo/ana');
  });

  it('names the home container from the section key prefix, for either kind', () => {
    expect(sidebarDndData('pinned', roomRef)).toEqual({
      type: 'item',
      ref: roomRef,
      container: { kind: 'pinned' },
    });
    expect(sidebarDndData('g1', roomRef)).toEqual({
      type: 'item',
      ref: roomRef,
      container: { kind: 'group', groupId: 'g1' },
    });
  });

  it('carries the ungrouped section name so a hover announces the list it is over', () => {
    // "Ungrouped" is three sections now. Without the name the drag layer would
    // announce "Over Agents." while the cursor sat over Channels.
    expect(sidebarDndData('ungrouped', roomRef, 'channels')).toEqual({
      type: 'item',
      ref: roomRef,
      container: { kind: 'ungrouped', section: 'channels' },
    });
  });
});
