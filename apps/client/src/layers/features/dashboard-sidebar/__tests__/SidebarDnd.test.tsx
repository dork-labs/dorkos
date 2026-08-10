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
          <div ref={b.setNodeRef} {...b.handleProps} data-testid="row">
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
    expect(row.getAttribute('tabindex')).toBe('0');
  });

  it('disables drag on mobile: no drag handlers or sortable role attach in the Sheet', () => {
    mockIsMobile = true;
    render(<Row />);
    const row = screen.getByTestId('row');
    expect(row.getAttribute('aria-roledescription')).toBeNull();
    expect(row.getAttribute('tabindex')).toBeNull();
  });

  // The row registers itself as its own activator node, so KeyboardSensor only
  // activates when the keydown target IS the row — Space/Enter on nested
  // interactive controls (menus, buttons, the rename input) must pass through.

  it('starts a keyboard drag from a keydown on the focused row itself', () => {
    render(<Row />);
    const row = screen.getByTestId('row');
    fireEvent.keyDown(row, { code: 'Enter' });
    // dnd-kit reflects the active keyboard drag as aria-pressed on the row.
    expect(row.getAttribute('aria-pressed')).toBe('true');
    // End the drag so cleanup unmounts an idle tree.
    fireEvent.keyDown(row, { code: 'Escape' });
  });

  it('does NOT start a keyboard drag from nested interactive controls', () => {
    render(<Row />);
    const row = screen.getByTestId('row');
    const nested = screen.getByTestId('nested-action');
    fireEvent.keyDown(nested, { code: 'Enter' });
    fireEvent.keyDown(nested, { code: 'Space' });
    expect(row.getAttribute('aria-pressed')).toBeNull();
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
    expect(sidebarDndData('ungrouped', roomRef, 'Channels')).toEqual({
      type: 'item',
      ref: roomRef,
      container: { kind: 'ungrouped', section: 'Channels' },
    });
  });
});
