// @vitest-environment jsdom
import * as React from 'react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

// ---------------------------------------------------------------------------
// Mock the runtime entity so tests can drive the capabilities the hook reports
// without standing up a full TransportProvider + QueryClient.
// ---------------------------------------------------------------------------

const mockActiveCapabilities = vi.fn<() => RuntimeCapabilities | undefined>(() => undefined);
const mockDefaultCapabilities = vi.fn<() => RuntimeCapabilities | undefined>(() => undefined);

vi.mock('@/layers/entities/runtime', () => ({
  useActiveCapabilities: (sessionId: string | undefined) => {
    void sessionId;
    return mockActiveCapabilities();
  },
  useDefaultCapabilities: () => mockDefaultCapabilities(),
}));

// ---------------------------------------------------------------------------
// Mock shared/ui — render ResponsiveDropdownMenu components inline so we
// avoid portal/floating-ui complexity from Radix.
// ---------------------------------------------------------------------------

vi.mock('@/layers/shared/ui', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ResponsiveDropdownMenu: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="dropdown-root">{children}</div>
    ),
    ResponsiveDropdownMenuTrigger: ({
      children,
      asChild: _asChild,
      ...props
    }: {
      children: React.ReactNode;
      asChild?: boolean;
      [key: string]: unknown;
    }) => (
      <div data-testid="dropdown-trigger" {...props}>
        {children}
      </div>
    ),
    ResponsiveDropdownMenuContent: ({
      children,
    }: {
      children: React.ReactNode;
      [key: string]: unknown;
    }) => <div data-testid="dropdown-content">{children}</div>,
    ResponsiveDropdownMenuLabel: ({
      children,
    }: {
      children: React.ReactNode;
      [key: string]: unknown;
    }) => <div data-testid="dropdown-label">{children}</div>,
    ResponsiveDropdownMenuRadioGroup: ({
      children,
      value,
      onValueChange,
    }: {
      children: React.ReactNode;
      value?: string;
      onValueChange?: (v: string) => void;
      [key: string]: unknown;
    }) => (
      <div
        role="radiogroup"
        data-value={value}
        onClick={(e) => {
          const target = (e.target as HTMLElement).closest('[data-radio-value]');
          if (target && onValueChange) onValueChange(target.getAttribute('data-radio-value')!);
        }}
      >
        {children}
      </div>
    ),
    ResponsiveDropdownMenuRadioItem: ({
      children,
      value,
      description,
      className,
    }: {
      children: React.ReactNode;
      value: string;
      icon?: React.ComponentType;
      description?: string;
      className?: string;
    }) => (
      <div role="radio" aria-checked={false} data-radio-value={value} className={className}>
        <span>{children}</span>
        {description && <span data-testid={`desc-${value}`}>{description}</span>}
      </div>
    ),
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipTrigger: ({
      children,
      asChild: _asChild,
    }: {
      children: React.ReactNode;
      asChild?: boolean;
    }) => <>{children}</>,
    TooltipContent: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="tooltip-content">{children}</div>
    ),
  };
});

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
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockActiveCapabilities.mockReturnValue(undefined);
  mockDefaultCapabilities.mockReturnValue(undefined);
});

// Import after mocks are set up
import { PermissionModeItem } from '../ui/PermissionModeItem';

// ---------------------------------------------------------------------------
// Capability fixtures
// ---------------------------------------------------------------------------

const CLAUDE_CAPABILITIES: RuntimeCapabilities = {
  type: 'claude-code',
  supportsToolApproval: true,
  supportsCostTracking: true,
  supportsResume: true,
  supportsMcp: true,
  supportsQuestionPrompt: true,
  supportsPlugins: true,
  permissionModes: {
    supported: true,
    values: [
      { id: 'default', label: 'Default', description: 'Prompt for each tool call' },
      { id: 'acceptEdits', label: 'Accept edits', description: 'Auto-approve file edits' },
      { id: 'plan', label: 'Plan', description: 'Research only, no edits' },
      { id: 'bypassPermissions', label: 'Bypass permissions', description: 'Auto-approve all' },
    ],
  },
  features: {
    claudeSkills: true,
    claudeHooks: true,
    claudeSlashCommands: true,
  },
};

const TEST_MODE_CAPABILITIES: RuntimeCapabilities = {
  type: 'test-mode',
  supportsToolApproval: false,
  supportsCostTracking: false,
  supportsResume: false,
  supportsMcp: false,
  supportsQuestionPrompt: false,
  supportsPlugins: false,
  permissionModes: {
    supported: true,
    values: [
      { id: 'always-allow', label: 'Always allow' },
      { id: 'always-deny', label: 'Always deny' },
      { id: 'scripted', label: 'Scripted' },
    ],
  },
  features: {
    testModeScenarios: ['simple-text'],
    deterministicLatencyMs: 0,
  },
};

