// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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
});
