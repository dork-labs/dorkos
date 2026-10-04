/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider, useAppTabsStore } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { enterDesktopShell, leaveDesktopShell } from '@/test-helpers/desktop-shell';

const navigate = vi.fn((_options: { href: string }) => Promise.resolve());
const router = {
  navigate: (options: { href: string }) => navigate(options),
  state: { location: { href: '/' } },
};

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => router,
}));

// Rows name pages through the same live queries as the tab strip; pinned here
// so the assertions are about the controls, not about fetch timing.
vi.mock('@/layers/entities/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/agent')>()),
  useCurrentAgent: () => ({ data: null }),
}));

vi.mock('@/layers/entities/room', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/room')>()),
  useRoom: () => ({ data: null }),
}));

import { TabHistoryControls } from '../ui/TabHistoryControls';

const transport = createMockTransport();

function Wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <TooltipProvider>{children}</TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

/** One active tab with history `hrefs`, on entry `cursor`. */
function setHistory(hrefs: string[], cursor = hrefs.length - 1): void {
  const tab = { id: 'tab-0', href: hrefs[cursor], history: hrefs, cursor };
  useAppTabsStore.setState({ tabs: [tab], activeTabId: tab.id });
}

function renderControls() {
  return render(<TabHistoryControls />, { wrapper: Wrapper });
}

beforeEach(() => {
  navigate.mockClear();
  sessionStorage.clear();
  enterDesktopShell();
});

afterEach(() => {
  cleanup();
  leaveDesktopShell();
});

describe('TabHistoryControls', () => {
  it('renders nothing in a browser', () => {
    // Purpose: the browser's own Back and History do this job on the web.
    leaveDesktopShell();
    setHistory(['/', '/team']);
    const { container } = renderControls();
    expect(container).toBeEmptyDOMElement();
  });

  it('disables Back on the first page and Forward on the last', () => {
    // Purpose: "nowhere to go" is shown as disabled, never as a hidden button.
    setHistory(['/', '/team'], 0);
    renderControls();
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Forward' })).toBeEnabled();

    act(() => useAppTabsStore.getState().goToHistoryIndex(1));
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
  });

  it('Back moves the tab and navigates to the page before', async () => {
    // Purpose: the button drives the same move as the key.
    setHistory(['/', '/team']);
    renderControls();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(navigate).toHaveBeenCalledWith({ href: '/' });
    expect(screen.getByRole('button', { name: 'Forward' })).toBeEnabled();
  });

  it('lists the tab’s pages newest first, with the current one checked', async () => {
    // Purpose: browser order, and a clear "you are here".
    setHistory(['/', '/team', '/tasks'], 1);
    renderControls();
    await userEvent.click(screen.getByRole('button', { name: 'History' }));

    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Schedules', 'Team', 'Home']);
    expect(items[1]).toHaveAttribute('aria-current', 'page');
    expect(items[1]).toHaveAttribute('aria-disabled', 'true');
    expect(items[0]).not.toHaveAttribute('aria-current');
  });

  it('shows the single current page when there is nowhere else to go', async () => {
    // Purpose: History is never a dead control, even on a brand-new tab.
    setHistory(['/']);
    renderControls();
    const history = screen.getByRole('button', { name: 'History' });
    expect(history).toBeEnabled();
    await userEvent.click(history);
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Home']);
  });

  it('jumps the tab to a clicked page and leaves Forward available', async () => {
    // Purpose: a jump is a cursor move; the pages after it stay reachable.
    setHistory(['/', '/team', '/tasks']);
    renderControls();
    await userEvent.click(screen.getByRole('button', { name: 'History' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Home' }));

    expect(navigate).toHaveBeenCalledWith({ href: '/' });
    const { tabs } = useAppTabsStore.getState();
    expect(tabs[0]).toMatchObject({ href: '/', cursor: 0, history: ['/', '/team', '/tasks'] });
    expect(screen.getByRole('button', { name: 'Forward' })).toBeEnabled();
  });
});
