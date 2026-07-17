// @vitest-environment jsdom
import { useState } from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
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
import { AgentContextMenu } from '../ui/AgentContextMenu';
import { GroupCreateInput } from '../ui/GroupCreateInput';

// Mock the config surface so rendering needs no transport/QueryClient. Two
// groups with the agent in g1 makes the Move-to-group submenu fully populated:
// a checked target, an unchecked target, Remove from group, and New group…
const groups = [
  { id: 'g1', name: 'Clients', agentPaths: ['/agents/api-server'] },
  { id: 'g2', name: 'Experiments', agentPaths: [] },
];
const mockUpdate = vi.fn<(updater: (prev: unknown) => unknown) => void>();
const moveToGroupCalls: unknown[][] = [];
vi.mock('@/layers/entities/config', () => ({
  useSidebarPrefs: () => ({ pinned: [], groups, ungroupedSortMode: 'name' }),
  useUpdateSidebarPrefs: () => ({
    update: mockUpdate,
    updateAsync: vi.fn(),
    isPending: false,
    isError: false,
  }),
  pinPath: (p: unknown) => p,
  unpinPath: (p: unknown) => p,
  moveToGroup: (...args: unknown[]) => {
    moveToGroupCalls.push(args);
    return args[0];
  },
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

beforeEach(() => {
  mockUpdate.mockReset();
  moveToGroupCalls.length = 0;
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
//
// Both variants render through ONE generic walk (`renderNodes` + slot
// primitives), so drift is structurally impossible; this test is the regression
// guard proving it end-to-end, including the Move-to-group submenu contents.
// ---------------------------------------------------------------------------

const props = {
  path: '/agents/api-server',
  onOpenProfile: vi.fn(),
  onNewSession: vi.fn(),
  onRequestNewGroup: vi.fn(),
};

/** One rendered menu entry: label + ARIA role + checked state (submenu included). */
interface MenuEntry {
  label: string;
  role: string;
  checked: string | null;
}

/** Collect every visible menu item across the whole open menu tree. */
function collectMenuTree(): MenuEntry[] {
  const items = [
    ...screen.queryAllByRole('menuitem'),
    ...screen.queryAllByRole('menuitemcheckbox'),
  ];
  return items
    .map((el) => ({
      label: el.textContent?.trim() ?? '',
      role: el.getAttribute('role') ?? '',
      checked: el.getAttribute('aria-checked'),
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.role.localeCompare(b.role));
}

/** Open the Move-to-group submenu via the Radix LTR sub-open key. */
function openMoveSubmenu() {
  fireEvent.keyDown(screen.getByText('Move to group'), { key: 'ArrowRight' });
}

describe('AgentRowMenuItems variant parity', () => {
  it('renders the identical full item tree (submenu included) in both variants', () => {
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
    openMoveSubmenu();
    const contextTree = collectMenuTree();
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
    openMoveSubmenu();
    const dropdownTree = collectMenuTree();

    // Full-tree parity: same labels, same roles, same checked states.
    expect(contextTree).toEqual(dropdownTree);

    // And the tree is the complete expected item set.
    const labels = contextTree.map((e) => e.label);
    expect(labels).toEqual(
      [
        'Pin agent',
        'Move to group',
        'Agent profile',
        'New session',
        // Submenu contents:
        'Clients',
        'Experiments',
        'Remove from group',
        'New group…',
      ].sort()
    );
    // The agent's current group carries the checkmark; the other target does not.
    const clients = contextTree.find((e) => e.label === 'Clients');
    const experiments = contextTree.find((e) => e.label === 'Experiments');
    expect(clients).toMatchObject({ role: 'menuitemcheckbox', checked: 'true' });
    expect(experiments).toMatchObject({ role: 'menuitemcheckbox', checked: 'false' });
  });
});

// ---------------------------------------------------------------------------
// End-to-end wiring through the real AgentContextMenu
// ---------------------------------------------------------------------------

/**
 * Stateful stand-in for the orchestrator: `onRequestNewGroup` mounts the real
 * inline editor, exactly as DashboardSidebar does.
 */
function InlineCreateHarness() {
  const [creating, setCreating] = useState(false);
  return (
    <div>
      <AgentContextMenu
        path="/agents/api-server"
        onOpenProfile={() => {}}
        onNewSession={() => {}}
        onRequestNewGroup={() => setCreating(true)}
      >
        <div data-testid="row-trigger">row</div>
      </AgentContextMenu>
      {creating && (
        <ul>
          <GroupCreateInput
            onCommit={() => setCreating(false)}
            onCancel={() => setCreating(false)}
          />
        </ul>
      )}
    </div>
  );
}

function openRowMenu() {
  fireEvent.contextMenu(screen.getByTestId('row-trigger'));
}

function openMoveToGroupSubmenu() {
  fireEvent.keyDown(screen.getByText('Move to group'), { key: 'ArrowRight' });
}

describe('AgentContextMenu end-to-end wiring', () => {
  // Regression test for the live-browser bug (DOR-329): Radix closes the menu
  // in a second commit AFTER the inline editor mounts and focuses; the close's
  // focus restore refocused the trigger, blurring the editor, whose blur-cancel
  // unmounted it — "New group…" appeared to do nothing. jsdom cannot fully
  // reproduce the native focus-restore race, so this asserts the observable
  // outcome (editor survives the menu close AND holds focus); the guard's
  // prevent-once contract is pinned in use-menu-close-focus-guard.test.ts.
  it('keeps the inline group-create editor alive and focused after "New group…" closes the menu', () => {
    render(<InlineCreateHarness />);
    openRowMenu();
    openMoveToGroupSubmenu();
    fireEvent.click(screen.getByText('New group…'));

    const input = screen.getByLabelText('New group name');
    expect(input).toBeInTheDocument();
    // Focus must remain on the editor — a restored-to-trigger focus is exactly
    // the state that killed it (blur-cancel).
    expect(document.activeElement).toBe(input);
    // The menu itself is gone (the guard suppresses focus restore, not closing).
    expect(screen.queryByText('Move to group')).not.toBeInTheDocument();
  });

  it('"Move to group → <other group>" commits moveToGroup(path, groupId)', () => {
    render(<InlineCreateHarness />);
    openRowMenu();
    openMoveToGroupSubmenu();
    fireEvent.click(screen.getByText('Experiments'));

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    mockUpdate.mock.calls[0]![0]({ groups });
    expect(moveToGroupCalls).toEqual([[{ groups }, '/agents/api-server', 'g2']]);
  });

  it('"Remove from group" commits moveToGroup(path, null)', () => {
    render(<InlineCreateHarness />);
    openRowMenu();
    openMoveToGroupSubmenu();
    fireEvent.click(screen.getByText('Remove from group'));

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    mockUpdate.mock.calls[0]![0]({ groups });
    expect(moveToGroupCalls).toEqual([[{ groups }, '/agents/api-server', null]]);
  });
});
