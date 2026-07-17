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
// assertions exercise the actual visual-identity source. RuntimeSetupDialog is
// stubbed (it has its own test file) so "opens the requirements panel" is
// observable without dialog internals.
// ---------------------------------------------------------------------------

import type { SystemRequirements } from '@dorkos/shared/agent-runtime';

type CapabilitiesMap = {
  capabilities: Record<string, RuntimeCapabilities>;
  defaultRuntime: string;
};

const mockRuntimeCapabilities = vi.fn<() => { data: CapabilitiesMap | undefined }>(() => ({
  data: undefined,
}));

const mockRuntimeRequirements = vi.fn<() => { data: SystemRequirements | undefined }>(() => ({
  data: undefined,
}));

vi.mock('@/layers/entities/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/runtime')>()),
  useRuntimeCapabilities: () => mockRuntimeCapabilities(),
  useRuntimeRequirements: () => mockRuntimeRequirements(),
  // The stub exposes a button that fires onRuntimeReady so tests can simulate a
  // connect succeeding without dialog internals (real behaviour lives in the
  // dialog's own test file).
  RuntimeSetupDialog: ({
    runtime,
    open,
    onRuntimeReady,
  }: {
    runtime?: string;
    open: boolean;
    onRuntimeReady?: (type: string) => void;
  }) =>
    open ? (
      <div data-testid="runtime-setup-dialog" data-runtime={runtime ?? ''}>
        <button
          data-testid="simulate-runtime-ready"
          onClick={() => runtime && onRuntimeReady?.(runtime)}
        />
      </div>
    ) : null,
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
    ResponsiveDropdownMenuItem: ({
      children,
      description,
      onSelect,
    }: {
      children: React.ReactNode;
      icon?: React.ComponentType;
      description?: string;
      className?: string;
      onSelect?: () => void;
    }) => (
      <button data-testid="dropdown-item" data-description={description} onClick={onSelect}>
        <span>{children}</span>
        {description && <span>{description}</span>}
      </button>
    ),
    ResponsiveDropdownMenuSeparator: () => <hr data-testid="dropdown-separator" />,
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
  mockRuntimeRequirements.mockReturnValue({ data: undefined });
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
    commandIntents: { compact: { supported: false } },
    features: {},
  };
}

function capsMap(defaultRuntime: string, ...types: string[]): CapabilitiesMap {
  return {
    capabilities: Object.fromEntries(types.map((t) => [t, makeCaps(t)])),
    defaultRuntime,
  };
}

/**
 * Requirements fixture: every listed runtime gets one dependency with the
 * given status ('satisfied' unless listed in `missing`).
 */
