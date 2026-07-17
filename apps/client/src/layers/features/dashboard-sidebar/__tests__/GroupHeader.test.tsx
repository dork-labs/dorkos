// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { SidebarGroup, SidebarPrefs } from '@dorkos/shared/config-schema';
import { GroupHeader } from '../ui/GroupHeader';

// ---------------------------------------------------------------------------
// Mocks — capture which pure helper each committed updater invokes.
// ---------------------------------------------------------------------------

const mockUpdate = vi.fn<(updater: (prev: SidebarPrefs) => SidebarPrefs) => void>();
const helperCalls: { name: string; args: unknown[] }[] = [];

vi.mock('@/layers/entities/config', () => ({
  useUpdateSidebarPrefs: () => ({
    update: mockUpdate,
    updateAsync: vi.fn(),
    isPending: false,
    isError: false,
  }),
  renameGroup: (...args: unknown[]) => {
    helperCalls.push({ name: 'renameGroup', args });
    return args[0];
  },
  deleteGroup: (...args: unknown[]) => {
    helperCalls.push({ name: 'deleteGroup', args });
    return args[0];
  },
  setGroupSortMode: (...args: unknown[]) => {
    helperCalls.push({ name: 'setGroupSortMode', args });
    return args[0];
  },
  setGroupCollapsed: (...args: unknown[]) => {
    helperCalls.push({ name: 'setGroupCollapsed', args });
    return args[0];
  },
}));

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PREV = { groups: [] } as unknown as SidebarPrefs;

function makeGroup(overrides: Partial<SidebarGroup> = {}): SidebarGroup {
  return {
    id: 'g1',
    name: 'Clients',
    agentPaths: [],
    sortMode: 'manual',
    collapsed: false,
    ...overrides,
  };
}

function renderHeader({
  group = makeGroup(),
  memberCount = 0,
  showActivityDot = false,
}: {
  group?: SidebarGroup;
  memberCount?: number;
  showActivityDot?: boolean;
} = {}) {
  render(<GroupHeader group={group} memberCount={memberCount} showActivityDot={showActivityDot} />);
  return { group };
}

/** Apply the latest committed updater and return the helper calls it made. */
function applyLatestUpdater() {
  const updater = mockUpdate.mock.calls.at(-1)?.[0];
  if (!updater) throw new Error('no update committed');
  helperCalls.length = 0;
  updater(PREV);
  return helperCalls;
}

/** Open the header's right-click menu (same shared items as the "…" dropdown). */
function openContextMenu() {
  fireEvent.contextMenu(screen.getByText('Clients'));
}

describe('GroupHeader', () => {
  beforeEach(() => {
    mockUpdate.mockReset();
    helperCalls.length = 0;
  });

  // --- Collapse ---

  it('toggles collapse via setGroupCollapsed when the name button is clicked', () => {
    renderHeader({ group: makeGroup({ collapsed: false }) });
    fireEvent.click(screen.getByText('Clients'));
    const calls = applyLatestUpdater();
    expect(calls).toEqual([{ name: 'setGroupCollapsed', args: [PREV, 'g1', true] }]);
  });

  // --- Activity dot ---

  it('renders the activity dot only when showActivityDot is set', () => {
    renderHeader({ showActivityDot: true });
    expect(screen.getByLabelText('Active work in this group')).toBeInTheDocument();
    cleanup();
    renderHeader({ showActivityDot: false });
    expect(screen.queryByLabelText('Active work in this group')).not.toBeInTheDocument();
  });

  // --- Inline rename ---

  it('renames inline: Rename swaps to an input, Enter commits via renameGroup', () => {
    renderHeader();
    openContextMenu();
    fireEvent.click(screen.getByText('Rename'));

    const input = screen.getByLabelText('Group name');
    expect(input).toHaveValue('Clients');
    fireEvent.change(input, { target: { value: '  Acme Corp  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const calls = applyLatestUpdater();
    expect(calls).toEqual([{ name: 'renameGroup', args: [PREV, 'g1', 'Acme Corp'] }]);
    // Input closed, label restored.
    expect(screen.queryByLabelText('Group name')).not.toBeInTheDocument();
  });

  it('rename Esc cancels without writing', () => {
    renderHeader();
    openContextMenu();
    fireEvent.click(screen.getByText('Rename'));
    const input = screen.getByLabelText('Group name');
    fireEvent.change(input, { target: { value: 'Different' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Group name')).not.toBeInTheDocument();
  });

  it('rename does not write when the name is unchanged or empty', () => {
    renderHeader();
    openContextMenu();
    fireEvent.click(screen.getByText('Rename'));
    const input = screen.getByLabelText('Group name');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  // --- Sort by ---

  it('Sort by radio calls setGroupSortMode with the chosen mode', () => {
    renderHeader({ group: makeGroup({ sortMode: 'manual' }) });
    openContextMenu();
    // Open the "Sort by" submenu via keyboard (Radix LTR sub-open key).
    const subTrigger = screen.getByText('Sort by');
    fireEvent.keyDown(subTrigger, { key: 'ArrowRight' });
    fireEvent.click(screen.getByText('Recent activity'));

    const calls = applyLatestUpdater();
    expect(calls).toEqual([{ name: 'setGroupSortMode', args: [PREV, 'g1', 'recent'] }]);
  });

  // --- Delete ---

  it('deletes an empty group immediately without a dialog', () => {
    renderHeader({ memberCount: 0 });
    openContextMenu();
    fireEvent.click(screen.getByText('Delete group'));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    const calls = applyLatestUpdater();
    expect(calls).toEqual([{ name: 'deleteGroup', args: [PREV, 'g1'] }]);
  });

  it('opens the AlertDialog with the exact task copy for a non-empty group', () => {
    renderHeader({ memberCount: 3 });
    openContextMenu();
    fireEvent.click(screen.getByText('Delete group'));

    // No write yet — the dialog gates it.
    expect(mockUpdate).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toBeInTheDocument();
    // Exact copy from task 2.4 (typographic quotes around the name).
    expect(screen.getByText('Delete group “Clients”?')).toBeInTheDocument();
    expect(
      screen.getByText('Its 3 agents move back to Agents. Nothing is deleted.')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete group' }));
    const calls = applyLatestUpdater();
    expect(calls).toEqual([{ name: 'deleteGroup', args: [PREV, 'g1'] }]);
  });

  it('Cancel in the delete dialog writes nothing', () => {
    renderHeader({ memberCount: 2 });
    openContextMenu();
    fireEvent.click(screen.getByText('Delete group'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  // --- Menu parity ---

  it('the "…" dropdown and the right-click menu expose the same actions', () => {
    renderHeader();
    // Context menu items
    openContextMenu();
    for (const label of ['Rename', 'Sort by', 'Delete group']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    fireEvent.keyDown(document.body, { key: 'Escape' });

    // "…" dropdown items
    fireEvent.pointerDown(screen.getByLabelText('Clients group actions'));
    fireEvent.click(screen.getByLabelText('Clients group actions'));
    for (const label of ['Rename', 'Sort by', 'Delete group']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});
