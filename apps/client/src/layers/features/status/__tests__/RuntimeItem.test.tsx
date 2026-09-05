// @vitest-environment jsdom
import * as React from 'react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render as rtlRender, screen, cleanup, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import {
  TransportProvider,
  configKeys,
  useAppStore,
  useClaudeAccounts,
} from '@/layers/shared/model';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import type { ServerConfig } from '@dorkos/shared/types';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

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
  mockAgent = null;
  // The account pick is shared app state, so a test that leaves one behind would
  // hand the next one a hint it never made. `selectedCwd` likewise decides
  // whether the agent tier is even consulted.
  useAppStore.setState({ pendingAccount: null, pendingRuntime: null, selectedCwd: null });
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
 * The session under test. A pick is stored against it, so a case about leakage
 * renders a DIFFERENT id and asserts the pick is neither shown nor sent.
 */
const SESSION = 'session-a';

/** The transport the most recent {@link render} handed the tree, for write assertions. */
let lastTransport: ReturnType<typeof createMockTransport>;

/** That render's query cache, so a test can move the server's answer under a live tree. */
let lastQueryClient: QueryClient;

/**
 * The agent registered at the working directory the launch would resolve
 * against, as `getAgentByPath` answers it. `null` is "no agent here", which is
 * every case that is not about the ladder's agent tier.
 */
let mockAgent: AgentManifest | null = null;

/**
 * The agent at the launch directory, in the only detail this surface reads: the
 * account it is pinned to. Everything else is filler the manifest type demands.
 */
function agentPinnedTo(account: string | undefined): AgentManifest {
  return {
    workspace: { mode: 'home' },
    id: 'agent-1',
    name: 'Worker',
    description: 'An agent registered at the launch directory.',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: '2026-01-01T00:00:00.000Z',
    registeredBy: 'test',
    personaEnabled: true,
    enabledToolGroups: {},
    mcpServers: [],
    ...(account === undefined ? {} : { account }),
  };
}

/**
 * Render with the providers the chip's config read needs. Shadows RTL's `render`
 * so every existing case gets them without repeating the wrapper.
 */
function render(ui: React.ReactElement) {
  return renderWithAgent(ui, () => Promise.resolve(mockAgent));
}

/**
 * As {@link render}, but the caller drives when — and whether — the agent
 * manifest read answers. Needed to observe the state BEFORE it lands, which is
 * the only state in which the default row must stay unnamed.
 */
function renderWithAgent(ui: React.ReactElement, getAgent: () => Promise<AgentManifest | null>) {
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue(mockServerConfig),
    // Present so a test can assert the picker calls it NOT AT ALL: the account
    // choice is session-scoped now and writes no config (spec
    // `billing-account-ladder`).
    updateConfig: vi.fn(() => Promise.resolve()),
    getAgentByPath: vi.fn(getAgent),
  });
  lastTransport = transport;
  lastQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const queryClient = lastQueryClient;
  return rtlRender(ui, {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    ),
  });
}

