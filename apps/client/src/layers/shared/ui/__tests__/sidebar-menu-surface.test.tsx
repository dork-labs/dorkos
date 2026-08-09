/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ArrowUpDown, FolderInput, Pencil, Trash2 } from 'lucide-react';
import { SidebarMenuSurface, type SidebarMenuNode } from '../sidebar-menu-node';

// Radix menus rely on pointer events and ResizeObserver — mock both for jsdom.
beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

afterEach(() => cleanup());

const onRename = vi.fn();
const onMove = vi.fn();
const onSort = vi.fn();
const onDelete = vi.fn();

/** A list exercising every node kind the walk knows how to render. */
function nodes(): SidebarMenuNode[] {
  return [
    {
      kind: 'action',
      id: 'rename',
      label: 'Rename',
      icon: Pencil,
      opensInput: true,
      run: onRename,
    },
    {
      kind: 'submenu',
      id: 'move',
      label: 'Move to group',
      icon: FolderInput,
      items: [
        { kind: 'choice', id: 'g1', label: 'Clients', checked: true, run: onMove },
        { kind: 'choice', id: 'g2', label: 'Experiments', checked: false, run: onMove },
      ],
    },
    {
      kind: 'radio',
      id: 'sort',
      label: 'Sort by',
      icon: ArrowUpDown,
      value: 'name',
      options: [
        { value: 'name', label: 'Name' },
        { value: 'recent', label: 'Recent activity' },
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
      run: onDelete,
    },
  ];
}

/** Every visible item across the whole open menu tree: name, role, checked state. */
function collectMenuTree() {
  return [
    ...screen.queryAllByRole('menuitem'),
    ...screen.queryAllByRole('menuitemcheckbox'),
    ...screen.queryAllByRole('menuitemradio'),
  ]
    .map((el) => ({
      label: el.textContent?.trim() ?? '',
      role: el.getAttribute('role') ?? '',
      checked: el.getAttribute('aria-checked'),
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.role.localeCompare(b.role));
}

/** Walk into both submenus, which Radix opens on the LTR sub-open key. */
function openSubmenus() {
  fireEvent.keyDown(screen.getByText('Move to group'), { key: 'ArrowRight' });
  fireEvent.keyDown(screen.getByText('Sort by'), { key: 'ArrowRight' });
}

function renderSurface(list: SidebarMenuNode[] = nodes()) {
  return render(
    <SidebarMenuSurface nodes={list} actionsLabel="Clients group actions">
      <div data-testid="target">a row</div>
    </SidebarMenuSurface>
  );
}

describe('SidebarMenuSurface', () => {
  it('renders its children with no menu open', () => {
    renderSurface();
    expect(screen.getByTestId('target')).toBeInTheDocument();
    expect(screen.queryByText('Rename…')).not.toBeInTheDocument();
  });

  it('opens the same menu from a right-click and from the ⋮', () => {
    // The whole point of the primitive: one node list, two Radix families, and
    // no way for them to offer different things. Compares the ACTION SETS, not
    // merely that both are non-empty — a renderer that dropped the submenu from
    // one side would still pass the weaker assertion.
    const ctx = renderSurface();
    fireEvent.contextMenu(screen.getByTestId('target'));
    openSubmenus();
    const contextTree = collectMenuTree();
    expect(contextTree.length).toBeGreaterThan(0);
    ctx.unmount();
    cleanup();

    renderSurface();
    const kebab = screen.getByLabelText('Clients group actions');
    fireEvent.pointerDown(kebab);
    fireEvent.click(kebab);
    openSubmenus();

    expect(collectMenuTree()).toEqual(contextTree);
  });

  it('appends the ellipsis from opensInput rather than from the label', () => {
    renderSurface();
    fireEvent.contextMenu(screen.getByTestId('target'));
    // `rename` carries `opensInput`; `delete` does not.
    expect(screen.getByText('Rename…')).toBeInTheDocument();
    expect(screen.getByText('Delete group')).toBeInTheDocument();
  });

  it('runs the chosen item’s handler', () => {
    renderSurface();
    fireEvent.contextMenu(screen.getByTestId('target'));
    fireEvent.click(screen.getByText('Rename…'));
    expect(onRename).toHaveBeenCalled();
  });

  it('reveals the ⋮ on focus-visible, not only on hover — a keyboard has no hover', () => {
    // WCAG (spec R2): hover-revealed chrome always has a second, non-pointer
    // path. The class list is the assertion because jsdom computes no hover.
    renderSurface();
    const kebab = screen.getByLabelText('Clients group actions');
    expect(kebab.className).toContain('opacity-0');
    expect(kebab.className).toContain('group-hover/sidebar-menu:opacity-100');
    expect(kebab.className).toContain('focus-visible:opacity-100');
  });

  it('renders no menus at all for an empty node list', () => {
    // A surface with nothing to offer must not grow a control that opens an
    // empty box — the Pinned header is exactly this case.
    renderSurface([]);
    expect(screen.getByTestId('target')).toBeInTheDocument();
    expect(screen.queryByLabelText('Clients group actions')).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByTestId('target'));
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });
});