function requirementsFor(types: string[], missing: string[] = []): SystemRequirements {
  return {
    runtimes: Object.fromEntries(
      types.map((t) => [
        t,
        {
          dependencies: [
            {
              name: `${t} CLI`,
              description: `The ${t} binary.`,
              status: missing.includes(t) ? ('missing' as const) : ('satisfied' as const),
              ...(missing.includes(t) ? { installHint: `install ${t}` } : {}),
            },
          ],
        },
      ])
    ),
    allSatisfied: missing.length === 0,
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
        "The runtime is set when a session starts and can't be changed afterward."
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

    it('renders identity as runtime · model when a model is resolved (spec decision 8)', () => {
      // A started OpenCode session on ollama/qwen2.5-coder reads its full identity.
      mockRuntimeCapabilities.mockReturnValue({
        data: capsMap('claude-code', 'claude-code', 'opencode'),
      });
      render(
        <RuntimeItem
          runtime="opencode"
          model="ollama/qwen2.5-coder"
          onChangeRuntime={vi.fn()}
          canSelect={false}
        />
      );

      expect(screen.getByText('OpenCode · qwen2.5-coder')).toBeInTheDocument();
    });

    it('degrades to the runtime alone when no model is resolved', () => {
      mockRuntimeCapabilities.mockReturnValue({
        data: capsMap('claude-code', 'claude-code', 'opencode'),
      });
      render(
        <RuntimeItem runtime="opencode" model={null} onChangeRuntime={vi.fn()} canSelect={false} />
      );

      expect(screen.getByText('OpenCode')).toBeInTheDocument();
      expect(screen.queryByText(/·/)).not.toBeInTheDocument();
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
    it('still renders the dropdown so "Add a runtime" stays reachable', () => {
      // With one registered runtime there is nothing to switch to, but known
      // addable runtimes (Codex, OpenCode) exist — the picker is the only
      // discovery surface for them, so it must not collapse to a quiet chip
      // (spec additional-agent-runtimes, 4.2 reachability fold-in).
      mockRuntimeCapabilities.mockReturnValue({ data: capsMap('claude-code', 'claude-code') });
      render(<RuntimeItem runtime="claude-code" onChangeRuntime={vi.fn()} canSelect={true} />);

      expect(screen.getByTestId('dropdown-root')).toBeInTheDocument();
      // The single registered runtime is the only radio option...
      const group = screen.getByRole('radiogroup');
      expect(group.querySelectorAll('[role="radio"]')).toHaveLength(1);
      expect(group).toHaveTextContent('Claude Code');
      // ...and the Add-a-runtime entry is present.
      const addItem = screen
        .getAllByTestId('dropdown-item')
        .find((el) => el.textContent?.includes('Add a runtime'));
      expect(addItem).toBeDefined();
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

  describe('needs-setup state (registered runtime with failing checks)', () => {
    it('renders the unsatisfied runtime as a guided needs-setup entry, not a selectable option', () => {
      mockRuntimeCapabilities.mockReturnValue({
        data: capsMap('claude-code', 'claude-code', 'codex'),
      });
      mockRuntimeRequirements.mockReturnValue({
        data: requirementsFor(['claude-code', 'codex'], ['codex']),
      });
      render(<RuntimeItem runtime="claude-code" onChangeRuntime={vi.fn()} canSelect={true} />);

      // The satisfied runtime stays a selectable radio option...
      const group = screen.getByRole('radiogroup');
      expect(group.querySelectorAll('[role="radio"]')).toHaveLength(1);
      expect(group).toHaveTextContent('Claude Code');
      // ...while the unsatisfied one is a needs-setup entry outside the group.
      const setupItems = screen
        .getAllByTestId('dropdown-item')
        .filter((el) => el.getAttribute('data-description') === 'Connect');
      expect(setupItems).toHaveLength(1);
      expect(setupItems[0]).toHaveTextContent('Codex');
    });

    it('opens the requirements panel scoped to the runtime instead of selecting it', async () => {
      mockRuntimeCapabilities.mockReturnValue({
        data: capsMap('claude-code', 'claude-code', 'codex'),
      });
      mockRuntimeRequirements.mockReturnValue({
        data: requirementsFor(['claude-code', 'codex'], ['codex']),
      });
      const user = userEvent.setup();
      const onChangeRuntime = vi.fn();
      render(
        <RuntimeItem runtime="claude-code" onChangeRuntime={onChangeRuntime} canSelect={true} />
      );

      const codexItem = screen
        .getAllByTestId('dropdown-item')
        .find((el) => el.getAttribute('data-description') === 'Connect')!;
      await user.click(codexItem);

      expect(screen.getByTestId('runtime-setup-dialog')).toHaveAttribute('data-runtime', 'codex');
      expect(onChangeRuntime).not.toHaveBeenCalled();
    });

    it('selects the runtime and closes the dialog once connect succeeds', async () => {
      // The two-step trap fix: connecting a not-ready runtime from the picker
      // must select it (and close), not drop the user back to re-pick it.
      mockRuntimeCapabilities.mockReturnValue({
        data: capsMap('claude-code', 'claude-code', 'codex'),
      });
      mockRuntimeRequirements.mockReturnValue({
        data: requirementsFor(['claude-code', 'codex'], ['codex']),
      });
      const user = userEvent.setup();
      const onChangeRuntime = vi.fn();
      render(
        <RuntimeItem runtime="claude-code" onChangeRuntime={onChangeRuntime} canSelect={true} />
      );

      // Open the Connect dialog scoped to codex.
      const codexItem = screen
        .getAllByTestId('dropdown-item')
        .find((el) => el.getAttribute('data-description') === 'Connect')!;
      await user.click(codexItem);
      expect(screen.getByTestId('runtime-setup-dialog')).toHaveAttribute('data-runtime', 'codex');

      // Connect succeeds → the dialog reports ready → select codex and close.
      await user.click(screen.getByTestId('simulate-runtime-ready'));
      expect(onChangeRuntime).toHaveBeenCalledWith('codex');
      expect(screen.queryByTestId('runtime-setup-dialog')).not.toBeInTheDocument();
    });

    it('keeps every registered runtime selectable while requirements are still loading', () => {
      // Optimistic: never flash needs-setup before the checks resolve.
      mockRuntimeCapabilities.mockReturnValue({
        data: capsMap('claude-code', 'claude-code', 'codex'),
      });
      mockRuntimeRequirements.mockReturnValue({ data: undefined });
      render(<RuntimeItem runtime="claude-code" onChangeRuntime={vi.fn()} canSelect={true} />);

      const group = screen.getByRole('radiogroup');
      expect(group.querySelectorAll('[role="radio"]')).toHaveLength(2);
      expect(
        screen
          .queryAllByTestId('dropdown-item')
          .filter((el) => el.getAttribute('data-description') === 'Connect')
      ).toHaveLength(0);
    });
  });

  describe('"Add a runtime" entry point', () => {
    it('appears when a known runtime with setup steps is not registered', async () => {
      // opencode is a known addable runtime but absent from the capability map.
      mockRuntimeCapabilities.mockReturnValue({
        data: capsMap('claude-code', 'claude-code', 'codex'),
      });
      mockRuntimeRequirements.mockReturnValue({
        data: requirementsFor(['claude-code', 'codex']),
      });
      const user = userEvent.setup();
      render(<RuntimeItem runtime="claude-code" onChangeRuntime={vi.fn()} canSelect={true} />);

      const addItem = screen
        .getAllByTestId('dropdown-item')
        .find((el) => el.textContent?.includes('Add a runtime'))!;
      expect(addItem).toBeDefined();

      // Selecting it opens the unscoped requirements overview.
      await user.click(addItem);
      expect(screen.getByTestId('runtime-setup-dialog')).toHaveAttribute('data-runtime', '');
    });

    it('is absent when every known runtime is already registered', () => {
      mockRuntimeCapabilities.mockReturnValue({
        data: capsMap('claude-code', 'claude-code', 'codex', 'opencode'),
      });
      mockRuntimeRequirements.mockReturnValue({
        data: requirementsFor(['claude-code', 'codex', 'opencode']),
      });
      render(<RuntimeItem runtime="claude-code" onChangeRuntime={vi.fn()} canSelect={true} />);

      expect(
        screen.queryAllByTestId('dropdown-item').filter((el) => {
          return el.textContent?.includes('Add a runtime');
        })
      ).toHaveLength(0);
      expect(screen.queryByTestId('dropdown-separator')).not.toBeInTheDocument();
    });
  });
});
