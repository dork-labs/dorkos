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
  SidebarMenuNodes,
  SidebarMenuSurface,
} from '@/layers/shared/ui';
import type { SidebarItemRef } from '@dorkos/shared/config-schema';
import {
  buildRowMenuNodes,
  useAgentRowMenuNodes,
  type RowMenuModel,
} from '../ui/AgentRowMenuItems';
import { GroupCreateInput } from '../ui/GroupCreateInput';

/**
 * The agent row's menu in one Radix family, for the parity test below. The
 * production row hands the same node list to {@link SidebarMenuSurface}, which
 * renders BOTH families from it — this splits them apart so the two trees can
 * be compared.
 */
function AgentRowMenuItems({
  variant,
  ...params
}: Parameters<typeof useAgentRowMenuNodes>[0] & { variant: 'context' | 'dropdown' }) {
  return <SidebarMenuNodes variant={variant} nodes={useAgentRowMenuNodes(params)} />;
}

// Mock the config surface so rendering needs no transport/QueryClient. Two
// groups with the agent in g1 makes the Move-to-group submenu fully populated:
// a checked target, an unchecked target, Remove from section, and New section…
const API_SERVER: SidebarItemRef = { kind: 'agent', path: '/agents/api-server' };
const groups = [
  { id: 'g1', name: 'Clients', items: [API_SERVER] },
  { id: 'g2', name: 'Experiments', items: [] },
  // A smart group must never be offered as a move target: filing a row into
  // one hides it from its home section while the group draws rule-derived
  // members instead (DOR-581 review). The exact-labels assertions below are
  // what prove the filter: revert it and 'Active now' joins the tree.
  { id: 'g3', name: 'Active now', kind: 'smart' as const, items: [] },
];
const mockUpdate = vi.fn<(updater: (prev: unknown) => unknown) => void>();
const moveToGroupCalls: unknown[][] = [];
const muteItemCalls: unknown[][] = [];
const unmuteItemCalls: unknown[][] = [];
let mockMuted: SidebarItemRef[] = [];
vi.mock('@/layers/entities/config', () => ({
  useSidebarPrefs: () => ({ pinned: [], groups, sections: {}, muted: mockMuted }),
  useUpdateSidebarPrefs: () => ({
    update: mockUpdate,
    updateAsync: vi.fn(),
    isPending: false,
    isError: false,
  }),
  pinItem: (p: unknown) => p,
  unpinItem: (p: unknown) => p,
  muteItem: (...args: unknown[]) => {
    muteItemCalls.push(args);
    return args[0];
  },
  unmuteItem: (...args: unknown[]) => {
    unmuteItemCalls.push(args);
    return args[0];
  },
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
  muteItemCalls.length = 0;
  unmuteItemCalls.length = 0;
  mockMuted = [];
});

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// buildRowMenuNodes (pure item definitions)
// ---------------------------------------------------------------------------

function model(overrides: Partial<RowMenuModel> = {}): RowMenuModel {
  return {
    isPinned: false,
    isMuted: false,
    currentGroupId: null,
    groups: [
      { id: 'g1', name: 'Clients' },
      { id: 'g2', name: 'Experiments' },
    ],
    onTogglePin: vi.fn(),
    onToggleMute: vi.fn(),
    onOpenSessions: vi.fn(),
    onViewProfile: vi.fn(),
    onNewSession: vi.fn(),
    onMoveToGroup: vi.fn(),
    onNewGroup: vi.fn(),
    ...overrides,
  };
}

/** Find the "Move to section" submenu node. */
function moveSub(nodes: ReturnType<typeof buildRowMenuNodes>) {
  const sub = nodes.find((n) => n.kind === 'submenu');
  if (sub?.kind !== 'submenu') throw new Error('no move-to-group submenu');
  return sub;
}

describe('buildRowMenuNodes', () => {
  it('labels the pin item by pin state', () => {
    expect(buildRowMenuNodes(model({ isPinned: false }))[0]).toMatchObject({ label: 'Pin agent' });
    expect(buildRowMenuNodes(model({ isPinned: true }))[0]).toMatchObject({ label: 'Unpin agent' });
  });

  it('labels the mute item by mute state', () => {
    expect(buildRowMenuNodes(model({ isMuted: false }))[1]).toMatchObject({ label: 'Mute agent' });
    expect(buildRowMenuNodes(model({ isMuted: true }))[1]).toMatchObject({ label: 'Unmute agent' });
  });

  it('checks the current group in the Move-to-group submenu', () => {
    const sub = moveSub(buildRowMenuNodes(model({ currentGroupId: 'g2' })));
    const checks = sub.items.filter((n) => n.kind === 'choice');
    expect(checks.map((c) => (c.kind === 'choice' ? c.checked : null))).toEqual([false, true]);
  });

  it('shows "Remove from section" only when the agent is grouped', () => {
    const grouped = moveSub(buildRowMenuNodes(model({ currentGroupId: 'g1' })));
    expect(
      grouped.items.some((n) => n.kind === 'action' && n.label === 'Remove from section')
    ).toBe(true);

    const ungrouped = moveSub(buildRowMenuNodes(model({ currentGroupId: null })));
    expect(
      ungrouped.items.some((n) => n.kind === 'action' && n.label === 'Remove from section')
    ).toBe(false);
  });

  it('always offers "New section…" in the submenu', () => {
    const sub = moveSub(buildRowMenuNodes(model()));
    // The label carries no ellipsis — `opensInput` is what earns it, and the
    // renderer is the one place that appends it (asserted end-to-end below,
    // where "New section…" is what a person actually reads).
    expect(
      sub.items.some(
        (n) => n.kind === 'action' && n.label === 'New section' && n.opensInput === true
      )
    ).toBe(true);
  });

  it('wires the item callbacks to the model', () => {
    const m = model({ currentGroupId: 'g1' });
    const nodes = buildRowMenuNodes(m);
    // Pin
    const pin = nodes[0];
    if (pin?.kind === 'action') pin.run();
    expect(m.onTogglePin).toHaveBeenCalledOnce();
    // Remove from section → moveToGroup(null)
    const remove = moveSub(nodes).items.find(
      (n) => n.kind === 'action' && n.label === 'Remove from section'
    );
    if (remove?.kind === 'action') remove.run();
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
  onOpenSessions: vi.fn(),
  onViewProfile: vi.fn(),
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
  fireEvent.keyDown(screen.getByText('Move to section'), { key: 'ArrowRight' });
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
        'Mute agent',
        'Move to section',
        // The two acts that are satellites of the row on a pointer device — the
        // "N live" chip and the face — and have no target big enough to draw
        // under a thumb, so the menu is where a phone reaches them (P4.2).
        'Switch session…',
        'View profile',
        'New session',
        // Submenu contents:
        'Clients',
        'Experiments',
        'Remove from section',
        'New section…',
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
// End-to-end wiring through the real shared menu surface
// ---------------------------------------------------------------------------

/**
 * Stateful stand-in for the orchestrator: `onRequestNewGroup` mounts the real
 * inline editor, exactly as DashboardSidebar does.
 */
function InlineCreateHarness() {
  const [creating, setCreating] = useState(false);
  return (
    <div>
      <AgentRowMenuSurface onRequestNewGroup={() => setCreating(true)} />
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

/**
 * The real production wiring: one node list handed to the one shared surface,
 * which renders the right-click menu and the "⋮" from it. This is what
 * `AgentListItem` does, minus the row.
 */
function AgentRowMenuSurface({ onRequestNewGroup }: { onRequestNewGroup: () => void }) {
  const nodes = useAgentRowMenuNodes({
    path: '/agents/api-server',
    onOpenSessions: () => {},
    onViewProfile: () => {},
    onNewSession: () => {},
    onRequestNewGroup,
  });
  return (
    <SidebarMenuSurface nodes={nodes} actionsLabel="Agent actions">
      <div data-testid="row-trigger">row</div>
    </SidebarMenuSurface>
  );
}

function openRowMenu() {
  fireEvent.contextMenu(screen.getByTestId('row-trigger'));
}

function openMoveToGroupSubmenu() {
  fireEvent.keyDown(screen.getByText('Move to section'), { key: 'ArrowRight' });
}

describe('agent row menu end-to-end wiring', () => {
  // Regression test for the live-browser bug (DOR-329): Radix closes the menu
  // in a second commit AFTER the inline editor mounts and focuses; the close's
  // focus restore refocused the trigger, blurring the editor, whose blur-cancel
  // unmounted it — "New section…" appeared to do nothing. jsdom cannot fully
  // reproduce the native focus-restore race, so this asserts the observable
  // outcome (editor survives the menu close AND holds focus); the guard's
  // prevent-once contract is pinned in use-menu-close-focus-guard.test.ts.
  it('keeps the inline group-create editor alive and focused after "New section…" closes the menu', () => {
    render(<InlineCreateHarness />);
    openRowMenu();
    openMoveToGroupSubmenu();
    fireEvent.click(screen.getByText('New section…'));

    const input = screen.getByLabelText('New section name');
    expect(input).toBeInTheDocument();
    // Focus must remain on the editor — a restored-to-trigger focus is exactly
    // the state that killed it (blur-cancel).
    expect(document.activeElement).toBe(input);
    // The menu itself is gone (the guard suppresses focus restore, not closing).
    expect(screen.queryByText('Move to section')).not.toBeInTheDocument();
  });

  it('"Move to section → <other group>" commits moveToGroup(ref, groupId)', () => {
    render(<InlineCreateHarness />);
    openRowMenu();
    openMoveToGroupSubmenu();
    fireEvent.click(screen.getByText('Experiments'));

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    mockUpdate.mock.calls[0]![0]({ groups });
    expect(moveToGroupCalls).toEqual([[{ groups }, API_SERVER, 'g2']]);
  });

  it('"Remove from section" commits moveToGroup(ref, null)', () => {
    render(<InlineCreateHarness />);
    openRowMenu();
    openMoveToGroupSubmenu();
    fireEvent.click(screen.getByText('Remove from section'));

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    mockUpdate.mock.calls[0]![0]({ groups });
    expect(moveToGroupCalls).toEqual([[{ groups }, API_SERVER, null]]);
  });

  it('"Mute agent" commits muteItem(ref)', () => {
    render(<InlineCreateHarness />);
    openRowMenu();
    fireEvent.click(screen.getByText('Mute agent'));

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    mockUpdate.mock.calls[0]![0]({ groups });
    expect(muteItemCalls).toEqual([[{ groups }, API_SERVER]]);
  });

  it('"Unmute agent" commits unmuteItem(ref) when already muted', () => {
    mockMuted = [API_SERVER];
    render(<InlineCreateHarness />);
    openRowMenu();
    expect(screen.getByText('Unmute agent')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Unmute agent'));

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    mockUpdate.mock.calls[0]![0]({ groups });
    expect(unmuteItemCalls).toEqual([[{ groups }, API_SERVER]]);
  });
});
