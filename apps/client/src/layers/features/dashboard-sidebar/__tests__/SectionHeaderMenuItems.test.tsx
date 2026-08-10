// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {
  buildAgentsHeaderMenuNodes,
  buildChannelsHeaderMenuNodes,
  buildDirectMessagesHeaderMenuNodes,
  type AgentsHeaderMenuModel,
  type ChannelsHeaderMenuModel,
  type DirectMessagesHeaderMenuModel,
  type SectionHeaderMenuNode,
} from '../ui/SectionHeaderMenuItems';
import { SectionHeader } from '@/layers/shared/ui';

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
// Models with every callback stubbed, so a test names only what it varies.
// ---------------------------------------------------------------------------

function channels(overrides: Partial<ChannelsHeaderMenuModel> = {}): ChannelsHeaderMenuModel {
  return {
    collapsed: false,
    hasUnread: false,
    onMarkAllRead: vi.fn(),
    onToggleCollapsed: vi.fn(),
    ...overrides,
  };
}

function dms(
  overrides: Partial<DirectMessagesHeaderMenuModel> = {}
): DirectMessagesHeaderMenuModel {
  return {
    collapsed: false,
    hasUnread: false,
    onMarkAllRead: vi.fn(),
    onToggleCollapsed: vi.fn(),
    ...overrides,
  };
}

function agents(overrides: Partial<AgentsHeaderMenuModel> = {}): AgentsHeaderMenuModel {
  return {
    sortMode: 'name',
    displayFilter: 'all',
    onSortModeChange: vi.fn(),
    onDisplayFilterChange: vi.fn(),
    ...overrides,
  };
}

/** Every node's id, separators included, in order. */
function ids(nodes: SectionHeaderMenuNode[]): string[] {
  return nodes.map((node) => node.id);
}

/** Find one action node, or fail loudly. */
function action(nodes: SectionHeaderMenuNode[], id: string) {
  const node = nodes.find((n) => n.kind !== 'separator' && n.id === id);
  if (node?.kind !== 'action') throw new Error(`no action node "${id}"`);
  return node;
}

/** Find one radio submenu node, or fail loudly. */
function submenu(nodes: SectionHeaderMenuNode[], id: string) {
  const node = nodes.find((n) => n.kind !== 'separator' && n.id === id);
  if (node?.kind !== 'radio') throw new Error(`no submenu node "${id}"`);
  return node;
}

// ---------------------------------------------------------------------------
// The pure item lists
// ---------------------------------------------------------------------------

