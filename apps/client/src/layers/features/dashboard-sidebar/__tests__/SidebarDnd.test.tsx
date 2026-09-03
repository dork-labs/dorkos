// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SidebarDnd } from '../ui/dnd/SidebarDnd';
import { Sortable, sidebarDndData, sidebarRowDndId } from '../ui/dnd/SidebarDndPrimitives';

let mockIsMobile = false;
vi.mock('@/layers/shared/model', () => ({
  useIsMobile: () => mockIsMobile,
}));

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
    update: vi.fn(),
    updateAsync: vi.fn(),
    isPending: false,
    isError: false,
  }),
}));

function Row() {
  return (
    <SidebarDnd displayNames={{ '/a': 'alpha' }} rooms={[]}>
      <Sortable
        id="ungrouped::agent:/a"
        data={sidebarDndData('ungrouped', { kind: 'agent', path: '/a' })}
      >
        {(b) => (
          // `data-dragging` mirrors the bindings' own `isDragging`, which is
          // dnd-kit's active-drag state read straight off the hook. It is what
          // these tests watch a keyboard drag through, because the drag root is
          // no longer a `role="button"` and so no longer carries `aria-pressed`
          // (DOR-1418) — and the real rows dim themselves off this same flag.
          <div
            ref={b.setNodeRef}
            {...b.handleProps}
            data-testid="row"
            {...(b.isDragging ? { 'data-dragging': '' } : {})}
          >
            alpha
            <button type="button" data-testid="nested-action">
              New session
            </button>
          </div>
        )}
      </Sortable>
    </SidebarDnd>
  );
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
  });
  afterEach(() => cleanup());

  it('enables drag on desktop: the row is a focusable sortable', () => {
    render(<Row />);
    const row = screen.getByTestId('row');
    expect(row.getAttribute('aria-roledescription')).toBe('sortable');
    // **The `0` is this fixture's, not the app's.** It is what dnd-kit puts on a
    // drag root by default, and the assertion is that the drag layer attached at
    // all. In the real panel the sidebar's roving focus takes these to `-1`, so
    // do not read this line as "a drag root is in the tab order there".
    expect(row.getAttribute('tabindex')).toBe('0');
  });

  it('wraps the row in a container role, never a second button (DOR-1418)', () => {
    render(<Row />);
    const row = screen.getByTestId('row');
    // dnd-kit defaults a draggable to `role="button"`, which around a row that
    // CONTAINS a button is axe's `nested-interactive` — 21 of them on the
    // sidebar. `group` is a container role, so it is allowed focusable content,
    // and it still carries the sortable's ARIA.
    expect(row.getAttribute('role')).toBe('group');
    expect(row.querySelector('button')).not.toBeNull();
    // Still described by dnd-kit's keyboard instructions, which is what makes
    // the roledescription mean anything to a reader.
    expect(row.getAttribute('aria-describedby')).toMatch(/DndDescribedBy/);
  });

  it('disables drag on mobile: no drag handlers or sortable role attach in the Sheet', () => {
    mockIsMobile = true;
    render(<Row />);
    const row = screen.getByTestId('row');
    expect(row.getAttribute('aria-roledescription')).toBeNull();
    expect(row.getAttribute('tabindex')).toBeNull();
    expect(row.getAttribute('role')).toBeNull();
  });

  // The row registers itself as its own activator node, so KeyboardSensor only
  // activates when the keydown target IS the row — Space/Enter on nested
  // interactive controls (menus, buttons, the rename input) must pass through.

  it('starts a keyboard drag from a keydown on the focused row itself', () => {
    render(<Row />);
    const row = screen.getByTestId('row');
    fireEvent.keyDown(row, { code: 'Enter' });
    // The row reports itself as the active draggable — dnd-kit's own
    // `isDragging`, mirrored onto the node by the fixture above.
    expect(row.hasAttribute('data-dragging')).toBe(true);
    // End the drag so cleanup unmounts an idle tree.
    fireEvent.keyDown(row, { code: 'Escape' });
  });

  it('does NOT start a keyboard drag from nested interactive controls', () => {
    render(<Row />);
    const row = screen.getByTestId('row');
    const nested = screen.getByTestId('nested-action');
    fireEvent.keyDown(nested, { code: 'Enter' });
    fireEvent.keyDown(nested, { code: 'Space' });
    expect(row.hasAttribute('data-dragging')).toBe(false);
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
