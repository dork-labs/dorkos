// @vitest-environment jsdom
import * as React from 'react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render as rtlRender, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider, useClaudeAccounts } from '@/layers/shared/model';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import type { ServerConfig } from '@dorkos/shared/types';

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
      // Forwarded exactly as the real primitive forwards it, so the accessible
      // description this menu depends on is observable here.
      'aria-describedby': describedBy,
    }: {
      children: React.ReactNode;
      value?: string;
      onValueChange?: (v: string) => void;
      'aria-describedby'?: string;
      [key: string]: unknown;
    }) => (
      <div
        role="radiogroup"
        data-value={value}
        aria-describedby={describedBy}
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
    }: {
      children: React.ReactNode;
      value: string;
      icon?: React.ComponentType;
      description?: string;
      className?: string;
    }) => (
      <div role="radio" aria-checked={false} data-radio-value={value}>
        <span>{children}</span>
        {description && <span data-testid="radio-description">{description}</span>}
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
  mockServerConfig = {};
});

// Import after mocks are set up
import { RuntimeItem } from '../ui/RuntimeItem';

/**
 * What `GET /api/config` answers for the current test. The chip reads the
 * registered Claude accounts from here (spec `claude-code-accounts` D6); the
 * runtime cases leave it empty, which is a default install.
 */
let mockServerConfig: Partial<ServerConfig> = {};

/**
 * Render with the providers the chip's config read needs. Shadows RTL's `render`
 * so every existing case gets them without repeating the wrapper.
 */
function render(ui: React.ReactElement) {
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue(mockServerConfig),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(ui, {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    ),
  });
}

/**
 * Reports what the shared accounts hook currently knows.
 *
 * Mounted alongside the chip so a test can wait for the config read to LAND
 * before asserting the account group is ABSENT. Waiting on the menu itself proves
 * nothing: the dropdown renders on the first pass, while the config query is
 * still in flight, so the absence assertion would run before the state it is
 * about even exists and could never fail.
 */
function AccountsProbe() {
  const { accounts } = useClaudeAccounts();
  return <span data-testid="accounts-known">{accounts.length}</span>;
}