describe('section header item lists', () => {
  it('offers a caught-up Channels header exactly these items, in this order', () => {
    // No 'new-channel': the New menu is the only create surface, and this
    // section's "+" deep-links into it (BC-45).
    expect(ids(buildChannelsHeaderMenuNodes(channels()))).toEqual(['collapse']);
  });

  it('adds Mark all channels read, and its separator, only when a channel is behind', () => {
    expect(ids(buildChannelsHeaderMenuNodes(channels({ hasUnread: true })))).toEqual([
      'mark-all-read',
      'sep-unread',
      'collapse',
    ]);
  });

  it('gives Direct messages the same shape as Channels, with its own nouns', () => {
    const dmNodes = buildDirectMessagesHeaderMenuNodes(dms({ hasUnread: true }));
    expect(ids(dmNodes)).toEqual(['mark-all-read', 'sep-unread', 'collapse']);
    expect(action(dmNodes, 'mark-all-read').label).toBe('Mark all read');
    expect(
      action(buildChannelsHeaderMenuNodes(channels({ hasUnread: true })), 'mark-all-read').label
    ).toBe('Mark all channels read');
  });

  it('puts Show before Sort by on the Agents header, matching a group header', () => {
    // The audit rule from spec §14.1: where a verb already exists, it keeps its
    // label AND its relative position. GroupHeader shows the display filter
    // above the sort submenu, so this one does too.
    expect(ids(buildAgentsHeaderMenuNodes(agents()))).toEqual(['display', 'sort']);
  });

  it('names the collapse item for what choosing it will do', () => {
    expect(
      action(buildChannelsHeaderMenuNodes(channels({ collapsed: false })), 'collapse')
    ).toMatchObject({ label: 'Collapse' });
    expect(
      action(buildChannelsHeaderMenuNodes(channels({ collapsed: true })), 'collapse')
    ).toMatchObject({ label: 'Expand' });
  });

  it('carries no trailing ellipsis in a label — that is the renderer’s to add', () => {
    const labels = [
      ...buildChannelsHeaderMenuNodes(channels({ hasUnread: true })),
      ...buildDirectMessagesHeaderMenuNodes(dms({ hasUnread: true })),
      ...buildAgentsHeaderMenuNodes(agents()),
    ]
      .filter((node) => node.kind === 'action' || node.kind === 'radio')
      .map((node) => node.label);
    expect(labels.some((label) => label.endsWith('…'))).toBe(false);
  });

  it('asks for no further input anywhere — every remaining item acts at once', () => {
    const opening = [
      ...buildChannelsHeaderMenuNodes(channels({ hasUnread: true })),
      ...buildDirectMessagesHeaderMenuNodes(dms({ hasUnread: true })),
      ...buildAgentsHeaderMenuNodes(agents()),
    ]
      .filter((node) => node.kind === 'action' && node.opensInput)
      .map((node) => node.id);
    // Everything that used to open a dialog from a header — New channel, New
    // message, New agent, New group — moved into the New menu (BC-45). What is
    // left clears unread or folds a list, and neither asks a question.
    expect(opening).toEqual([]);
  });

  it('withholds Manual from the Agents sort submenu, which has no hand order', () => {
    const sort = submenu(buildAgentsHeaderMenuNodes(agents()), 'sort');
    expect(sort.label).toBe('Sort by');
    expect(sort.options).toEqual([
      { value: 'recent', label: 'Recent activity' },
      { value: 'name', label: 'Name' },
    ]);
  });

  it('offers the Agents display filter the same three choices a group header does', () => {
    const display = submenu(buildAgentsHeaderMenuNodes(agents()), 'display');
    expect(display.label).toBe('Show');
    expect(display.options).toEqual([
      { value: 'all', label: 'All' },
      { value: 'active', label: 'Active' },
      { value: 'attention', label: 'Needs attention' },
    ]);
  });

  it('reflects the section’s stored settings as the submenu values', () => {
    const nodes = buildAgentsHeaderMenuNodes(
      agents({ sortMode: 'recent', displayFilter: 'attention' })
    );
    expect(submenu(nodes, 'sort').value).toBe('recent');
    expect(submenu(nodes, 'display').value).toBe('attention');
  });

  it('runs the real handler behind every item', () => {
    const onMarkAllRead = vi.fn();
    const onToggleCollapsed = vi.fn();
    const channelNodes = buildChannelsHeaderMenuNodes(
      channels({ hasUnread: true, onMarkAllRead, onToggleCollapsed })
    );
    action(channelNodes, 'mark-all-read').run();
    action(channelNodes, 'collapse').run();
    expect(onMarkAllRead).toHaveBeenCalledOnce();
    expect(onToggleCollapsed).toHaveBeenCalledOnce();

    const onDmMarkAllRead = vi.fn();
    action(
      buildDirectMessagesHeaderMenuNodes(dms({ hasUnread: true, onMarkAllRead: onDmMarkAllRead })),
      'mark-all-read'
    ).run();
    expect(onDmMarkAllRead).toHaveBeenCalledOnce();
  });

  it('writes a chosen sort mode and display filter back to the section', () => {
    const onSortModeChange = vi.fn();
    const onDisplayFilterChange = vi.fn();
    const nodes = buildAgentsHeaderMenuNodes(agents({ onSortModeChange, onDisplayFilterChange }));
    submenu(nodes, 'sort').onChange('recent');
    submenu(nodes, 'display').onChange('attention');
    expect(onSortModeChange).toHaveBeenCalledWith('recent');
    expect(onDisplayFilterChange).toHaveBeenCalledWith('attention');
  });
});

