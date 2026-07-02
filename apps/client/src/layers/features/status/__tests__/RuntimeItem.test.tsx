// @vitest-environment jsdom
import * as React from 'react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

// ---------------------------------------------------------------------------
// Mock the runtime entity hooks so tests can drive the registered-runtime map
// without a TransportProvider + QueryClient. The descriptor registry
// (getRuntimeDescriptor) stays REAL via importOriginal so label/icon
// assertions exercise the actual visual-identity source.
// ---------------------------------------------------------------------------

type CapabilitiesMap = {
  capabilities: Record<string, RuntimeCapabilities>;
  defaultRuntime: string;
};

const mockRuntimeCapabilities = vi.fn<() => { data: CapabilitiesMap | undefined }>(() => ({
  data: undefined,
}));

vi.mock('@/layers/entities/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/runtime')>()),
  useRuntimeCapabilities: () => mockRuntimeCapabilities(),
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
    }: {
      children: React.ReactNode;
      value: string;
      icon?: React.ComponentType;
      description?: string;
      className?: string;
    }) => (
      <div role="radio" aria-checked={false} data-radio-value={value}>
        <span>{children}</span>
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
  mockRuntimeCapabilities.mockReturnValue({ data: undefined });
});

// Import after mocks are set up
import { RuntimeItem } from '../ui/RuntimeItem';

// ---------------------------------------------------------------------------
// Capability fixtures — only the map KEYS matter to RuntimeItem; the values
// satisfy the RuntimeCapabilities interface.
// ---------------------------------------------------------------------------

function makeCaps(type: string): RuntimeCapabilities {
  return {
    type,
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
}

function capsMap(defaultRuntime: string, ...types: string[]): CapabilitiesMap {
  return {
    capabilities: Object.fromEntries(types.map((t) => [t, makeCaps(t)])),
    defaultRuntime,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RuntimeItem', () => {
  describe('read-only after session start (canSelect=false)', () => {
    it('renders the runtime identity with no dropdown and a fixed-runtime tooltip', () => {
      mockRuntimeCapabilities.mockReturnValue({
        data: capsMap('claude-code', 'claude-code', 'codex'),
      });
      render(<RuntimeItem runtime="claude-code" onChangeRuntime={vi.fn()} canSelect={false} />);

      expect(screen.getByText('Claude Code')).toBeInTheDocument();
      expect(screen.queryByTestId('dropdown-root')).not.toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(screen.getByTestId('tooltip-content')).toHaveTextContent(
        'Runtime is fixed once a session starts'
      );
    });

    it("displays the runtime prop's identity — the session row's bound runtime", () => {
      // The render site passes the session row's server-authoritative runtime
      // once started; the chip must show exactly that, even with multiple
      // runtimes registered and a different server default.
      mockRuntimeCapabilities.mockReturnValue({
        data: capsMap('claude-code', 'claude-code', 'codex'),
      });
      render(<RuntimeItem runtime="codex" onChangeRuntime={vi.fn()} canSelect={false} />);

      expect(screen.getByText('Codex')).toBeInTheDocument();
      expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();
    });
  });

  describe('pre-launch selection (canSelect=true, >1 registered runtime)', () => {
    it('renders a dropdown listing every registered runtime', () => {
      mockRuntimeCapabilities.mockReturnValue({
        data: capsMap('claude-code', 'claude-code', 'codex'),
      });
      render(<RuntimeItem runtime="claude-code" onChangeRuntime={vi.fn()} canSelect={true} />);

      expect(screen.getByTestId('dropdown-root')).toBeInTheDocument();
      const group = screen.getByRole('radiogroup');
      const items = group.querySelectorAll('[role="radio"]');
      expect(items).toHaveLength(2);
      expect(group).toHaveTextContent('Claude Code');
      expect(group).toHaveTextContent('Codex');
    });

    it('shows the selected runtime in the trigger (e.g. ?runtime=codex pre-launch)', () => {
      mockRuntimeCapabilities.mockReturnValue({
        data: capsMap('claude-code', 'claude-code', 'codex'),
      });
      render(<RuntimeItem runtime="codex" onChangeRuntime={vi.fn()} canSelect={true} />);

      // The trigger reflects the SELECTION, not the server default.
      expect(screen.getByTestId('dropdown-trigger')).toHaveTextContent('Codex');
      expect(screen.getByRole('radiogroup').getAttribute('data-value')).toBe('codex');
    });

    it('calls onChangeRuntime with the chosen runtime type', async () => {
      mockRuntimeCapabilities.mockReturnValue({
        data: capsMap('claude-code', 'claude-code', 'codex'),
      });
      const user = userEvent.setup();
      const onChangeRuntime = vi.fn();
      render(
        <RuntimeItem runtime="claude-code" onChangeRuntime={onChangeRuntime} canSelect={true} />
      );

      const group = screen.getByRole('radiogroup');
      const codexItem = group.querySelector('[data-radio-value="codex"]')!;
      await user.click(codexItem);
      expect(onChangeRuntime).toHaveBeenCalledWith('codex');
    });
  });

  describe('single registered runtime (canSelect=true)', () => {
    it('renders a quiet identity chip with no dropdown affordance', () => {
      mockRuntimeCapabilities.mockReturnValue({ data: capsMap('claude-code', 'claude-code') });
      render(<RuntimeItem runtime="claude-code" onChangeRuntime={vi.fn()} canSelect={true} />);

      expect(screen.getByText('Claude Code')).toBeInTheDocument();
      expect(screen.queryByTestId('dropdown-root')).not.toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      // No fixed-runtime tooltip — nothing is locked, there is just one choice.
      expect(screen.queryByTestId('tooltip-content')).not.toBeInTheDocument();
    });
  });

  describe('unknown runtime type', () => {
    it('degrades to the neutral descriptor fallback (raw type as label)', () => {
      mockRuntimeCapabilities.mockReturnValue({ data: capsMap('claude-code', 'claude-code') });
      render(<RuntimeItem runtime="mystery-rt" onChangeRuntime={vi.fn()} canSelect={true} />);

      expect(screen.getByText('mystery-rt')).toBeInTheDocument();
    });
  });

  describe('loading state (capabilities undefined)', () => {
    it('falls back to the runtime prop and renders read-only while the list loads', () => {
      render(<RuntimeItem runtime="claude-code" onChangeRuntime={vi.fn()} canSelect={true} />);

      expect(screen.getByText('Claude Code')).toBeInTheDocument();
      expect(screen.queryByTestId('dropdown-root')).not.toBeInTheDocument();
    });
  });
});