const UNSUPPORTED_CAPABILITIES: RuntimeCapabilities = {
  type: 'opencode',
  supportsToolApproval: false,
  supportsCostTracking: false,
  supportsResume: false,
  supportsMcp: false,
  supportsQuestionPrompt: false,
  supportsPlugins: false,
  permissionModes: { supported: false, values: [] },
  features: {},
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PermissionModeItem', () => {
  describe('Claude-code capabilities', () => {
    it('renders Claude permission modes in the dropdown', () => {
      mockActiveCapabilities.mockReturnValue(CLAUDE_CAPABILITIES);
      render(<PermissionModeItem mode="default" onChangeMode={vi.fn()} sessionId="s1" />);

      const group = screen.getByRole('radiogroup');
      const items = group.querySelectorAll('[role="radio"]');
      expect(items).toHaveLength(4);
      expect(group).toHaveTextContent('Default');
      expect(group).toHaveTextContent('Accept edits');
      expect(group).toHaveTextContent('Plan');
      expect(group).toHaveTextContent('Bypass permissions');
    });

    it('renders current mode label in trigger', () => {
      mockActiveCapabilities.mockReturnValue(CLAUDE_CAPABILITIES);
      render(<PermissionModeItem mode="plan" onChangeMode={vi.fn()} sessionId="s1" />);

      const trigger = screen.getByTestId('dropdown-trigger');
      expect(trigger).toHaveTextContent('Plan');
    });

    it('calls onChangeMode when a mode is selected', async () => {
      mockActiveCapabilities.mockReturnValue(CLAUDE_CAPABILITIES);
      const user = userEvent.setup();
      const onChangeMode = vi.fn();
      render(<PermissionModeItem mode="default" onChangeMode={onChangeMode} sessionId="s1" />);

      const planItem = screen.getByText('Plan');
      await user.click(planItem);
      expect(onChangeMode).toHaveBeenCalledWith('plan');
    });
  });

  describe('Test-mode capabilities', () => {
    it('renders test-mode permission modes (always-allow, always-deny, scripted)', () => {
      mockActiveCapabilities.mockReturnValue(TEST_MODE_CAPABILITIES);
      render(
        <PermissionModeItem
          mode={'always-allow' as never}
          onChangeMode={vi.fn()}
          sessionId="s-test"
        />
      );

      const group = screen.getByRole('radiogroup');
      const items = group.querySelectorAll('[role="radio"]');
      expect(items).toHaveLength(3);
      expect(group).toHaveTextContent('Always allow');
      expect(group).toHaveTextContent('Always deny');
      expect(group).toHaveTextContent('Scripted');
    });

    it('does not render Claude-specific modes when on a test-mode session', () => {
      mockActiveCapabilities.mockReturnValue(TEST_MODE_CAPABILITIES);
      render(
        <PermissionModeItem
          mode={'always-allow' as never}
          onChangeMode={vi.fn()}
          sessionId="s-test"
        />
      );

      expect(screen.queryByText('Accept edits')).not.toBeInTheDocument();
      expect(screen.queryByText('Plan')).not.toBeInTheDocument();
      expect(screen.queryByText('Bypass permissions')).not.toBeInTheDocument();
    });
  });

  describe('permissionModes.supported gating', () => {
    it('hides the picker entirely when permissionModes.supported is false', () => {
      mockActiveCapabilities.mockReturnValue(UNSUPPORTED_CAPABILITIES);
      const { container } = render(
        <PermissionModeItem mode="default" onChangeMode={vi.fn()} sessionId="s1" />
      );

      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
      expect(screen.queryByTestId('dropdown-trigger')).not.toBeInTheDocument();
    });
  });

  describe('Default-capabilities fallback (no sessionId)', () => {
    it('consumes useDefaultCapabilities when sessionId is omitted', () => {
      mockDefaultCapabilities.mockReturnValue(CLAUDE_CAPABILITIES);
      render(<PermissionModeItem mode="default" onChangeMode={vi.fn()} />);

      const group = screen.getByRole('radiogroup');
      const items = group.querySelectorAll('[role="radio"]');
      expect(items).toHaveLength(4);
      expect(group).toHaveTextContent('Default');
    });
  });

  describe('Disabled state', () => {
    it('shows disabled trigger with tooltip when disabled=true', () => {
      mockActiveCapabilities.mockReturnValue(CLAUDE_CAPABILITIES);
      render(<PermissionModeItem mode="default" onChangeMode={vi.fn()} disabled sessionId="s1" />);

      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
      expect(screen.getByText('Send a message first')).toBeInTheDocument();
      expect(screen.queryByTestId('dropdown-root')).not.toBeInTheDocument();
    });
  });

  describe('Loading state (capabilities undefined)', () => {
    it('still renders the trigger with a fallback label for the current mode', () => {
      mockActiveCapabilities.mockReturnValue(undefined);
      render(<PermissionModeItem mode="default" onChangeMode={vi.fn()} sessionId="s1" />);

      const trigger = screen.getByTestId('dropdown-trigger');
      // Fallback label for 'default' is 'Default'
      expect(trigger).toHaveTextContent('Default');
      // No radio items until capabilities load
      const items = screen.getByRole('radiogroup').querySelectorAll('[role="radio"]');
      expect(items).toHaveLength(0);
    });
  });
});