// ---------------------------------------------------------------------------
// Both render paths, from one list
// ---------------------------------------------------------------------------

/** The three roles a section-header menu is made of. Separators included. */
const MENU_NODES = '[role="menuitem"],[role="menuitemradio"],[role="separator"]';

/**
 * One node as `role:label`, with its checked state when it has one.
 *
 * A string rather than an object so a whole surface reads as a sequence in the
 * failure diff — the thing being asserted here is an order.
 */
function nodeShape(el: Element): string {
  const role = el.getAttribute('role') ?? '';
  const label = el.textContent?.trim() ?? '';
  const checked = el.getAttribute('aria-checked');
  return checked === null ? `${role}:${label}` : `${role}:${label}:${checked}`;
}

/**
 * Every open menu surface, each as its OWN node list in DOM order.
 *
 * **Order and separators are half of what the two menus have to agree on**, so
 * both are collected. A set of labels sorted alphabetically cannot tell "make,
 * then clear, then how this looks" from the same items in any other sequence,
 * and cannot tell a menu with its rules from one without them — both are drift
 * this file exists to catch, and both got past the sorted-label version.
 *
 * Order WITHIN a surface is asserted; order BETWEEN surfaces is not, because
 * that one is a portal artifact and says nothing about what the section offers:
 * the dropdown renders an open submenu inline after its trigger, while the
 * context menu portals it to the end of the document. Surfaces are therefore
 * keyed by their own contents and compared as a set of ordered lists.
 */
function collectSurfaces(): string[][] {
  return [...document.querySelectorAll('[role="menu"]')]
    .map((menu) =>
      [...menu.querySelectorAll(MENU_NODES)]
        // A nested submenu's nodes belong to that submenu, not to this one.
        .filter((el) => el.closest('[role="menu"]') === menu)
        .map(nodeShape)
    )
    .filter((nodes) => nodes.length > 0);
}

/** Surfaces in a stable order, so two collections compare directly. */
function sortSurfaces(surfaces: string[][]): string[][] {
  return [...surfaces].sort((a, b) => a.join('|').localeCompare(b.join('|')));
}

/** Open a submenu via the Radix LTR sub-open key. */
function openSubmenu(label: string) {
  fireEvent.keyDown(screen.getByText(label), { key: 'ArrowRight' });
}

/**
 * Every surface of an open menu, submenus included.
 *
 * Swept once per submenu and unioned, because Radix keeps at most one submenu
 * open: opening the second closes the first, so a single sweep at the end would
 * only ever see the last one. The union is keyed on a surface's whole ordered
 * contents, so a surface whose items moved is a different surface rather than
 * the same one seen twice.
 */
function fullMenuTree(subLabels: string[] = []): string[][] {
  const seen = new Map<string, string[]>();
  const sweep = () => collectSurfaces().forEach((nodes) => seen.set(nodes.join('|'), nodes));
  sweep();
  for (const label of subLabels) {
    openSubmenu(label);
    sweep();
  }
  return sortSurfaces([...seen.values()]);
}

function header(nodes: SectionHeaderMenuNode[]) {
  return <SectionHeader label="Agents" nodes={nodes} collapsed={false} onToggle={() => {}} />;
}

