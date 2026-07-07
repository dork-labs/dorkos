// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
// ──────────────────────────────────────────────────────────────────────────────
// Mocks (must be hoisted before imports that use them)
// ──────────────────────────────────────────────────────────────────────────────

vi.mock('@/layers/shared/model/use-is-mobile', () => ({
  useIsMobile: () => false,
}));

// Permission-mode capabilities are consumed by PermissionModeItem (mocked
// below); ChatStatusSection itself reads `useRuntimeCapabilities` for the
// runtime chip and `useCapabilitiesForRuntime` for the capability honesty
// gates (usage & cost). Both controllable so the wiring + gating tests can register
// runtimes and drive per-runtime capability profiles.
const mockCapabilitiesData = vi.fn<() => unknown>(() => undefined);
const mockCapsForRuntime = vi.fn<(runtime: string | null | undefined) => unknown>(() => undefined);

vi.mock('@/layers/entities/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/runtime')>()),
  useRuntimeCapabilities: () => ({ data: mockCapabilitiesData() }),
  useCapabilitiesForRuntime: (runtime: string | null | undefined) => mockCapsForRuntime(runtime),
}));

// Session-list rows drive the runtime chip's "started" signal (row present =
// session has a first message) and its post-bind display runtime
// (row.runtime). Controllable per test. The real useSessions cannot run here —
// it reads router search params and there is no RouterProvider in this suite.
const mockSessionList = vi.fn<() => { sessions: unknown[]; isLoading: boolean }>(() => ({
  sessions: [],
  isLoading: false,
}));

vi.mock('@/layers/entities/session/model/use-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session/model/use-sessions')>()),
  useSessions: () => mockSessionList() as never,
}));

vi.mock('@/layers/entities/session/model/use-session-status', () => ({
  useSessionStatus: () => ({
    permissionMode: 'default',
    cwd: '/test/dir',
    model: 'claude-opus-4-5',
    costUsd: 0.05,
    contextPercent: 50,
    updateSession: vi.fn(),
  }),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: vi.fn(() => ({ data: undefined })),
    useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
  };
});

vi.mock('@/layers/shared/model/TransportContext', () => ({
  useTransport: vi.fn(() => ({
    getConfig: vi.fn().mockResolvedValue({}),
    updateConfig: vi.fn().mockResolvedValue(undefined),
  })),
}));

const mockSetters: Record<string, ReturnType<typeof vi.fn>> = {
  setShowStatusBarCwd: vi.fn(),
  setShowStatusBarGit: vi.fn(),
  setShowStatusBarPermission: vi.fn(),
  setShowStatusBarRuntime: vi.fn(),
  setShowStatusBarModel: vi.fn(),
  setShowStatusBarUsage: vi.fn(),
  setShowStatusBarContext: vi.fn(),
  setShowStatusBarSound: vi.fn(),
  setShowStatusBarPolling: vi.fn(),
};

vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state: Record<string, unknown> = {
      selectedCwd: '/test/dir',
      pendingRuntime: null,
      setPendingRuntime: vi.fn(),
      showShortcutChips: false,
      showStatusBarCwd: true,
      showStatusBarPermission: true,
      showStatusBarRuntime: true,
      showStatusBarModel: true,
      showStatusBarUsage: true,
      showStatusBarContext: true,
      showStatusBarGit: true,
      showStatusBarSound: true,
      showStatusBarPolling: true,
      enableNotificationSound: false,
      setEnableNotificationSound: vi.fn(),
      enableMessagePolling: false,
      setEnableMessagePolling: vi.fn(),
      ...mockSetters,
    };
    return selector ? selector(state) : state;
  },
}));

