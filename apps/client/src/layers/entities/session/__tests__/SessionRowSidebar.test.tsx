/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import type { Session } from '@dorkos/shared/types';
import { SidebarMenu, TooltipProvider } from '@/layers/shared/ui';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { SessionRowSidebar, statusSignalForBorderKind } from '../ui/SessionRowSidebar';
import { useSessionChatStore } from '../model/stream/session-chat-store';
import { useSessionListStore } from '../model/stream/session-list-store';
import { useSessionSettingsOverridesStore } from '../model/settings/session-settings-overrides';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const NOW = new Date('2026-02-07T15:00:00Z');
const SESSION_ID = 'abc12345-def6-7890-abcd-ef1234567890';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID,
    title: 'Test conversation',
    createdAt: '2026-02-07T10:00:00Z',
    updatedAt: '2026-02-07T14:00:00Z',
    permissionMode: 'default',
    runtime: 'claude-code',
    ...overrides,
  };
}

function Wrapper({ children }: { children: React.ReactNode }) {
  const transport = createMockTransport();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>
          {/* The row renders its own `<li>`, so it needs the `<ul>` around it. */}
          <SidebarMenu>{children}</SidebarMenu>
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

function renderRow(ui: React.ReactElement) {
  return render(ui, { wrapper: Wrapper });
}

/**
 * The row button itself.
 *
 * Found by the mark `SidebarRow` stamps rather than by accessible name: the
 * name is built from everything on the line, so the row and its "⋮" both read
 * as "Test conversation…" and a name query matches two elements.
 */
function rowButton(): HTMLElement {
  const row = document.querySelector<HTMLElement>('[data-sidebar-row]');
  if (row === null) throw new Error('no sidebar row rendered');
  return row;
}

/** Open the row's "⋮" menu and return its content element. */
function openRowMenu(name = 'Test conversation actions'): HTMLElement {
  // `pointerDown` and nothing after it: Radix opens on the press and then makes
  // the rest of the tree inert, so a follow-up click cannot find its own trigger.
  fireEvent.pointerDown(screen.getByLabelText(name));
  return screen.getByRole('menu');
}

describe('SessionRowSidebar', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
    useSessionListStore.setState({ sessions: {}, statuses: {}, statusCwds: {}, unseen: {} });
    useSessionSettingsOverridesStore.setState({ bySession: {} });
    useAppStore.setState({ selectedCwd: null });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders the title and its relative time', () => {
    renderRow(<SessionRowSidebar session={makeSession()} isActive={false} onSelect={() => {}} />);
    expect(screen.getByText('Test conversation')).toBeInTheDocument();
    // updatedAt is one hour before NOW.
    expect(screen.getByText('1h ago')).toBeInTheDocument();
  });

  it('opens the session when the row is pressed', () => {
    const onSelect = vi.fn();
    renderRow(<SessionRowSidebar session={makeSession()} isActive={false} onSelect={onSelect} />);

    fireEvent.click(rowButton());

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('marks the active row with aria-current', () => {
    renderRow(<SessionRowSidebar session={makeSession()} isActive onSelect={() => {}} />);
    expect(rowButton()).toHaveAttribute('aria-current', 'page');
  });

  // ── The status dot, which is the row's glyph ──

  it.each([
    ['streaming', 'Working', 'bg-status-success'],
    ['pendingApproval', 'Awaiting your approval', 'bg-status-warning-dot'],
    ['error', 'Error: check session', 'bg-status-error'],
  ] as const)('draws a %s dot with its label in words', (kind, label, colorClass) => {
    if (kind === 'error') {
      useSessionChatStore.setState({
        sessions: { [SESSION_ID]: { status: 'error', messages: [] } } as never,
        sessionAccessOrder: [],
      });
    } else {
      useSessionListStore.setState({
        sessions: {},
        statuses: {
          [SESSION_ID]: { lifecycle: kind === 'streaming' ? 'streaming' : 'blocked' },
        } as never,
        statusCwds: {},
        unseen: {},
      });
    }

    renderRow(<SessionRowSidebar session={makeSession()} isActive={false} onSelect={() => {}} />);

    const dot = screen.getByRole('img', { name: label });
    expect(dot).toHaveClass(colorClass);
  });

  it('draws no dot at all for an idle session', () => {
    renderRow(<SessionRowSidebar session={makeSession()} isActive={false} onSelect={() => {}} />);
    // 'Idle' is the border state's label; nothing should be announcing it.
    expect(screen.queryByRole('img', { name: 'Idle' })).not.toBeInTheDocument();
  });

  it('maps every border kind to a signal, idle included', () => {
    expect(statusSignalForBorderKind('streaming')).toBe('working');
    expect(statusSignalForBorderKind('pendingApproval')).toBe('needs-you');
    expect(statusSignalForBorderKind('error')).toBe('error');
    expect(statusSignalForBorderKind('unseen')).toBe('unseen');
    expect(statusSignalForBorderKind('idle')).toBeNull();
  });

  // ── The menu: one list, three doors, and the handlers that gate it ──

  it('offers rename, fork and details in the kebab menu', () => {
    renderRow(
      <SessionRowSidebar
        session={makeSession()}
        isActive={false}
        onSelect={() => {}}
        onFork={vi.fn()}
        onRename={vi.fn()}
      />
    );

    const menu = openRowMenu();

    expect(within(menu).getByRole('menuitem', { name: /Rename/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Fork session/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Details/ })).toBeInTheDocument();
  });

  it('hides rename and fork when no handler was given', () => {
    renderRow(<SessionRowSidebar session={makeSession()} isActive={false} onSelect={() => {}} />);

    const menu = openRowMenu();

    expect(within(menu).queryByRole('menuitem', { name: /Rename/ })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /Fork session/ })).not.toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Details/ })).toBeInTheDocument();
  });

  it('forks the session from the menu', () => {
    const onFork = vi.fn();
    renderRow(
      <SessionRowSidebar
        session={makeSession()}
        isActive={false}
        onSelect={() => {}}
        onFork={onFork}
      />
    );

    const menu = openRowMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Fork session/ }));

    expect(onFork).toHaveBeenCalledWith(SESSION_ID);
  });

  it('renames through the inline editor the menu opens', async () => {
    const onRename = vi.fn();
    renderRow(
      <SessionRowSidebar
        session={makeSession()}
        isActive={false}
        onSelect={() => {}}
        onRename={onRename}
      />
    );

    const menu = openRowMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Rename/ }));

    const field = await screen.findByRole('textbox', { name: 'Session title' });
    fireEvent.change(field, { target: { value: 'Renamed' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(onRename).toHaveBeenCalledWith(SESSION_ID, 'Renamed');
  });

  it('does not rename when the editor is dismissed with Escape', async () => {
    const onRename = vi.fn();
    renderRow(
      <SessionRowSidebar
        session={makeSession()}
        isActive={false}
        onSelect={() => {}}
        onRename={onRename}
      />
    );

    const menu = openRowMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Rename/ }));

    const field = await screen.findByRole('textbox', { name: 'Session title' });
    fireEvent.change(field, { target: { value: 'Discarded' } });
    fireEvent.keyDown(field, { key: 'Escape' });

    expect(onRename).not.toHaveBeenCalled();
  });

  // ── The details panel, which is the embed's only door to a session id ──

  it('opens the details panel from the menu, id included', async () => {
    renderRow(<SessionRowSidebar session={makeSession()} isActive={false} onSelect={() => {}} />);

    expect(screen.queryByText(SESSION_ID)).not.toBeInTheDocument();

    const menu = openRowMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Details/ }));

    expect(await screen.findByText(SESSION_ID)).toBeInTheDocument();
    expect(screen.getByText('Session ID')).toBeInTheDocument();
  });

  it('marks the row face when the session runs at full power', () => {
    renderRow(
      <SessionRowSidebar
        session={makeSession({ permissionMode: 'bypassPermissions' })}
        isActive={false}
        onSelect={() => {}}
      />
    );

    expect(
      screen.getByRole('img', { name: 'Full power: acts without approval prompts' })
    ).toBeInTheDocument();
  });

  it('draws that mark green, never red — the person chose this', () => {
    // Red here would have marked most rows in the rail once full power became
    // the default, which is how a rail stops being read
    // (spec `full-power-defaults`, D8).
    renderRow(
      <SessionRowSidebar
        session={makeSession({ permissionMode: 'bypassPermissions' })}
        isActive={false}
        onSelect={() => {}}
      />
    );

    const mark = screen.getByRole('img', { name: 'Full power: acts without approval prompts' });
    expect(mark.getAttribute('class')).toContain('text-status-success');
    expect(mark.getAttribute('class')).not.toMatch(/red/);
  });

  it('leaves the mark off a session that asks first', () => {
    renderRow(<SessionRowSidebar session={makeSession()} isActive={false} onSelect={() => {}} />);
    expect(
      screen.queryByRole('img', { name: 'Full power: acts without approval prompts' })
    ).not.toBeInTheDocument();
  });

  // ── The reason this row exists: it is the shared primitive, not a fourth
  //    idea about what a row looks like ──

  it('is drawn by SidebarRow — the shared row mark and tint ramp, no hairline', () => {
    const { container } = renderRow(
      <SessionRowSidebar session={makeSession()} isActive={false} onSelect={() => {}} />
    );

    const row = container.querySelector('[data-sidebar-row]');
    expect(row).not.toBeNull();
    expect(row).toHaveClass('hover:bg-sidebar-accent/70');
    expect(container.querySelector('[class*="border-t"],[class*="border-b"]')).toBeNull();
  });
});