describe('SectionHeader variant parity', () => {
  it('renders the identical item tree from the right-click menu and the "…" menu', () => {
    const nodes = buildAgentsHeaderMenuNodes(agents({ sortMode: 'recent' }));

    // Right-click the header itself.
    render(header(nodes));
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Agents' }));
    const contextTree = fullMenuTree(['Show', 'Sort by']);
    cleanup();

    // The "…" button beside it.
    render(header(nodes));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Agents section actions' }));
    const dropdownTree = fullMenuTree(['Show', 'Sort by']);

    // Same surfaces, same nodes, same order, same checked states — one list,
    // two renderers.
    expect(contextTree).toEqual(dropdownTree);
    // Written out in full: the two settings, and nothing that makes anything —
    // the Agents header's creates moved to the New menu (BC-45). The stored
    // sort mode carries the dot; the other option does not.
    expect(contextTree).toEqual(
      sortSurfaces([
        ['menuitem:Show', 'menuitem:Sort by'],
        [
          'menuitemradio:All:true',
          'menuitemradio:Active:false',
          'menuitemradio:Needs attention:false',
        ],
        ['menuitemradio:Recent activity:true', 'menuitemradio:Name:false'],
      ])
    );
  });

  it('renders the same items for a room section from either menu', () => {
    const nodes = buildChannelsHeaderMenuNodes(channels({ hasUnread: true }));

    render(<SectionHeader label="Channels" nodes={nodes} collapsed={false} onToggle={() => {}} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Channels' }));
    const contextTree = collectSurfaces();
    cleanup();

    render(<SectionHeader label="Channels" nodes={nodes} collapsed={false} onToggle={() => {}} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Channels section actions' }));
    const dropdownTree = collectSurfaces();

    expect(contextTree).toEqual(dropdownTree);
    // Both rules included: they are what separates what you can make from what
    // you can clear from what the section looks like.
    expect(contextTree).toEqual([
      ['menuitem:Mark all channels read', 'separator:', 'menuitem:Collapse'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Reachability and wiring through the header itself
// ---------------------------------------------------------------------------

describe('SectionHeader', () => {
  it('gives the "…" a name and keyboard focus, so the menu opens without a pointer', () => {
    render(header(buildAgentsHeaderMenuNodes(agents())));

    const trigger = screen.getByRole('button', { name: 'Agents section actions' });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    // Enter on a focused Radix trigger is a keydown, not a click.
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(screen.getByRole('menuitem', { name: 'Show' })).toBeInTheDocument();
  });

  it('reveals the "…" on focus, not only on hover — a keyboard has no hover', () => {
    render(header(buildAgentsHeaderMenuNodes(agents())));
    expect(screen.getByRole('button', { name: 'Agents section actions' }).className).toContain(
      'focus-visible:opacity-100'
    );
  });

  it('runs the chosen item’s handler', () => {
    const onMarkAllRead = vi.fn();
    render(
      <SectionHeader
        label="Channels"
        collapsed={false}
        onToggle={() => {}}
        nodes={buildChannelsHeaderMenuNodes(channels({ hasUnread: true, onMarkAllRead }))}
      />
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Channels section actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark all channels read' }));

    expect(onMarkAllRead).toHaveBeenCalledOnce();
  });

  it('collapses from the name button as well as from the menu', () => {
    const onToggle = vi.fn();
    const onToggleCollapsed = vi.fn();
    render(
      <SectionHeader
        label="Channels"
        collapsed={false}
        onToggle={onToggle}
        nodes={buildChannelsHeaderMenuNodes(channels({ onToggleCollapsed }))}
      />
    );

    const name = screen.getByRole('button', { name: 'Channels' });
    expect(name).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(name);
    expect(onToggle).toHaveBeenCalledOnce();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Channels section actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Collapse' }));
    expect(onToggleCollapsed).toHaveBeenCalledOnce();
  });

  it('renders a section that cannot collapse as a plain label with the same menus', () => {
    render(<SectionHeader label="Agents" nodes={buildAgentsHeaderMenuNodes(agents())} />);

    expect(screen.queryByRole('button', { name: 'Agents' })).not.toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Agents section actions' }));
    expect(screen.getByRole('menuitem', { name: 'Show' })).toBeInTheDocument();
  });
});