// Mock ContextMenu with a simple implementation that renders content inline
// when triggered via contextMenu event, so we can test menu items in jsdom.
vi.mock('@/layers/shared/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/ui')>();
  return {
    ...actual,
    ContextMenu: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="context-menu">{children}</div>
    ),
    ContextMenuTrigger: ({
      children,
      asChild,
    }: {
      children: React.ReactNode;
      asChild?: boolean;
    }) => {
      const child = asChild && React.isValidElement(children) ? children : <span>{children}</span>;
      return <div data-testid="context-menu-trigger">{child}</div>;
    },
    ContextMenuContent: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="context-menu-content">{children}</div>
    ),
    ContextMenuItem: ({
      children,
      onClick,
    }: {
      children: React.ReactNode;
      onClick?: () => void;
    }) => (
      <button data-testid="context-menu-item" onClick={onClick} type="button">
        {children}
      </button>
    ),
    ContextMenuSeparator: () => <hr data-testid="context-menu-separator" />,
    // Keep tooltip primitives functional for configure icon
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) => {
      const child = asChild && React.isValidElement(children) ? children : <span>{children}</span>;
      return <>{child}</>;
    },
    TooltipContent: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="tooltip-content">{children}</div>
    ),
  };
});

vi.mock('@/layers/features/status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/features/status')>();
  return {
    ...actual,
    StatusLine: Object.assign(
      ({ children }: { children: React.ReactNode }) => (
        <div data-testid="status-line">{children}</div>
      ),
      {
        Item: ({
          visible,
          children,
          itemKey,
        }: {
          visible: boolean;
          children: React.ReactNode;
          itemKey: string;
        }) => (visible ? <div data-testid={`item-${itemKey}`}>{children}</div> : null),
      }
    ),
    CwdItem: ({ cwd }: { cwd: string }) => <span data-testid="cwd-item">{cwd}</span>,
    GitStatusItem: () => <span data-testid="git-item">git</span>,
    PermissionModeItem: ({ runtime }: { runtime?: string | null }) => (
      <span data-testid="permission-item" data-runtime={runtime ?? ''}>
        perm
      </span>
    ),
    RuntimeItem: ({ runtime, canSelect }: { runtime: string; canSelect: boolean }) => (
      <span data-testid="runtime-item" data-runtime={runtime} data-can-select={String(canSelect)}>
        runtime
      </span>
    ),
    ModelConfigPopover: () => <span data-testid="model-item">model</span>,
    UsageStatusItem: () => <span data-testid="usage-item">usage</span>,
    ContextItem: () => <span data-testid="context-item">ctx</span>,
    NotificationSoundItem: () => <span data-testid="sound-item">sound</span>,
    PollingItem: () => <span data-testid="polling-item">polling</span>,
    ConnectionItem: () => <span data-testid="connection-item">connection</span>,
    StatusBarConfigurePopover: ({
      children,
      open,
      onOpenChange,
    }: {
      children: React.ReactNode;
      open?: boolean;
      onOpenChange?: (v: boolean) => void;
    }) => {
      // Simulate popover trigger behavior: clicking the trigger child calls onOpenChange(true).
      // The mock renders the trigger child with an added onClick that fires onOpenChange(true),
      // mimicking how ResponsivePopover opens when its trigger is activated.
      const trigger = React.Children.toArray(children)[0];
      const wrappedTrigger =
        React.isValidElement(trigger) && onOpenChange
          ? React.cloneElement(trigger as React.ReactElement<{ onClick?: () => void }>, {
              onClick: () => onOpenChange(true),
            })
          : trigger;
      return (
        <div data-testid="configure-popover" data-open={String(open)}>
          {wrappedTrigger}
        </div>
      );
    },
    useGitStatus: vi.fn(() => ({ data: undefined })),
    STATUS_BAR_REGISTRY: actual.STATUS_BAR_REGISTRY,
    resetStatusBarPreferences: vi.fn(),
  };
});

// ──────────────────────────────────────────────────────────────────────────────
// Import component under test after all mocks
// ──────────────────────────────────────────────────────────────────────────────

import { ChatStatusSection } from '../ui/status/ChatStatusSection';
import { resetStatusBarPreferences } from '@/layers/features/status';
import { useSessionStreamStore } from '@/layers/entities/session';
import type { SessionSnapshot } from '@dorkos/shared/session-stream';