/** A promise plus the handle to settle it, for holding a query open on purpose. */
function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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
    { id: 'personal', path: '/Users/dev/.claude', label: 'Personal', isAccountRoot: true },
    { id: 'acme-corp', path: '/Users/dev/.claude2', label: 'Acme Corp', isAccountRoot: true },
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
      render(
        <RuntimeItem
          sessionId={SESSION}
          runtime="claude-code"
          onChangeRuntime={vi.fn()}
          canSelect={false}
        />
      );

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
      render(
        <RuntimeItem
          sessionId={SESSION}
          runtime="codex"
          onChangeRuntime={vi.fn()}
          canSelect={false}
        />
      );

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
          sessionId={SESSION}
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
        <RuntimeItem
          sessionId={SESSION}
          runtime="opencode"
          model={null}
          onChangeRuntime={vi.fn()}
          canSelect={false}
        />
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
          sessionId={SESSION}
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
          sessionId={SESSION}
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
      render(
        <RuntimeItem
          sessionId={SESSION}
          runtime="claude-code"
          onChangeRuntime={vi.fn()}
          canSelect={true}
        />
      );

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
      render(
        <RuntimeItem
          sessionId={SESSION}
          runtime="codex"
          onChangeRuntime={vi.fn()}
          canSelect={true}
        />
      );

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
        <RuntimeItem
          sessionId={SESSION}
          runtime="claude-code"
          onChangeRuntime={onChangeRuntime}
          canSelect={true}
        />
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
      render(
        <RuntimeItem
          sessionId={SESSION}
          runtime="claude-code"
          onChangeRuntime={vi.fn()}
          canSelect={true}
        />
      );

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
      render(
        <RuntimeItem
          sessionId={SESSION}
          runtime="mystery-rt"
          onChangeRuntime={vi.fn()}
          canSelect={true}
        />
      );

      expect(screen.getByText('mystery-rt')).toBeInTheDocument();
    });
  });

  describe('loading state (capabilities undefined)', () => {
    it('falls back to the runtime prop and renders read-only while the list loads', () => {
      render(
        <RuntimeItem
          sessionId={SESSION}
          runtime="claude-code"
          onChangeRuntime={vi.fn()}
          canSelect={true}
        />
      );

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
      render(
        <RuntimeItem
          sessionId={SESSION}
          runtime="claude-code"
          onChangeRuntime={vi.fn()}
          canSelect={true}
        />
      );

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
        <RuntimeItem
          sessionId={SESSION}
          runtime="claude-code"
          onChangeRuntime={onChangeRuntime}
          canSelect={true}
        />
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
        <RuntimeItem
          sessionId={SESSION}
          runtime="claude-code"
          onChangeRuntime={onChangeRuntime}
          canSelect={true}
        />
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
      render(
        <RuntimeItem
          sessionId={SESSION}
          runtime="claude-code"
          onChangeRuntime={vi.fn()}
          canSelect={true}
        />
      );

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
      render(
        <RuntimeItem
          sessionId={SESSION}
          runtime="claude-code"
          onChangeRuntime={vi.fn()}
          canSelect={true}
        />
      );

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
      render(
        <RuntimeItem
          sessionId={SESSION}
          runtime="claude-code"
          onChangeRuntime={vi.fn()}
          canSelect={true}
        />
      );

      expect(
        screen.queryAllByTestId('dropdown-item').filter((el) => {
          return el.textContent?.includes('Add a runtime');
        })
      ).toHaveLength(0);
      expect(screen.queryByTestId('dropdown-separator')).not.toBeInTheDocument();
    });
  });

  // The account decides which client's subscription a turn bills to, so it is
  // offered where a turn is initiated and not only in Settings (spec
  // `claude-code-accounts` D6).
  describe('Claude account switching', () => {
    /** Every known runtime registered and ready, so nothing else adds menu content. */
    function everyRuntimeReady() {
      mockRuntimeCapabilities.mockReturnValue({
        data: capsMap('claude-code', 'claude-code', 'codex', 'opencode'),
      });
      mockRuntimeRequirements.mockReturnValue({
        data: requirementsFor(['claude-code', 'codex', 'opencode']),
      });
    }

    /** The account radio group is the last one rendered (the runtime group comes first). */
    function accountGroup() {
      const groups = screen.getAllByRole('radiogroup');
      return groups[groups.length - 1]!;
    }

    it('lists the registered accounts plus a default that names what it resolves to', async () => {
      mockServerConfig = withAccounts(2);
      everyRuntimeReady();
      render(
        <RuntimeItem
          sessionId={SESSION}
          runtime="claude-code"
          onChangeRuntime={vi.fn()}
          canSelect={true}
        />
      );

      await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
      const group = accountGroup();
      expect(group.querySelectorAll('[role="radio"]')).toHaveLength(3);
      // "Default" alone is a choice with no consequence spelled out; naming the
      // account it resolves to makes picking nothing a legible decision.
      expect(group).toHaveTextContent('Default: Personal');
      expect(group).toHaveTextContent('Acme Corp');
      // Nothing chosen yet, so the default option is the selected one.
      expect(group.getAttribute('data-value')).toBe('__default__');
    });

    it('says the choice is this session only, and says it to a screen reader too', async () => {
      mockServerConfig = withAccounts(2);
      everyRuntimeReady();
      render(
        <RuntimeItem
          sessionId={SESSION}
          runtime="claude-code"
          onChangeRuntime={vi.fn()}
          canSelect={true}
        />
      );

      await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
      expect(screen.getByTestId('account-scope-note')).toHaveTextContent(
        'This session only. Locked once the first message sends.'
      );
      // A caveat about money that only sighted users receive is not a caveat: a
      // bare paragraph between menu items is part of no item's accessible name,
      // so it has to be the GROUP's description.
      expect(accountGroup()).toHaveAccessibleDescription(
        'This session only. Locked once the first message sends.'
      );
    });

    it("names the AGENT's account on the default row, not the server default", async () => {
      // The ladder is agent-then-default, so on a directory whose agent is
      // pinned to Acme Corp a machine defaulting to Personal still bills Acme.
      // "Default: Personal" here would be a false statement about money.
      mockServerConfig = withAccounts(2);
      mockAgent = agentPinnedTo('acme-corp');
      useAppStore.setState({ selectedCwd: '/work/project' });
      everyRuntimeReady();
      render(
        <RuntimeItem
          sessionId={SESSION}
          runtime="claude-code"
          onChangeRuntime={vi.fn()}
          canSelect={true}
        />
      );

      await waitFor(() => expect(accountGroup()).toHaveTextContent('Default: Acme Corp'));
      expect(accountGroup()).not.toHaveTextContent('Default: Personal');
    });

    it('falls back to the server default when the agent pins an account nobody registered', async () => {
      // The server's own tier-2 fallthrough: an unresolvable id is skipped, so
      // the default is what actually bills. Naming the dead id would describe a
      // billing that will not happen.
      mockServerConfig = withAccounts(2);
      mockAgent = agentPinnedTo('retired-client');
      useAppStore.setState({ selectedCwd: '/work/project' });
      everyRuntimeReady();
      render(
        <RuntimeItem
          sessionId={SESSION}
          runtime="claude-code"
          onChangeRuntime={vi.fn()}
          canSelect={true}
        />
      );

      await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
      await waitFor(() => expect(accountGroup()).toHaveTextContent('Default: Personal'));
      expect(accountGroup()).not.toHaveTextContent('retired-client');
    });

    it('says a bare "Default" while the agent question is still unanswered', async () => {
      // Silence beats a confident wrong name: until the manifest read lands this
      // surface cannot tell whether an agent overrules the default.
      mockServerConfig = withAccounts(2);
      useAppStore.setState({ selectedCwd: '/work/project' });
      everyRuntimeReady();
      const agentAnswer = createDeferred<AgentManifest | null>();
      renderWithAgent(
        <RuntimeItem
          sessionId={SESSION}
          runtime="claude-code"
          onChangeRuntime={vi.fn()}
          canSelect={true}
        />,
        () => agentAnswer.promise
      );

      await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
      const defaultRow = screen
        .getAllByRole('radio')
        .find((el) => el.getAttribute('data-radio-value') === '__default__')!;
      expect(defaultRow).toHaveTextContent('Default');
      expect(defaultRow).not.toHaveTextContent('—');

      // And it fills in once the answer arrives.
      agentAnswer.resolve(agentPinnedTo('acme-corp'));
      await waitFor(() => expect(accountGroup()).toHaveTextContent('Default: Acme Corp'));
    });

    it('holds the pick for THIS session and writes no config at all', async () => {
      // The whole point of the ladder (spec `billing-account-ladder` D2): this
      // used to PATCH `defaultAccount`, so a one-off pick silently repointed
      // every future session's billing. Red the moment that comes back.
      mockServerConfig = withAccounts(2);
      everyRuntimeReady();
      const user = userEvent.setup();
      render(
        <RuntimeItem
          sessionId={SESSION}
          runtime="claude-code"
          onChangeRuntime={vi.fn()}
          canSelect={true}
        />
      );
      await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());

      await user.click(screen.getByText('Acme Corp'));

      expect(lastTransport.updateConfig).not.toHaveBeenCalled();
      // The hint is the registry ID, never the path — that is what the server
      // resolves it against (ADR 260821-205324).
      expect(useAppStore.getState().pendingAccount).toEqual({
        id: 'acme-corp',
        sessionId: SESSION,
      });
      expect(accountGroup().getAttribute('data-value')).toBe('acme-corp');
    });

    it('returns to no hint when Default is picked back', async () => {
      mockServerConfig = withAccounts(2);
      everyRuntimeReady();
      const user = userEvent.setup();
      render(
        <RuntimeItem
          sessionId={SESSION}
          runtime="claude-code"
          onChangeRuntime={vi.fn()}
          canSelect={true}
        />
      );
      await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());

      await user.click(screen.getByText('Acme Corp'));
      await user.click(screen.getByText('Default: Personal'));

      // Null, not the default account's id: omitting the hint is what leaves the
      // server's own ladder (the agent's account, then the default) in charge.
      expect(useAppStore.getState().pendingAccount).toBeNull();
      expect(lastTransport.updateConfig).not.toHaveBeenCalled();
    });

    it('drops a held pick when that account stops being registered', async () => {
      // Masking the radio back to Default is not enough: the send path reads the
      // store, so a dead id would still ride the first message. Display and wire
      // have to say the same thing.
      mockServerConfig = withAccounts(2);
      everyRuntimeReady();
      const user = userEvent.setup();
      const { rerender } = render(
        <RuntimeItem
          sessionId={SESSION}
          runtime="claude-code"
          onChangeRuntime={vi.fn()}
          canSelect={true}
        />
      );
      await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
      await user.click(screen.getByText('Acme Corp'));
      expect(useAppStore.getState().pendingAccount).toEqual({
        id: 'acme-corp',
        sessionId: SESSION,
      });

      // The operator removes it in Settings; this menu is still mounted, and the
      // config cache every account surface reads moves under it.
      act(() => {
        lastQueryClient.setQueryData(configKeys.current(), {
          claudeCode: {
            resolvedAccount: '/Users/dev/.claude',
            inherited: true,
            accounts: [
              {
                id: 'personal',
                path: '/Users/dev/.claude',
                label: 'Personal',
                isAccountRoot: true,
              },
              { id: 'third', path: '/Users/dev/.claude3', label: 'Third', isAccountRoot: true },
            ],
          },
        });
      });
      rerender(
        <RuntimeItem
          sessionId={SESSION}
          runtime="claude-code"
          onChangeRuntime={vi.fn()}
          canSelect={true}
        />
      );

      await waitFor(() => expect(useAppStore.getState().pendingAccount).toBeNull());
      // And the radio agrees rather than pointing at something that is gone.
      expect(accountGroup().getAttribute('data-value')).toBe('__default__');
    });

    it('keeps a held pick when the registry stops being readable at all', async () => {
      // An empty list is NOT evidence the account is gone: it is equally what a
      // config read in flight, one that errored, and one the server could not
      // complete all look like. Deleting an operator's billing choice because
      // the machine briefly could not answer is the same class of bug as leaving
      // a dead id on the wire, pointing the other way — only a positive
      // "registry present, id absent" read may end a pick.
      mockServerConfig = withAccounts(2);
      everyRuntimeReady();
      const user = userEvent.setup();
      const { rerender } = render(
        <RuntimeItem
          sessionId={SESSION}
          runtime="claude-code"
          onChangeRuntime={vi.fn()}
          canSelect={true}
        />
      );
      await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
      await user.click(screen.getByText('Acme Corp'));
      expect(useAppStore.getState().pendingAccount).toEqual({
        id: 'acme-corp',
        sessionId: SESSION,
      });

      // The registry read comes back with nothing — unreadable, not emptied.
      act(() => {
        lastQueryClient.setQueryData(configKeys.current(), {
          claudeCode: { resolvedAccount: '/Users/dev/.claude', inherited: true, accounts: [] },
        });
      });
      rerender(
        <RuntimeItem
          sessionId={SESSION}
          runtime="claude-code"
          onChangeRuntime={vi.fn()}
          canSelect={true}
        />
      );

      await waitFor(() => expect(screen.queryByText('Acme Corp')).not.toBeInTheDocument());
      expect(useAppStore.getState().pendingAccount).toEqual({
        id: 'acme-corp',
        sessionId: SESSION,
      });
    });

    it('never shows a pick made on another session, and keeps its own across a remount', async () => {
      // Two directions of one rule. A pick carries the session it was made in,
      // so a different conversation cannot inherit it (the leak), and the same
      // conversation does not lose it just because a surface remounted (the
      // clobber). Neither depends on who happens to be mounted.
      mockServerConfig = withAccounts(2);
      everyRuntimeReady();
      useAppStore.setState({
        pendingAccount: { id: 'acme-corp', sessionId: 'a-different-session' },
      });
      render(
        <RuntimeItem
          sessionId={SESSION}
          runtime="claude-code"
          onChangeRuntime={vi.fn()}
          canSelect={true}
        />
      );

      await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
      // Someone else's pick is invisible here.
      expect(accountGroup().getAttribute('data-value')).toBe('__default__');

      // This session makes its own, then the surface is torn down and rebuilt.
      const user = userEvent.setup();
      await user.click(screen.getByText('Acme Corp'));
      expect(accountGroup().getAttribute('data-value')).toBe('acme-corp');
      cleanup();
      render(
        <RuntimeItem
          sessionId={SESSION}
          runtime="claude-code"
          onChangeRuntime={vi.fn()}
          canSelect={true}
        />
      );

      await waitFor(() => expect(accountGroup().getAttribute('data-value')).toBe('acme-corp'));
    });

    it('never offers a root nobody registered, which no hint could name', async () => {
      // The in-use-but-unregistered root has no id, so a hint naming it is
      // unspellable. It is reachable as the default option instead.
      mockServerConfig = {
        claudeCode: {
          resolvedAccount: '/Users/dev/.claude-adhoc',
          inherited: false,
          accounts: [
            { id: 'personal', path: '/Users/dev/.claude', label: 'Personal', isAccountRoot: true },
            {
              id: 'acme-corp',
              path: '/Users/dev/.claude2',
              label: 'Acme Corp',
              isAccountRoot: true,
            },
            // A row of the synthesized, display-only kind.
            {
              id: null,
              path: '/Users/dev/.claude-adhoc',
              label: null,
              isAccountRoot: true,
            },
          ],
        },
      };
      everyRuntimeReady();
      render(
        <RuntimeItem
          sessionId={SESSION}
          runtime="claude-code"
          onChangeRuntime={vi.fn()}
          canSelect={true}
        />
      );

      await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
      const group = accountGroup();
      // Default + the two registered accounts, and nothing for the id-less row.
      expect(group.querySelectorAll('[role="radio"]')).toHaveLength(3);
      expect(
        Array.from(group.querySelectorAll('[role="radio"]')).map((el) =>
          el.getAttribute('data-radio-value')
        )
      ).toEqual(['__default__', 'personal', 'acme-corp']);
      // It is still what the default resolves to, so it is named there.
      expect(group).toHaveTextContent('Default: .claude-adhoc');
    });

    it('says so when a registered folder is not a usable account, instead of offering it plainly', async () => {
      // The server already checked and found no account there, so this option
      // points new work at a config Claude Code treats as signed out. The
      // settings card warns on its row; this must agree rather than stay quiet.
      mockServerConfig = {
        claudeCode: {
          resolvedAccount: '/Users/dev/.claude',
          inherited: true,
          accounts: [
            { id: 'personal', path: '/Users/dev/.claude', label: 'Personal', isAccountRoot: true },
            {
              id: 'acme-corp',
              path: '/Users/dev/.claude2',
              label: 'Acme Corp',
              isAccountRoot: false,
            },
          ],
        },
      };
      everyRuntimeReady();
      render(
        <RuntimeItem
          sessionId={SESSION}
          runtime="claude-code"
          onChangeRuntime={vi.fn()}
          canSelect={true}
        />
      );

      await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
      const marked = screen
        .getAllByRole('radio')
        .filter((el) => el.getAttribute('data-radio-value') === 'acme-corp');
      expect(marked).toHaveLength(1);
      expect(marked[0]).toHaveTextContent('Does not look like an account folder yet');
      // The usable one carries no such mark.
      expect(
        screen
          .getAllByRole('radio')
          .find((el) => el.getAttribute('data-radio-value') === 'personal')
      ).not.toHaveTextContent('Does not look like an account folder yet');
    });

    it('stays out of the menu when only one account is registered', async () => {
      mockServerConfig = withAccounts(1);
      everyRuntimeReady();
      render(
        <>
          <AccountsProbe />
          <RuntimeItem
            sessionId={SESSION}
            runtime="claude-code"
            onChangeRuntime={vi.fn()}
            canSelect={true}
          />
        </>
      );

      // Wait for the CONFIG, not the menu: the dropdown is already on screen
      // before the accounts are known, so synchronizing on it would assert the
      // absence of something that had not had a chance to appear.
      await waitFor(() => expect(screen.getByTestId('accounts-known')).toHaveTextContent('1'));
      // The runtime group is still there; the account group is not. Nothing to
      // switch between means a control with nothing to control.
      expect(screen.getByTestId('dropdown-root')).toBeInTheDocument();
      expect(screen.getAllByRole('radiogroup')).toHaveLength(1);
      expect(screen.queryByText('Personal')).not.toBeInTheDocument();
      expect(screen.queryAllByTestId('dropdown-label').map((el) => el.textContent)).not.toContain(
        'Account'
      );
    });

    it('stays out of the menu once the session has started', async () => {
      mockServerConfig = withAccounts(2);
      everyRuntimeReady();
      render(
        <>
          <AccountsProbe />
          <RuntimeItem
            sessionId={SESSION}
            runtime="claude-code"
            onChangeRuntime={vi.fn()}
            canSelect={false}
          />
        </>
      );

      // A started session's account is fixed to the one that created it, so a
      // switcher here would imply a move that cannot happen.
      await waitFor(() => expect(screen.getByTestId('accounts-known')).toHaveTextContent('2'));
      expect(screen.getByTestId('tooltip-content')).toBeInTheDocument();
      expect(screen.queryByTestId('dropdown-root')).not.toBeInTheDocument();
      expect(screen.queryByText('Acme Corp')).not.toBeInTheDocument();
    });

    it('stays out of the menu for a runtime with no accounts', async () => {
      mockServerConfig = withAccounts(2);
      everyRuntimeReady();
      render(
        <>
          <AccountsProbe />
          <RuntimeItem
            sessionId={SESSION}
            runtime="codex"
            onChangeRuntime={vi.fn()}
            canSelect={true}
          />
        </>
      );

      await waitFor(() => expect(screen.getByTestId('accounts-known')).toHaveTextContent('2'));
      expect(screen.getByTestId('dropdown-root')).toBeInTheDocument();
      expect(screen.queryByText('Acme Corp')).not.toBeInTheDocument();
    });
  });
});