/** Server config registering `count` named Claude accounts, the first one active. */
function withAccounts(count: number): Partial<ServerConfig> {
  const all = [
    {
      id: 'personal',
      path: '/Users/dev/.claude',
      label: 'Personal',
      color: '#3b82f6',
      colorIsDefault: true,
      isAccountRoot: true,
    },
    {
      id: 'acme-corp',
      path: '/Users/dev/.claude2',
      label: 'Acme Corp',
      color: '#3b82f6',
      colorIsDefault: true,
      isAccountRoot: true,
    },
  ];
  return {
    claudeCode: {
      resolvedAccount: '/Users/dev/.claude',
      inherited: true,
      accounts: all.slice(0, count),
    },
  };
}

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
    supportsManagedMcpServers: false,
    supportsQuestionPrompt: false,
    supportsPlugins: false,
    supportsAccounts: false,
    supportsPersistentSession: false,
    supportsSteer: false,
    supportsContextStaging: false,
    mediaOutput: 'none',
    nativeContext: [],
    permissionModes: { supported: false, values: [] },
    commandIntents: { compact: { supported: false } },
    settings: { configSection: null, supportsEffort: false, sections: [] },
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
        'The runtime is set when a session starts and can’t be changed afterward.'
      );
    });

    it('displays the runtime prop’s identity — the session row’s bound runtime', () => {
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

  describe('compact (below the status line’s widest tier)', () => {
    it('drops the model half — the line’s own model item already says it', () => {
      // "OpenCode · qwen2.5-coder" measured ~155px in Chromium: a third of a phone
      // status line spent saying the thing two slots over already says (DOR-452).
      mockRuntimeCapabilities.mockReturnValue({
        data: capsMap('claude-code', 'claude-code', 'opencode'),
      });
      render(
        <RuntimeItem
          runtime="opencode"
          model="ollama/qwen2.5-coder"
          onChangeRuntime={vi.fn()}
          canSelect={false}
          compact
        />
      );

      expect(screen.getByText('OpenCode')).toBeInTheDocument();
      expect(screen.queryByText(/qwen2\.5-coder/)).not.toBeInTheDocument();
    });

    it('drops it in the selectable trigger too', () => {
      mockRuntimeCapabilities.mockReturnValue({
        data: capsMap('claude-code', 'claude-code', 'opencode'),
      });
      render(
        <RuntimeItem
          runtime="opencode"
          model="ollama/qwen2.5-coder"
          onChangeRuntime={vi.fn()}
          canSelect
          compact
        />
      );

      expect(screen.getByRole('button', { name: 'OpenCode' })).toBeInTheDocument();
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

    it('hands off the runtime once connect succeeds, leaving the dialog on its success moment', async () => {
      // The two-step trap fix: connecting a not-ready runtime from the picker
      // selects it (the handoff — sets pendingRuntime) so the first send binds to
      // it. The dialog now stays open on its explicit success panel (Done closes
      // it), so onRuntimeReady no longer silently auto-closes (spec §6).
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

      // Connect succeeds → the dialog reports ready → the runtime is handed off,
      // and the dialog remains open (its success panel's Done owns closing).
      await user.click(screen.getByTestId('simulate-runtime-ready'));
      expect(onChangeRuntime).toHaveBeenCalledWith('codex');
      expect(screen.getByTestId('runtime-setup-dialog')).toBeInTheDocument();
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

  // The account is chosen on its own chip now (`AccountItem`, spec
  // `claude-account-ui` §6.1): one place for one choice.
  describe('no account group', () => {
    it('offers runtimes only, even with two Claude accounts registered', async () => {
      mockServerConfig = withAccounts(2);
      mockRuntimeCapabilities.mockReturnValue({
        data: capsMap('claude-code', 'claude-code', 'codex', 'opencode'),
      });
      mockRuntimeRequirements.mockReturnValue({
        data: requirementsFor(['claude-code', 'codex', 'opencode']),
      });
      render(
        <>
          <AccountsProbe />
          <RuntimeItem runtime="claude-code" onChangeRuntime={vi.fn()} canSelect={true} />
        </>
      );

      // Wait for the CONFIG, not the menu: the dropdown is on screen before the
      // accounts are known, so an absence asserted earlier could never fail.
      await waitFor(() => expect(screen.getByTestId('accounts-known')).toHaveTextContent('2'));
      expect(screen.getAllByRole('radiogroup')).toHaveLength(1);
      expect(screen.queryByText('Acme Corp')).not.toBeInTheDocument();
      expect(screen.queryByTestId('account-scope-note')).not.toBeInTheDocument();
      expect(screen.queryAllByTestId('dropdown-label').map((el) => el.textContent)).not.toContain(
        'Account'
      );
    });
  });
});

// ---------------------------------------------------------------------------
// DOR-1970 — which account THIS session is spending, from the composer.
//
// FB-13 asked for it "in the composer somewhere (even if it's just a tooltip)".
// DOR-729 shipped `AccountMark`, but only onto session ROWS, so the chip a
// person composes next to could not answer the question at all.
// ---------------------------------------------------------------------------

describe('RuntimeItem — the account this session bills to (DOR-1970)', () => {
  it('names the account in the fixed-runtime tooltip of a started session', async () => {
    mockServerConfig = withAccounts(2);
    mockRuntimeCapabilities.mockReturnValue({ data: capsMap('claude-code', 'claude-code') });
    render(
      <>
        <AccountsProbe />
        <RuntimeItem
          runtime="claude-code"
          onChangeRuntime={vi.fn()}
          canSelect={false}
          account="/Users/dev/.claude2"
        />
      </>
    );

    await waitFor(() => expect(screen.getByTestId('accounts-known')).toHaveTextContent('2'));
    // Both facts, in one tooltip: why the runtime cannot be changed, and which
    // account the turn you are about to send will be billed to.
    await waitFor(() =>
      expect(screen.getByTestId('tooltip-content')).toHaveTextContent('Account: Acme Corp')
    );
    expect(screen.getByTestId('tooltip-content')).toHaveTextContent(
      'The runtime is set when a session starts and can’t be changed afterward.'
    );
  });

  it('falls back to the directory name for an account the roster does not know', async () => {
    // `defaultAccount` can be set by hand in `~/.dork/config.json`, and the
    // server honours it whether or not it is on the roster — so this is an
    // ordinary case, and the tooltip must not render a bare "Account: ".
    mockServerConfig = withAccounts(1);
    mockRuntimeCapabilities.mockReturnValue({ data: capsMap('claude-code', 'claude-code') });
    render(
      <>
        <AccountsProbe />
        <RuntimeItem
          runtime="claude-code"
          onChangeRuntime={vi.fn()}
          canSelect={false}
          account="/Users/dev/.claude-unregistered"
        />
      </>
    );

    await waitFor(() => expect(screen.getByTestId('accounts-known')).toHaveTextContent('1'));
    await waitFor(() =>
      expect(screen.getByTestId('tooltip-content')).toHaveTextContent(
        'Account: .claude-unregistered'
      )
    );
  });

  it('says nothing about an account when the session has none', async () => {
    // Pre-launch, and every runtime with no account concept. An invented line
    // here would be worse than silence.
    mockServerConfig = withAccounts(2);
    mockRuntimeCapabilities.mockReturnValue({ data: capsMap('claude-code', 'claude-code') });
    render(
      <>
        <AccountsProbe />
        <RuntimeItem
          runtime="claude-code"
          onChangeRuntime={vi.fn()}
          canSelect={false}
          account={null}
        />
      </>
    );

    await waitFor(() => expect(screen.getByTestId('accounts-known')).toHaveTextContent('2'));
    expect(screen.getByTestId('tooltip-content')).not.toHaveTextContent('Account:');
  });
});
