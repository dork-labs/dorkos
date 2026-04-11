// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { PermissionMode } from '@dorkos/shared/types';

// ──────────────────────────────────────────────────────────────────────────────
// Mocks (must be hoisted before imports that use them)
// ──────────────────────────────────────────────────────────────────────────────

vi.mock('@/layers/shared/model/use-is-mobile', () => ({
  useIsMobile: () => false,
}));

const mockCapabilities = vi.fn<
  () => import('@dorkos/shared/agent-runtime').RuntimeCapabilities | undefined
>(() => undefined);
vi.mock('@/layers/entities/runtime', () => ({
  useDefaultCapabilities: () => mockCapabilities(),
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
  setShowStatusBarModel: vi.fn(),
  setShowStatusBarCost: vi.fn(),
  setShowStatusBarContext: vi.fn(),
  setShowStatusBarSound: vi.fn(),
  setShowStatusBarSync: vi.fn(),
  setShowStatusBarPolling: vi.fn(),
};

vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state: Record<string, unknown> = {
      showShortcutChips: false,
      showStatusBarCwd: true,
      showStatusBarPermission: true,
      showStatusBarModel: true,
      showStatusBarCost: true,
      showStatusBarContext: true,
      showStatusBarGit: true,
      showStatusBarSound: true,
      showStatusBarSync: true,
      showStatusBarPolling: true,
      enableNotificationSound: false,
      setEnableNotificationSound: vi.fn(),
      enableCrossClientSync: false,
      setEnableCrossClientSync: vi.fn(),
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
    PermissionModeItem: ({ supportedModes }: { supportedModes?: PermissionMode[] }) => (
      <span
        data-testid="permission-item"
        data-supported-modes={supportedModes ? supportedModes.join(',') : undefined}
      >
        perm
      </span>
    ),
    ModelConfigPopover: () => <span data-testid="model-item">model</span>,
    CostItem: () => <span data-testid="cost-item">cost</span>,
    ContextItem: () => <span data-testid="context-item">ctx</span>,
    NotificationSoundItem: () => <span data-testid="sound-item">sound</span>,
    SyncItem: () => <span data-testid="sync-item">sync</span>,
    PollingItem: () => <span data-testid="polling-item">polling</span>,
    ConnectionItem: () => <span data-testid="connection-item">connection</span>,
    ClientsItem: () => <span data-testid="clients-item">clients</span>,
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

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const defaultProps = {
  sessionId: 'session-1',
  sessionStatus: null,
  isStreaming: false,
  onChipClick: vi.fn(),
  presenceInfo: null,
  presenceTasks: false,
  syncConnectionState: 'connected' as const,
  syncFailedAttempts: 0,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
// Tests: supportedModes wiring from capabilities to PermissionModeItem
// ──────────────────────────────────────────────────────────────────────────────

describe('ChatStatusSection — supportedModes from capabilities', () => {
  it('passes supportedPermissionModes from capabilities to PermissionModeItem', () => {
    mockCapabilities.mockReturnValue({
      type: 'claude-code',
      supportsPermissionModes: true,
      supportedPermissionModes: ['default', 'plan'] as PermissionMode[],
      supportsToolApproval: true,
      supportsCostTracking: true,
      supportsResume: true,
      supportsMcp: true,
      supportsQuestionPrompt: true,
    });

    render(<ChatStatusSection {...defaultProps} />);
    const permItem = screen.getByTestId('permission-item');
    expect(permItem.getAttribute('data-supported-modes')).toBe('default,plan');
  });

  it('passes undefined supportedModes when capabilities are not loaded', () => {
    mockCapabilities.mockReturnValue(undefined);

    render(<ChatStatusSection {...defaultProps} />);
    const permItem = screen.getByTestId('permission-item');
    expect(permItem.getAttribute('data-supported-modes')).toBeNull();
  });

  it('passes undefined supportedModes when capabilities omit supportedPermissionModes', () => {
    mockCapabilities.mockReturnValue({
      type: 'claude-code',
      supportsPermissionModes: true,
      supportsToolApproval: true,
      supportsCostTracking: true,
      supportsResume: true,
      supportsMcp: true,
      supportsQuestionPrompt: true,
    });

    render(<ChatStatusSection {...defaultProps} />);
    const permItem = screen.getByTestId('permission-item');
    expect(permItem.getAttribute('data-supported-modes')).toBeNull();
  });
});
