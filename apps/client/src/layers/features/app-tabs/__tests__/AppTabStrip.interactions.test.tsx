/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, cleanup, within, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import {
  TransportProvider,
  closeOtherTabsIn,
  closeTabIn,
  duplicateTabIn,
  type AppTab,
  type AppTabsLayout,
} from '@/layers/shared/model';
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
  it('draw icon-only, with the name kept in the accessible name', () => {
    renderStrip([HOME, ACTIVITY]);
    // The name is there for a screen reader, not on screen; the hover card
    // carries it for the eye.
    const pinned = screen.getByRole('tab', { name: 'Home' });
    expect(within(pinned).queryByText('Home')).toBeNull();
    // An unpinned tab keeps its visible name.
    expect(
      within(screen.getByRole('tab', { name: 'Activity' })).getByText('Activity')
    ).toBeInTheDocument();
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
      /Press Space to move this tab/
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

/** The strip over real state, arranged by the store's own transitions. */
function LiveStrip({ initial, activeId }: { initial: AppTab[]; activeId: string }) {
  const [layout, setLayout] = useState<AppTabsLayout>({ tabs: initial, activeTabId: activeId });
  return (
    <AppTabStrip
      tabs={layout.tabs}
      activeId={layout.activeTabId}
      onActivate={(id) => setLayout((current) => ({ ...current, activeTabId: id }))}
      onClose={(id) => setLayout((current) => closeTabIn(current, id))}
      onCreate={vi.fn()}
      menu={{
        ...menu,
        duplicate: (id) => setLayout((current) => duplicateTabIn(current, id)),
        closeOthers: (id) => setLayout((current) => closeOtherTabsIn(current, id)),
        close: (id) => setLayout((current) => closeTabIn(current, id)),
      }}
    />
  );
}

describe('focus after a menu action', () => {
  it.each(['Close', 'Duplicate', 'Close others'])(
    '"%s" from the keyboard leaves focus on the tab now on screen',
    async (label) => {
      render(<LiveStrip initial={[HOME, ACTIVITY, SCHEDULES]} activeId="activity" />, {
        wrapper: Wrapper,
      });
      const activity = screen.getByRole('tab', { name: 'Activity' });
      activity.focus();
      fireEvent.keyDown(activity, { key: 'F10', shiftKey: true });
      fireEvent.click(screen.getByRole('menuitem', { name: label }));
      await waitFor(() => {
        const selected = screen
          .getAllByRole('tab')
          .find((tab) => tab.getAttribute('aria-selected') === 'true');
        expect(document.activeElement).toBe(selected);
      });
      expect(document.activeElement).not.toBe(document.body);
    }
  );
});

describe('a finished keyboard drag', () => {
  // jsdom lays nothing out, so give each tab a 100px slot in strip order.
  let restore: () => void;
  beforeEach(() => {
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const holder = this.closest('[data-app-tab-id]');
      const all = Array.from(document.querySelectorAll('[data-app-tab-id]'));
      const index = holder ? all.indexOf(holder) : -1;
      const left = index === -1 ? 0 : index * 100;
      const width = index === -1 ? 1000 : 100;
      return {
        left,
        right: left + width,
        top: 0,
        bottom: 30,
        width,
        height: 30,
        x: left,
        y: 0,
        toJSON() {},
      } as DOMRect;
    };
    restore = () => {
      Element.prototype.getBoundingClientRect = original;
    };
  });
  afterEach(() => restore());

  it('reorders: Space, ArrowRight, Space moves the tab one place right', async () => {
    renderStrip([HOME, ACTIVITY, SCHEDULES], { activeId: 'activity' });
    const activity = screen.getByRole('tab', { name: 'Activity' });
    activity.focus();
    await act(async () => {
      fireEvent.keyDown(activity, { key: ' ', code: 'Space' });
    });
    await act(async () => {
      fireEvent.keyDown(activity, { key: 'ArrowRight', code: 'ArrowRight' });
    });
    await act(async () => {
      fireEvent.keyDown(activity, { key: ' ', code: 'Space' });
    });
    await waitFor(() => expect(onReorder).toHaveBeenCalledWith(1, 2));
  });

  it('will not move the first unpinned tab into the pinned ones', async () => {
    renderStrip([HOME, ACTIVITY, SCHEDULES], { activeId: 'activity' });
    const activity = screen.getByRole('tab', { name: 'Activity' });
    activity.focus();
    await act(async () => {
      fireEvent.keyDown(activity, { key: ' ', code: 'Space' });
    });
    await act(async () => {
      fireEvent.keyDown(activity, { key: 'ArrowLeft', code: 'ArrowLeft' });
    });
    // Not even drawn among them: the lifted tab has not moved left.
    const holder = activity.closest<HTMLElement>('[data-app-tab-id]')!;
    expect(holder.style.transform).not.toMatch(/translate3d\(-/);
    await act(async () => {
      fireEvent.keyDown(activity, { key: ' ', code: 'Space' });
    });
    expect(onReorder).not.toHaveBeenCalled();
  });
});
