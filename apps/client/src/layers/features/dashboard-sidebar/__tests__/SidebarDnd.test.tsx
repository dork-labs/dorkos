// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SidebarDnd } from '../ui/SidebarDnd';
import { Sortable, agentDndData } from '../ui/SidebarDndPrimitives';

let mockIsMobile = false;
vi.mock('@/layers/shared/model', () => ({
  useIsMobile: () => mockIsMobile,
}));

vi.mock('@/layers/entities/config', () => ({
  useSidebarPrefs: () => ({
    pinned: [],
    groups: [],
    ungroupedSortMode: 'name',
    ungroupedCollapsed: false,
    recentsCollapsed: false,
    groupsHintDismissed: false,
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
    <SidebarDnd displayNames={{ '/a': 'alpha' }}>
      <Sortable id="ungrouped::/a" data={agentDndData('ungrouped', '/a')}>
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
