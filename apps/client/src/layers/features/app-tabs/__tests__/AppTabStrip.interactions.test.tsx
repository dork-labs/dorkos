/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider, type AppTab } from '@/layers/shared/model';
import { AppTabStrip } from '../ui/AppTabStrip';
import type { AppTabMenuActions } from '../ui/AppTabContextMenu';

const transport = createMockTransport();

function Wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

function tab(id: string, href: string, pinned = false): AppTab {
  return { id, href, history: [href], cursor: 0, ...(pinned && { pinned }) };
}

const HOME = tab('home', '/', true);
const ACTIVITY = tab('activity', '/activity');
const SCHEDULES = tab('schedules', '/tasks');

const onActivate = vi.fn();
const onClose = vi.fn();
const onReorder = vi.fn();
const menu: AppTabMenuActions = {
  togglePin: vi.fn(),
  duplicate: vi.fn(),
  copyLink: vi.fn(),
  closeOthers: vi.fn(),
  close: vi.fn(),
};

function renderStrip(
  tabs: AppTab[],
  { withMenu = true, activeId = tabs[tabs.length - 1].id } = {}
) {
  return render(
    <AppTabStrip
      tabs={tabs}
      activeId={activeId}
      onActivate={onActivate}
      onClose={onClose}
      onCreate={vi.fn()}
      menu={withMenu ? menu : undefined}
      onReorder={onReorder}
    />,
    { wrapper: Wrapper }
  );
}

/** The menu's items as a person reads them, disabled ones marked. */
function menuItems(): string[] {
  return within(screen.getByRole('menu'))
    .getAllByRole('menuitem')
    .map((item) => `${item.textContent}${item.hasAttribute('data-disabled') ? ' (off)' : ''}`);
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('pinned tabs', () => {
  it('draw icon-only, with the name kept in the accessible name and the tooltip', () => {
    renderStrip([HOME, ACTIVITY]);
    const pinned = screen.getByRole('tab', { name: 'Home' });
    expect(pinned).toHaveAttribute('title', 'Home');
    // The name is there for a screen reader, not on screen.
    expect(within(pinned).getByText('Home').closest('.sr-only')).not.toBeNull();
    // An unpinned tab keeps its visible name and has no tooltip of its own.
    expect(screen.getByRole('tab', { name: 'Activity' })).not.toHaveAttribute('title');
  });

  it('offer no close control, even when other tabs can close', () => {
    renderStrip([HOME, ACTIVITY]);
    expect(screen.queryByRole('button', { name: 'Close Home' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close Activity' })).toBeInTheDocument();
  });
});

describe('the tab menu', () => {
  it('opens on right-click with Pin, Duplicate, Copy link, Close others and Close', () => {
    renderStrip([HOME, ACTIVITY, SCHEDULES]);
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Activity' }));
    expect(menuItems()).toEqual(['Pin', 'Duplicate', 'Copy link', 'Close others', 'Close']);
  });

  it('says Unpin on a pinned tab', () => {
    renderStrip([HOME, ACTIVITY]);
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Home' }));
    expect(menuItems()[0]).toBe('Unpin');
  });

  it.each([
    ['Pin', 'togglePin'],
    ['Duplicate', 'duplicate'],
    ['Copy link', 'copyLink'],
    ['Close others', 'closeOthers'],
    ['Close', 'close'],
  ] as const)('"%s" acts on the tab it was opened on', (label, action) => {
    renderStrip([HOME, ACTIVITY, SCHEDULES]);
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Activity' }));
    fireEvent.click(screen.getByRole('menuitem', { name: label }));
    expect(menu[action]).toHaveBeenCalledWith('activity');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('turns off "Close others" when every other tab is pinned', () => {
    renderStrip([HOME, ACTIVITY]);
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Activity' }));
    expect(menuItems()).toContain('Close others (off)');
  });

  it('turns off "Close" on the last tab', () => {
    renderStrip([ACTIVITY]);
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Activity' }));
    expect(menuItems()).toContain('Close (off)');
  });

  it.each([
    ['Shift+F10', { key: 'F10', shiftKey: true }],
    ['the context-menu key', { key: 'ContextMenu' }],
  ])('opens from the keyboard with %s', (_name, key) => {
    renderStrip([HOME, ACTIVITY]);
    const activity = screen.getByRole('tab', { name: 'Activity' });
    activity.focus();
    fireEvent.keyDown(activity, key);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    // The keys open the menu and nothing else: no tab switch, no close.
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('is not there when the strip is given no menu actions', () => {
    renderStrip([HOME, ACTIVITY], { withMenu: false });
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Activity' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('drag to reorder', () => {
  it('tells a screen reader how to move a tab', () => {
    renderStrip([HOME, ACTIVITY]);
    const activity = screen.getByRole('tab', { name: 'Activity' });
    const describedBy = activity.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toMatch(
      /To move this tab, press Space/
    );
    // Still announced as a tab, not as dnd-kit's "sortable".
    expect(activity).not.toHaveAttribute('aria-roledescription');
  });

  it('keeps arrow-key tab switching while no tab is lifted', () => {
    renderStrip([HOME, ACTIVITY, SCHEDULES], { activeId: 'activity' });
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Activity' }), { key: 'ArrowRight' });
    expect(onActivate).toHaveBeenCalledWith('schedules', 'keyboard');
  });

  it('lifts a tab on Space, and then the arrows stop switching tabs', () => {
    renderStrip([HOME, ACTIVITY, SCHEDULES], { activeId: 'activity' });
    const activity = screen.getByRole('tab', { name: 'Activity' });
    activity.focus();
    fireEvent.keyDown(activity, { key: ' ', code: 'Space' });
    fireEvent.keyDown(activity, { key: 'ArrowRight', code: 'ArrowRight' });
    expect(onActivate).not.toHaveBeenCalled();
    fireEvent.keyDown(activity, { key: 'Escape', code: 'Escape' });
  });

  it('is off when the strip is given no onReorder', () => {
    render(
      <AppTabStrip
        tabs={[HOME, ACTIVITY]}
        activeId="activity"
        onActivate={onActivate}
        onClose={onClose}
        onCreate={vi.fn()}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getByRole('tab', { name: 'Activity' })).not.toHaveAttribute('aria-describedby');
  });
});
