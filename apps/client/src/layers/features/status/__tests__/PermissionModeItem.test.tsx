// @vitest-environment jsdom
import * as React from 'react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

// ---------------------------------------------------------------------------
// Mock the runtime entity so tests can drive the capabilities the hook reports
// without standing up a full TransportProvider + QueryClient. The component
// resolves capabilities from a `runtime` prop via the static map lookup
// (useCapabilitiesForRuntime); the mock records the requested type so tests
// can assert the prop threads through.
// ---------------------------------------------------------------------------

const mockCapabilitiesForRuntime = vi.fn<
  (runtimeType: string | null | undefined) => RuntimeCapabilities | undefined
>(() => undefined);

vi.mock('@/layers/entities/runtime', () => ({
  useCapabilitiesForRuntime: (runtimeType: string | null | undefined) =>
    mockCapabilitiesForRuntime(runtimeType),
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
  mockCapabilitiesForRuntime.mockReturnValue(undefined);
});

// Import after mocks are set up
import { PermissionModeItem } from '../ui/PermissionModeItem';

// ---------------------------------------------------------------------------
// Capability fixtures — Claude, Codex, and OpenCode mirror the REAL profiles
// in the server adapters' runtime-constants (spec task 4.2 verification
// mandate: the picker must render each runtime's declared modes).
// ---------------------------------------------------------------------------

const CLAUDE_CAPABILITIES: RuntimeCapabilities = {
  type: 'claude-code',
  supportsToolApproval: true,
  supportsCostTracking: true,
  supportsResume: true,
  supportsMcp: true,
  supportsQuestionPrompt: true,
  supportsPlugins: true,
  nativeContext: [],
  permissionModes: {
    supported: true,
    values: [
      { id: 'default', label: 'Default', description: 'Prompt for each tool call' },
      { id: 'acceptEdits', label: 'Accept edits', description: 'Auto-approve file edits' },
      { id: 'plan', label: 'Plan', description: 'Research only, no edits' },
      { id: 'bypassPermissions', label: 'Bypass permissions', description: 'Auto-approve all' },
      { id: 'auto', label: 'Auto', description: 'Classifier approves or denies' },
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
  nativeContext: [],
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

const CODEX_CAPABILITIES: RuntimeCapabilities = {
  type: 'codex',
  supportsToolApproval: false,
  supportsCostTracking: false,
  supportsResume: true,
  supportsMcp: false,
  supportsQuestionPrompt: false,
  supportsPlugins: false,
  nativeContext: [],
  permissionModes: {
    supported: true,
    default: 'default',
    values: [
      { id: 'default', label: 'Read only', description: 'Sandboxed reads.' },
      { id: 'acceptEdits', label: 'Workspace write', description: 'Edits inside the workspace.' },
      { id: 'bypassPermissions', label: 'Full access', description: 'No sandbox.' },
    ],
  },
  features: {},
};

const OPENCODE_CAPABILITIES: RuntimeCapabilities = {
  type: 'opencode',
  supportsToolApproval: true,
  supportsCostTracking: true,
  supportsResume: true,
  supportsMcp: false,
  supportsQuestionPrompt: false,
  supportsPlugins: false,
  nativeContext: [],
  permissionModes: {
    supported: true,
    default: 'default',
    values: [
      { id: 'default', label: 'Default', description: 'Ask before edits.' },
      { id: 'acceptEdits', label: 'Accept edits', description: 'Auto-accept file edits.' },
      { id: 'bypassPermissions', label: 'Bypass permissions', description: 'Skip all prompts.' },
    ],
  },
  features: {},
};

const UNSUPPORTED_CAPABILITIES: RuntimeCapabilities = {
  type: 'no-modes-runtime',
  supportsToolApproval: false,
  supportsCostTracking: false,
  supportsResume: false,
  supportsMcp: false,
  supportsQuestionPrompt: false,
  supportsPlugins: false,
  nativeContext: [],
  permissionModes: { supported: false, values: [] },
  features: {},
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PermissionModeItem', () => {
  describe('Claude-code capabilities', () => {
    it('renders Claude permission modes in the dropdown', () => {
      mockCapabilitiesForRuntime.mockReturnValue(CLAUDE_CAPABILITIES);
      render(<PermissionModeItem mode="default" onChangeMode={vi.fn()} runtime="claude-code" />);

      expect(mockCapabilitiesForRuntime).toHaveBeenCalledWith('claude-code');
      const group = screen.getByRole('radiogroup');
      const items = group.querySelectorAll('[role="radio"]');
      expect(items).toHaveLength(4);
      expect(group).toHaveTextContent('Default');
      expect(group).toHaveTextContent('Accept edits');
      expect(group).toHaveTextContent('Plan');
      expect(group).toHaveTextContent('Bypass permissions');
    });

    it('renders current mode label in trigger', () => {
      mockCapabilitiesForRuntime.mockReturnValue(CLAUDE_CAPABILITIES);
      render(<PermissionModeItem mode="plan" onChangeMode={vi.fn()} runtime="claude-code" />);

      const trigger = screen.getByTestId('dropdown-trigger');
      expect(trigger).toHaveTextContent('Plan');
    });

    it('calls onChangeMode when a mode is selected', async () => {
      mockCapabilitiesForRuntime.mockReturnValue(CLAUDE_CAPABILITIES);
      const user = userEvent.setup();
      const onChangeMode = vi.fn();
      render(
        <PermissionModeItem mode="default" onChangeMode={onChangeMode} runtime="claude-code" />
      );

      const planItem = screen.getByText('Plan');
      await user.click(planItem);
      expect(onChangeMode).toHaveBeenCalledWith('plan');
    });
  });

  describe('Codex capabilities (real profile)', () => {
    it("renders Codex's declared sandbox modes with their own labels", () => {
      mockCapabilitiesForRuntime.mockReturnValue(CODEX_CAPABILITIES);
      render(<PermissionModeItem mode="default" onChangeMode={vi.fn()} runtime="codex" />);

      expect(mockCapabilitiesForRuntime).toHaveBeenCalledWith('codex');
      const group = screen.getByRole('radiogroup');
      const items = group.querySelectorAll('[role="radio"]');
      expect(items).toHaveLength(3);
      expect(group).toHaveTextContent('Read only');
      expect(group).toHaveTextContent('Workspace write');
      expect(group).toHaveTextContent('Full access');
      // Claude-only modes never leak into the Codex picker.
      expect(screen.queryByText('Plan')).not.toBeInTheDocument();
    });

    it("shows Codex's label for the current mode in the trigger, not Claude's fallback", () => {
      mockCapabilitiesForRuntime.mockReturnValue(CODEX_CAPABILITIES);
      render(<PermissionModeItem mode="acceptEdits" onChangeMode={vi.fn()} runtime="codex" />);

      // 'acceptEdits' is 'Workspace write' on Codex — not 'Accept Edits'.
      expect(screen.getByTestId('dropdown-trigger')).toHaveTextContent('Workspace write');
    });
  });

  describe('OpenCode capabilities (real profile)', () => {
    it("renders OpenCode's declared modes (no plan, no auto)", () => {
      mockCapabilitiesForRuntime.mockReturnValue(OPENCODE_CAPABILITIES);
      render(
        <PermissionModeItem
          mode="default"
          onChangeMode={vi.fn()}
          runtime="opencode"
          modelSupportsAutoMode
        />
      );

      expect(mockCapabilitiesForRuntime).toHaveBeenCalledWith('opencode');
      const group = screen.getByRole('radiogroup');
      const items = group.querySelectorAll('[role="radio"]');
      expect(items).toHaveLength(3);
      expect(group).toHaveTextContent('Default');
      expect(group).toHaveTextContent('Accept edits');
      expect(group).toHaveTextContent('Bypass permissions');
      expect(screen.queryByText('Plan')).not.toBeInTheDocument();
      expect(group.querySelector('[data-radio-value="auto"]')).toBeNull();
    });
  });

  describe("'auto' per-model gating", () => {
    it("renders 'auto' when modelSupportsAutoMode is true", () => {
      mockCapabilitiesForRuntime.mockReturnValue(CLAUDE_CAPABILITIES);
      render(
        <PermissionModeItem
          mode="default"
          onChangeMode={vi.fn()}
          runtime="claude-code"
          modelSupportsAutoMode
        />
      );

      const group = screen.getByRole('radiogroup');
      const items = group.querySelectorAll('[role="radio"]');
      expect(items).toHaveLength(5);
      expect(group).toHaveTextContent('Auto');
      // No explanatory hint when 'auto' is available
      expect(screen.queryByTestId('auto-unsupported-hint')).not.toBeInTheDocument();
    });

    it("hides 'auto' and shows the explanatory tooltip when modelSupportsAutoMode is false", () => {
      mockCapabilitiesForRuntime.mockReturnValue(CLAUDE_CAPABILITIES);
      render(
        <PermissionModeItem
          mode="default"
          onChangeMode={vi.fn()}
          runtime="claude-code"
          modelSupportsAutoMode={false}
        />
      );

      const group = screen.getByRole('radiogroup');
      const items = group.querySelectorAll('[role="radio"]');
      // Four native modes remain; 'auto' is filtered out.
      expect(items).toHaveLength(4);
      const autoRadio = group.querySelector('[data-radio-value="auto"]');
      expect(autoRadio).toBeNull();
      // Explanatory tooltip is present.
      expect(screen.getByTestId('auto-unsupported-hint')).toBeInTheDocument();
      expect(screen.getByTestId('tooltip-content')).toHaveTextContent(
        'Auto mode requires Opus 4.6+ or Sonnet 4.6'
      );
    });

    it("renders a 'Preview' tag on the Auto option", () => {
      mockCapabilitiesForRuntime.mockReturnValue(CLAUDE_CAPABILITIES);
      render(
        <PermissionModeItem
          mode="default"
          onChangeMode={vi.fn()}
          runtime="claude-code"
          modelSupportsAutoMode
        />
      );

      const group = screen.getByRole('radiogroup');
      const autoRadio = group.querySelector('[data-radio-value="auto"]');
      expect(autoRadio).not.toBeNull();
      expect(autoRadio).toHaveTextContent('Preview');
    });
  });

  describe('Test-mode capabilities', () => {
    it('renders test-mode permission modes (always-allow, always-deny, scripted)', () => {
      mockCapabilitiesForRuntime.mockReturnValue(TEST_MODE_CAPABILITIES);
      render(
        <PermissionModeItem
          mode={'always-allow' as never}
          onChangeMode={vi.fn()}
          runtime="test-mode"
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
      mockCapabilitiesForRuntime.mockReturnValue(TEST_MODE_CAPABILITIES);
      render(
        <PermissionModeItem
          mode={'always-allow' as never}
          onChangeMode={vi.fn()}
          runtime="test-mode"
        />
      );

      expect(screen.queryByText('Accept edits')).not.toBeInTheDocument();
      expect(screen.queryByText('Plan')).not.toBeInTheDocument();
      expect(screen.queryByText('Bypass permissions')).not.toBeInTheDocument();
    });
  });

  describe('permissionModes.supported gating', () => {
    it('hides the picker entirely when permissionModes.supported is false', () => {
      mockCapabilitiesForRuntime.mockReturnValue(UNSUPPORTED_CAPABILITIES);
      const { container } = render(
        <PermissionModeItem mode="default" onChangeMode={vi.fn()} runtime="no-modes-runtime" />
      );

      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
      expect(screen.queryByTestId('dropdown-trigger')).not.toBeInTheDocument();
    });
  });

  describe('Server-default fallback (no runtime)', () => {
    it('resolves the server-default runtime when the runtime prop is omitted', () => {
      mockCapabilitiesForRuntime.mockReturnValue(CLAUDE_CAPABILITIES);
      render(<PermissionModeItem mode="default" onChangeMode={vi.fn()} />);

      // Nullish runtime → the lookup falls back to the server default.
      expect(mockCapabilitiesForRuntime).toHaveBeenCalledWith(undefined);
      const group = screen.getByRole('radiogroup');
      const items = group.querySelectorAll('[role="radio"]');
      expect(items).toHaveLength(4);
      expect(group).toHaveTextContent('Default');
    });
  });

  describe('Disabled state', () => {
    it('shows disabled trigger with tooltip when disabled=true', () => {
      mockCapabilitiesForRuntime.mockReturnValue(CLAUDE_CAPABILITIES);
      render(
        <PermissionModeItem mode="default" onChangeMode={vi.fn()} disabled runtime="claude-code" />
      );

      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
      expect(screen.getByText('Send a message first')).toBeInTheDocument();
      expect(screen.queryByTestId('dropdown-root')).not.toBeInTheDocument();
    });
  });

  describe('Loading state (capabilities undefined)', () => {
    it('still renders the trigger with a fallback label for the current mode', () => {
      mockCapabilitiesForRuntime.mockReturnValue(undefined);
      render(<PermissionModeItem mode="default" onChangeMode={vi.fn()} runtime="claude-code" />);

      const trigger = screen.getByTestId('dropdown-trigger');
      // Fallback label for 'default' is 'Default'
      expect(trigger).toHaveTextContent('Default');
      // No radio items until capabilities load
      const items = screen.getByRole('radiogroup').querySelectorAll('[role="radio"]');
      expect(items).toHaveLength(0);
    });
  });
});
