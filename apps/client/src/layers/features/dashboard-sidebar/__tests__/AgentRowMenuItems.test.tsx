// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from '@/layers/shared/ui';
import { AgentRowMenuItems, buildRowMenuNodes, type RowMenuModel } from '../ui/AgentRowMenuItems';

// Mock the config surface so rendering needs no transport/QueryClient.
const groups = [{ id: 'g1', name: 'Clients', agentPaths: ['/agents/api-server'] }];
vi.mock('@/layers/entities/config', () => ({
  useSidebarPrefs: () => ({ pinned: [], groups, ungroupedSortMode: 'name' }),
  useUpdateSidebarPrefs: () => ({
    update: vi.fn(),
    updateAsync: vi.fn(),
    isPending: false,
    isError: false,
  }),
  pinPath: (p: unknown) => p,
  unpinPath: (p: unknown) => p,
  moveToGroup: (p: unknown) => p,
}));

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// buildRowMenuNodes (pure item definitions)
// ---------------------------------------------------------------------------

function model(overrides: Partial<RowMenuModel> = {}): RowMenuModel {
  return {
    isPinned: false,
    currentGroupId: null,
    groups: [
      { id: 'g1', name: 'Clients' },
      { id: 'g2', name: 'Experiments' },
    ],
    onTogglePin: vi.fn(),
    onOpenProfile: vi.fn(),
    onNewSession: vi.fn(),
    onMoveToGroup: vi.fn(),
    onNewGroup: vi.fn(),
    ...overrides,
  };
}

/** Find the "Move to group" submenu node. */
function moveSub(nodes: ReturnType<typeof buildRowMenuNodes>) {
  const sub = nodes.find((n) => n.type === 'sub');
  if (sub?.type !== 'sub') throw new Error('no move-to-group submenu');
  return sub;
}

describe('buildRowMenuNodes', () => {
  it('labels the pin item by pin state', () => {
    expect(buildRowMenuNodes(model({ isPinned: false }))[0]).toMatchObject({ label: 'Pin agent' });
    expect(buildRowMenuNodes(model({ isPinned: true }))[0]).toMatchObject({ label: 'Unpin agent' });
  });

  it('checks the current group in the Move-to-group submenu', () => {
    const sub = moveSub(buildRowMenuNodes(model({ currentGroupId: 'g2' })));
    const checks = sub.items.filter((n) => n.type === 'checkItem');
    expect(checks.map((c) => (c.type === 'checkItem' ? c.checked : null))).toEqual([false, true]);
  });

  it('shows "Remove from group" only when the agent is grouped', () => {
    const grouped = moveSub(buildRowMenuNodes(model({ currentGroupId: 'g1' })));
    expect(grouped.items.some((n) => n.type === 'item' && n.label === 'Remove from group')).toBe(
      true
    );

    const ungrouped = moveSub(buildRowMenuNodes(model({ currentGroupId: null })));
    expect(ungrouped.items.some((n) => n.type === 'item' && n.label === 'Remove from group')).toBe(
      false
    );
  });

  it('always offers "New group…" in the submenu', () => {
    const sub = moveSub(buildRowMenuNodes(model()));
    expect(sub.items.some((n) => n.type === 'item' && n.label === 'New group…')).toBe(true);
  });

  it('wires the item callbacks to the model', () => {
    const m = model({ currentGroupId: 'g1' });
    const nodes = buildRowMenuNodes(m);
    // Pin
    const pin = nodes[0];
    if (pin.type === 'item') pin.onSelect();
    expect(m.onTogglePin).toHaveBeenCalledOnce();
    // Remove from group → moveToGroup(null)
    const remove = moveSub(nodes).items.find(
      (n) => n.type === 'item' && n.label === 'Remove from group'
    );
    if (remove?.type === 'item') remove.onSelect();
    expect(m.onMoveToGroup).toHaveBeenCalledWith(null);
  });
});

// ---------------------------------------------------------------------------
// Cross-variant parity (the dual-menu drift guard)
// ---------------------------------------------------------------------------

const props = {
  path: '/agents/api-server',
  onOpenProfile: vi.fn(),
  onNewSession: vi.fn(),
  onRequestNewGroup: vi.fn(),
};

function topLevelLabels(): string[] {
  return screen
    .getAllByRole('menuitem')
    .map((el) => el.textContent?.trim() ?? '')
    .sort();
}

describe('AgentRowMenuItems variant parity', () => {
  it('renders the identical top-level items into both menu variants', () => {
    // Context (right-click) variant
    const ctx = render(
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div data-testid="trigger">row</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <AgentRowMenuItems variant="context" {...props} />
        </ContextMenuContent>
      </ContextMenu>
    );
    fireEvent.contextMenu(ctx.container.querySelector('[data-testid="trigger"]')!);
    const contextLabels = topLevelLabels();
    cleanup();

    // Dropdown ("…") variant
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <AgentRowMenuItems variant="dropdown" {...props} />
        </DropdownMenuContent>
      </DropdownMenu>
    );
    const dropdownLabels = topLevelLabels();

    expect(contextLabels).toEqual(dropdownLabels);
    expect(contextLabels).toEqual(
      ['Pin agent', 'Move to group', 'Agent profile', 'New session'].sort()
    );
  });
});