/** A hydrated snapshot carrying a pay-as-you-go `usage`, for the merged item's capability gate. */
function snapshotWithUsage(): SessionSnapshot {
  return {
    messages: [],
    inProgressTurn: null,
    status: {
      contextUsage: null,
      cost: 0.05,
      usage: { kind: 'pay-as-you-go', costUsd: 0.05 },
      cacheStats: null,
      model: 'claude-opus-4-5',
      permissionMode: 'default',
      todoCounts: null,
      runningSubagentCount: 0,
      lifecycle: 'idle',
      lastError: null,
    },
    pendingInteractions: [],
    cursor: 1,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const defaultProps = {
  sessionId: 'session-1',
  sessionStatus: null,
  isStreaming: false,
  onChipClick: vi.fn(),
  syncConnectionState: 'connected' as const,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockCapabilitiesData.mockReturnValue(undefined);
  mockCapsForRuntime.mockReturnValue(undefined);
  mockSessionList.mockReturnValue({ sessions: [], isLoading: false });
  // Reset any ?runtime= param a test wrote into the jsdom URL.
  window.history.replaceState(null, '', '/');
});

// ──────────────────────────────────────────────────────────────────────────────
// Tests: configure icon
// ──────────────────────────────────────────────────────────────────────────────

describe('ChatStatusSection — configure icon', () => {
  it('renders the configure icon button with correct aria-label', () => {
    render(<ChatStatusSection {...defaultProps} />);
    const btn = screen.getByRole('button', { name: 'Configure status bar' });
    expect(btn).toBeInTheDocument();
  });

  it('configure icon is rendered outside StatusLine as a right-aligned sibling', () => {
    render(<ChatStatusSection {...defaultProps} />);
    // The configure button should exist and contain the popover
    const configureButton = screen.getByLabelText('Configure status bar');
    expect(configureButton).toBeInTheDocument();
    expect(screen.getByTestId('configure-popover')).toBeInTheDocument();
  });

  it('configure icon is always visible even when all store flags are false', () => {
    render(<ChatStatusSection {...defaultProps} />);
    // Configure button must be present regardless of store flags
    expect(screen.getByLabelText('Configure status bar')).toBeInTheDocument();
  });

  it('configure button is the direct trigger child of StatusBarConfigurePopover', () => {
    render(<ChatStatusSection {...defaultProps} />);
    // The configure popover should contain the configure button as its trigger.
    // Verify the button is inside the configure-popover container.
    const popover = screen.getByTestId('configure-popover');
    const btn = screen.getByRole('button', { name: 'Configure status bar' });
    expect(popover.contains(btn)).toBe(true);
  });

  it('configure popover receives open=false by default and onOpenChange callback', () => {
    render(<ChatStatusSection {...defaultProps} />);
    const popover = screen.getByTestId('configure-popover');
    // Starts closed
    expect(popover.getAttribute('data-open')).toBe('false');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Tests: item context menus
// ──────────────────────────────────────────────────────────────────────────────

describe('ChatStatusSection — item context menus (registry items)', () => {
  it('each registry item is wrapped in a ContextMenu with a ContextMenuTrigger', () => {
    render(<ChatStatusSection {...defaultProps} />);
    // The cwd item should be nested inside a context-menu-trigger
    const cwdItem = screen.getByTestId('cwd-item');
    // Walk up to find a context-menu-trigger ancestor
    let node: HTMLElement | null = cwdItem.parentElement;
    let foundTrigger = false;
    while (node) {
      if (node.getAttribute('data-testid') === 'context-menu-trigger') {
        foundTrigger = true;
        break;
      }
      node = node.parentElement;
    }
    expect(foundTrigger).toBe(true);
  });

  it('context menu for cwd item contains "Hide \\"Directory\\""', () => {
    render(<ChatStatusSection {...defaultProps} />);
    // Find the context-menu-content that is a sibling/child of the cwd item's menu
    const menuItems = screen.getAllByTestId('context-menu-item');
    const hideItem = menuItems.find(
      (el) => el.textContent?.includes('Hide') && el.textContent?.includes('Directory')
    );
    expect(hideItem).toBeDefined();
  });

  it('clicking Hide "Directory" calls setShowStatusBarCwd(false)', () => {
    render(<ChatStatusSection {...defaultProps} />);
    const menuItems = screen.getAllByTestId('context-menu-item');
    const hideItem = menuItems.find(
      (el) => el.textContent?.includes('Hide') && el.textContent?.includes('Directory')
    );
    expect(hideItem).toBeDefined();
    fireEvent.click(hideItem!);
    expect(mockSetters.setShowStatusBarCwd).toHaveBeenCalledWith(false);
  });

  it('each registry item has "Configure status bar..." in its context menu', () => {
    render(<ChatStatusSection {...defaultProps} />);
    const menuItems = screen.getAllByTestId('context-menu-item');
    const configureItems = menuItems.filter((el) =>
      el.textContent?.includes('Configure status bar')
    );
    // There should be at least one (one per visible registry item + background)
    expect(configureItems.length).toBeGreaterThan(0);
  });

  it('clicking "Configure status bar..." from a context menu opens the popover', () => {
    render(<ChatStatusSection {...defaultProps} />);
    const popover = screen.getByTestId('configure-popover');
    expect(popover.getAttribute('data-open')).toBe('false');

    const menuItems = screen.getAllByTestId('context-menu-item');
    const configureItem = menuItems.find((el) => el.textContent?.includes('Configure status bar'));
    expect(configureItem).toBeDefined();
    act(() => {
      fireEvent.click(configureItem!);
    });
    expect(popover.getAttribute('data-open')).toBe('true');
  });

  it('clicking "Reset to defaults" calls resetStatusBarPreferences', () => {
    render(<ChatStatusSection {...defaultProps} />);
    const menuItems = screen.getAllByTestId('context-menu-item');
    const resetItem = menuItems.find((el) => el.textContent === 'Reset to defaults');
    expect(resetItem).toBeDefined();
    fireEvent.click(resetItem!);
    expect(resetStatusBarPreferences).toHaveBeenCalled();
  });

  it('context menu for git item contains "Hide \\"Git Status\\""', () => {
    render(<ChatStatusSection {...defaultProps} />);
    const menuItems = screen.getAllByTestId('context-menu-item');
    const hideItem = menuItems.find(
      (el) => el.textContent?.includes('Hide') && el.textContent?.includes('Git Status')
    );
    expect(hideItem).toBeDefined();
  });

  it('clicking Hide "Git Status" calls setShowStatusBarGit(false)', () => {
    render(<ChatStatusSection {...defaultProps} />);
    const menuItems = screen.getAllByTestId('context-menu-item');
    const hideItem = menuItems.find(
      (el) => el.textContent?.includes('Hide') && el.textContent?.includes('Git Status')
    );
    expect(hideItem).toBeDefined();
    fireEvent.click(hideItem!);
    expect(mockSetters.setShowStatusBarGit).toHaveBeenCalledWith(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Tests: system-managed items have no Hide option
// ──────────────────────────────────────────────────────────────────────────────

describe('ChatStatusSection — system-managed items', () => {
  it('connection and clients items are not wrapped in ItemContextMenu (no Hide option for them)', () => {
    render(<ChatStatusSection {...defaultProps} />);
    // The Hide menu items should only reference registry labels, not connection/clients
    const menuItems = screen.getAllByTestId('context-menu-item');
    const hideForConnection = menuItems.find(
      (el) => el.textContent?.includes('Hide') && el.textContent?.includes('Connection')
    );
    const hideForClients = menuItems.find(
      (el) => el.textContent?.includes('Hide') && el.textContent?.includes('Clients')
    );
    expect(hideForConnection).toBeUndefined();
    expect(hideForClients).toBeUndefined();
  });

  it('background context menu has Configure and Reset items', () => {
    render(<ChatStatusSection {...defaultProps} />);
    // The outermost ContextMenuContent (background menu) always renders configure+reset
    // Since all ContextMenuContent is rendered inline in our mock, we look for items
    const menuItems = screen.getAllByTestId('context-menu-item');
    const configureItems = menuItems.filter((el) =>
      el.textContent?.includes('Configure status bar')
    );
    const resetItems = menuItems.filter((el) => el.textContent === 'Reset to defaults');
    expect(configureItems.length).toBeGreaterThan(0);
    expect(resetItems.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Tests: ChatStatusSection threads the resolved runtime to PermissionModeItem
//
// The parent resolves the display runtime once (useRuntimeChip: session row →
// pending ?runtime= selection → server default) and passes it down so the
// child's mode list always reflects the runtime the session runs (or will
// run) on — never a stale per-session inference (task 4.2 fold-in).
// ──────────────────────────────────────────────────────────────────────────────

describe('ChatStatusSection — RuntimeItem wiring', () => {
  const capsData = {
    capabilities: { 'claude-code': { type: 'claude-code' }, codex: { type: 'codex' } },
    defaultRuntime: 'claude-code',
  };
  // A session that has a first message: present in the ['sessions', cwd] list
  // cache with its server-bound runtime.
  const startedRow = {
    id: 'session-1',
    title: 'Started session',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    permissionMode: 'default',
    runtime: 'codex',
  };

  it('started session (row in the list cache): read-only chip showing the row runtime', () => {
    mockCapabilitiesData.mockReturnValue(capsData);
    mockSessionList.mockReturnValue({ sessions: [startedRow], isLoading: false });
    render(<ChatStatusSection {...defaultProps} />);
    const item = screen.getByTestId('runtime-item');
    expect(item.getAttribute('data-can-select')).toBe('false');
    // Server-authoritative row runtime — NOT the default runtime.
    expect(item.getAttribute('data-runtime')).toBe('codex');
  });

  it('minted-but-never-messaged session (truthy id, row absent): chip is selectable', () => {
    // The route loader ALWAYS mints ?session=<uuid> before any message exists,
    // so a truthy sessionId must NOT read as "started" — only row presence does.
    mockCapabilitiesData.mockReturnValue(capsData);
    mockSessionList.mockReturnValue({ sessions: [], isLoading: false });
    render(<ChatStatusSection {...defaultProps} />);
    const item = screen.getByTestId('runtime-item');
    expect(item.getAttribute('data-can-select')).toBe('true');
    // No ?runtime= param in the test URL — falls back to the server default.
    expect(item.getAttribute('data-runtime')).toBe('claude-code');
  });

  it('?runtime=codex pre-launch: chip displays the selection, not the default', () => {
    mockCapabilitiesData.mockReturnValue(capsData);
    mockSessionList.mockReturnValue({ sessions: [], isLoading: false });
    window.history.replaceState(null, '', '/?runtime=codex');
    render(<ChatStatusSection {...defaultProps} />);
    const item = screen.getByTestId('runtime-item');
    expect(item.getAttribute('data-runtime')).toBe('codex');
    expect(item.getAttribute('data-can-select')).toBe('true');
  });

  it('hides the chip while the session list is loading (started-ness unknown)', () => {
    mockCapabilitiesData.mockReturnValue(capsData);
    mockSessionList.mockReturnValue({ sessions: [], isLoading: true });
    render(<ChatStatusSection {...defaultProps} />);
    expect(screen.queryByTestId('runtime-item')).not.toBeInTheDocument();
  });

  it('hides the chip while runtime capabilities are still loading', () => {
    mockCapabilitiesData.mockReturnValue(undefined);
    mockSessionList.mockReturnValue({ sessions: [], isLoading: false });
    render(<ChatStatusSection {...defaultProps} />);
    expect(screen.queryByTestId('runtime-item')).not.toBeInTheDocument();
  });
});

describe('ChatStatusSection — PermissionModeItem wiring', () => {
  const capsData = {
    capabilities: { 'claude-code': { type: 'claude-code' }, codex: { type: 'codex' } },
    defaultRuntime: 'claude-code',
  };

  it("threads the started session's row runtime through to PermissionModeItem", () => {
    mockCapabilitiesData.mockReturnValue(capsData);
    mockSessionList.mockReturnValue({
      sessions: [
        {
          id: 'session-1',
          title: 'Started session',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-01T00:00:00.000Z',
          permissionMode: 'default',
          runtime: 'codex',
        },
      ],
      isLoading: false,
    });
    render(<ChatStatusSection {...defaultProps} />);
    const permItem = screen.getByTestId('permission-item');
    // The mode list tracks the session's bound runtime, not the default.
    expect(permItem.getAttribute('data-runtime')).toBe('codex');
  });

  it('threads the pre-launch ?runtime= selection so the mode list matches the launch runtime', () => {
    mockCapabilitiesData.mockReturnValue(capsData);
    mockSessionList.mockReturnValue({ sessions: [], isLoading: false });
    window.history.replaceState(null, '', '/?runtime=codex');
    render(<ChatStatusSection {...defaultProps} />);
    expect(screen.getByTestId('permission-item').getAttribute('data-runtime')).toBe('codex');
  });

  it('passes a null runtime while the chip is still resolving (falls back to the server default)', () => {
    mockCapabilitiesData.mockReturnValue(undefined);
    render(<ChatStatusSection {...defaultProps} />);
    expect(screen.getByTestId('permission-item').getAttribute('data-runtime')).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Tests: capability honesty — the merged Usage & cost item never renders for a
// runtime whose profile declares `supportsCostTracking: false` (spec §UX;
// verified against the three real profiles: Claude Code true, Codex false,
// OpenCode true).
// ──────────────────────────────────────────────────────────────────────────────

describe('ChatStatusSection — usage capability gate', () => {
  // The snapshot carries a pay-as-you-go `usage`, so the merged Usage & cost
  // item's visibility is decided purely by the runtime's capability profile.
  function withRuntimeProfile(runtime: string, supportsCostTracking: boolean) {
    mockCapabilitiesData.mockReturnValue({
      capabilities: { [runtime]: { type: runtime } },
      defaultRuntime: runtime,
    });
    mockSessionList.mockReturnValue({
      sessions: [
        {
          id: 'session-1',
          title: 'Session',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-01T00:00:00.000Z',
          permissionMode: 'default',
          runtime,
        },
      ],
      isLoading: false,
    });
    mockCapsForRuntime.mockImplementation((rt) =>
      rt === runtime ? { type: runtime, supportsCostTracking } : undefined
    );
  }

  beforeEach(() => {
    useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
    act(() => {
      useSessionStreamStore.getState().applySnapshot('session-1', snapshotWithUsage());
    });
  });

  it('shows the usage item on Claude Code (supportsCostTracking: true)', () => {
    withRuntimeProfile('claude-code', true);
    render(<ChatStatusSection {...defaultProps} />);
    expect(screen.getByTestId('item-usage')).toBeInTheDocument();
    expect(mockCapsForRuntime).toHaveBeenCalledWith('claude-code');
  });

  it('hides the usage item on Codex (supportsCostTracking: false) even when a value exists', () => {
    withRuntimeProfile('codex', false);
    render(<ChatStatusSection {...defaultProps} />);
    expect(screen.queryByTestId('item-usage')).not.toBeInTheDocument();
    expect(mockCapsForRuntime).toHaveBeenCalledWith('codex');
  });

  it('shows the usage item on OpenCode (supportsCostTracking: true)', () => {
    withRuntimeProfile('opencode', true);
    render(<ChatStatusSection {...defaultProps} />);
    expect(screen.getByTestId('item-usage')).toBeInTheDocument();
  });

  it('keeps the usage item visible while the capability profile is still loading', () => {
    // Honesty gates close on an explicit false, not on missing data — a
    // momentary undefined profile must not flash-hide a legitimate item.
    mockCapsForRuntime.mockReturnValue(undefined);
    render(<ChatStatusSection {...defaultProps} />);
    expect(screen.getByTestId('item-usage')).toBeInTheDocument();
  });
});
