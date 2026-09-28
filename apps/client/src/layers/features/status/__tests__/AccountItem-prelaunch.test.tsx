// @vitest-environment jsdom
/**
 * The account chip before the first message: it IS the account picker, moved
 * here from the runtime chip's menu (spec `claude-account-ui` §6.1, Q7). The
 * pick is a launch hint for this session alone (spec `billing-account-ladder`),
 * so every rule the old menu pinned is pinned here.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, screen, cleanup, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { ServerConfig } from '@dorkos/shared/types';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { TransportProvider, configKeys, useAppStore } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';

// ── The session list: empty, so the session has not launched ─────────────
vi.mock('@/layers/entities/session/model/query/use-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session/model/query/use-sessions')>()),
  useSessions: () => ({ sessions: [], isLoading: false }) as never,
}));

// ── Dropdown primitives rendered inline, as RuntimeItem.test does ─────────
vi.mock('@/layers/shared/ui', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ResponsiveDropdownMenu: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="dropdown-root">{children}</div>
    ),
    ResponsiveDropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="dropdown-trigger">{children}</div>
    ),
    ResponsiveDropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="dropdown-content">{children}</div>
    ),
    ResponsiveDropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="dropdown-label">{children}</div>
    ),
    ResponsiveDropdownMenuRadioGroup: ({
      children,
      value,
      onValueChange,
      'aria-describedby': describedBy,
    }: {
      children: React.ReactNode;
      value?: string;
      onValueChange?: (v: string) => void;
      'aria-describedby'?: string;
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
      description?: string;
    }) => (
      <div role="radio" aria-checked={false} data-radio-value={value}>
        <span>{children}</span>
        {description && <span data-testid="radio-description">{description}</span>}
      </div>
    ),
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipContent: () => null,
  };
});

import { useSessionAccount } from '../model/use-session-account';
import { AccountItem } from '../ui/AccountItem';

/** The session under test; a pick is stored against it. */
const SESSION = 'session-a';

/** What `GET /api/config` answers for the current test. */
let mockServerConfig: Partial<ServerConfig> = {};
/** The agent at the launch directory, as `getAgentByPath` answers it. */
let mockAgent: AgentManifest | null = null;
let lastTransport: ReturnType<typeof createMockTransport>;
let lastQueryClient: QueryClient;

beforeEach(() => {
  // The pick is shared app state; the working directory decides whether the
  // agent tier of the ladder is consulted, and that the session is known new.
  useAppStore.setState({
    pendingAccount: null,
    pendingRuntime: null,
    selectedCwd: '/work/project',
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockServerConfig = {};
  mockAgent = null;
});

/** The status line's wiring in miniature: the one source, then the chip. */
function Chip({ sessionId = SESSION }: { sessionId?: string }) {
  const account = useSessionAccount(sessionId);
  return <AccountItem sessionId={sessionId} account={account} />;
}

function render(ui: React.ReactElement, getAgent = () => Promise.resolve(mockAgent)) {
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue(mockServerConfig),
    // Present so a test can assert the picker calls it NOT AT ALL.
    updateConfig: vi.fn(() => Promise.resolve()),
    getAgentByPath: vi.fn(getAgent),
  });
  lastTransport = transport;
  lastQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const queryClient = lastQueryClient;
  return rtlRender(ui, {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          {/* The account dot's own tooltip, which the barrel mock cannot reach. */}
          <TooltipProvider>{children}</TooltipProvider>
        </TransportProvider>
      </QueryClientProvider>
    ),
  });
}

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
    mcpServers: [],
    ...(account === undefined ? {} : { account }),
  };
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const PERSONAL = {
  id: 'personal',
  path: '/Users/dev/.claude',
  label: 'Personal',
  color: '#3b82f6',
  colorIsDefault: true,
  isAccountRoot: true,
};
const ACME = {
  id: 'acme-corp',
  path: '/Users/dev/.claude2',
  label: 'Acme Corp',
  color: '#1d8a4a',
  colorIsDefault: true,
  isAccountRoot: true,
};

/** Two named Claude accounts, Personal the server default. */
function withAccounts(resolvedAccount = PERSONAL.path): Partial<ServerConfig> {
  return { claudeCode: { resolvedAccount, inherited: true, accounts: [PERSONAL, ACME] } };
}

function accountGroup() {
  return screen.getByRole('radiogroup');
}

function radioValues() {
  return within(accountGroup())
    .getAllByRole('radio')
    .map((el) => el.getAttribute('data-radio-value'));
}

describe('AccountItem before launch — the account picker', () => {
  it('is the chip with a chevron: dot, name and bars of the account it would use', async () => {
    mockServerConfig = withAccounts();
    render(<Chip />);
    const trigger = await screen.findByRole('button', { name: /^Personal/ });
    expect(trigger).toHaveAccessibleName(
      'Personal, 5-hour window usage unknown, weekly usage unknown'
    );
    expect(trigger.querySelector('svg')).not.toBeNull();
  });

  it('lists the registered accounts plus a default that names what it resolves to', async () => {
    mockServerConfig = withAccounts();
    render(<Chip />);

    await waitFor(() => expect(accountGroup()).toHaveTextContent('Default: Personal'));
    expect(radioValues()).toEqual(['__default__', 'personal', 'acme-corp']);
    expect(accountGroup()).toHaveTextContent('Acme Corp');
    expect(accountGroup().getAttribute('data-value')).toBe('__default__');
    // Each row draws the account's usage bars.
    expect(within(accountGroup()).getAllByRole('img', { name: /5-hour window/ })).toHaveLength(3);
  });

  it('puts the account the default resolves to first', async () => {
    mockServerConfig = withAccounts(ACME.path);
    render(<Chip />);
    await waitFor(() => expect(accountGroup()).toHaveTextContent('Default: Acme Corp'));
    expect(radioValues()).toEqual(['__default__', 'acme-corp', 'personal']);
  });

  it('says the choice is this session only, and says it to a screen reader too', async () => {
    mockServerConfig = withAccounts();
    render(<Chip />);
    await waitFor(() => expect(accountGroup()).toBeInTheDocument());
    expect(screen.getByTestId('account-scope-note')).toHaveTextContent(
      'This session only. Locked once the first message sends.'
    );
    expect(accountGroup()).toHaveAccessibleDescription(
      'This session only. Locked once the first message sends.'
    );
  });

  it('names the AGENT’s account on the default row, not the server default', async () => {
    mockServerConfig = withAccounts();
    mockAgent = agentPinnedTo('acme-corp');
    render(<Chip />);
    await waitFor(() => expect(accountGroup()).toHaveTextContent('Default: Acme Corp'));
    expect(accountGroup()).not.toHaveTextContent('Default: Personal');
  });

  it('falls back to the server default when the agent pins an account nobody registered', async () => {
    mockServerConfig = withAccounts();
    mockAgent = agentPinnedTo('retired-client');
    render(<Chip />);
    await waitFor(() => expect(accountGroup()).toHaveTextContent('Default: Personal'));
    expect(accountGroup()).not.toHaveTextContent('retired-client');
  });

  it('says a bare "Default" while the agent question is still unanswered', async () => {
    mockServerConfig = withAccounts();
    // A pick names the chip, so the menu is open to inspect while the ladder's
    // own answer is still unknown.
    useAppStore.setState({ pendingAccount: { id: 'personal', sessionId: SESSION } });
    const agentAnswer = createDeferred<AgentManifest | null>();
    render(<Chip />, () => agentAnswer.promise);

    await waitFor(() => expect(accountGroup()).toHaveTextContent('Acme Corp'));
    const defaultRow = within(accountGroup())
      .getAllByRole('radio')
      .find((el) => el.getAttribute('data-radio-value') === '__default__')!;
    expect(defaultRow).toHaveTextContent(/^Default/);
    expect(defaultRow).not.toHaveTextContent('Default:');

    agentAnswer.resolve(agentPinnedTo('acme-corp'));
    await waitFor(() => expect(accountGroup()).toHaveTextContent('Default: Acme Corp'));
  });

  it('still offers the picker, reading "Default", while it cannot tell which account a new chat would use', async () => {
    mockServerConfig = withAccounts();
    const agentAnswer = createDeferred<AgentManifest | null>();
    render(<Chip />, () => agentAnswer.promise);
    const trigger = await screen.findByRole('button', { name: /^Default,/ });
    expect(trigger).toBeInTheDocument();
    expect(accountGroup()).toHaveTextContent('Acme Corp');

    agentAnswer.resolve(null);
    expect(await screen.findByRole('button', { name: /^Personal/ })).toBeInTheDocument();
  });

  it('keeps the picker when the agent read fails, so the only account choice never disappears', async () => {
    mockServerConfig = withAccounts();
    const user = userEvent.setup();
    render(<Chip />, () => Promise.reject(new Error('agent read failed')));
    await waitFor(() => expect(lastTransport.getAgentByPath).toHaveBeenCalled());

    const trigger = await screen.findByRole('button', { name: /^Default,/ });
    await user.click(trigger);
    expect(accountGroup()).toHaveTextContent('Acme Corp');
    await user.click(within(accountGroup()).getByText('Acme Corp'));
    expect(useAppStore.getState().pendingAccount).toEqual({ id: 'acme-corp', sessionId: SESSION });
  });

  it('holds the pick for THIS session, shows it on the chip, and writes no config', async () => {
    mockServerConfig = withAccounts();
    const user = userEvent.setup();
    render(<Chip />);
    await waitFor(() => expect(accountGroup()).toHaveTextContent('Acme Corp'));

    await user.click(within(accountGroup()).getByText('Acme Corp'));

    expect(lastTransport.updateConfig).not.toHaveBeenCalled();
    // The registry ID, never the path (ADR 260821-205324).
    expect(useAppStore.getState().pendingAccount).toEqual({ id: 'acme-corp', sessionId: SESSION });
    expect(accountGroup().getAttribute('data-value')).toBe('acme-corp');
    expect(await screen.findByRole('button', { name: /^Acme Corp/ })).toBeInTheDocument();
  });

  it('returns to no hint when Default is picked back', async () => {
    mockServerConfig = withAccounts();
    const user = userEvent.setup();
    render(<Chip />);
    await waitFor(() => expect(accountGroup()).toHaveTextContent('Default: Personal'));

    await user.click(within(accountGroup()).getByText('Acme Corp'));
    await user.click(within(accountGroup()).getByText('Default: Personal'));

    expect(useAppStore.getState().pendingAccount).toBeNull();
    expect(lastTransport.updateConfig).not.toHaveBeenCalled();
  });

  it('drops a held pick when that account stops being registered', async () => {
    mockServerConfig = withAccounts();
    const user = userEvent.setup();
    render(<Chip />);
    await waitFor(() => expect(accountGroup()).toHaveTextContent('Acme Corp'));
    await user.click(within(accountGroup()).getByText('Acme Corp'));
    expect(useAppStore.getState().pendingAccount).toEqual({ id: 'acme-corp', sessionId: SESSION });

    act(() => {
      lastQueryClient.setQueryData(configKeys.current(), {
        claudeCode: {
          resolvedAccount: PERSONAL.path,
          inherited: true,
          accounts: [
            PERSONAL,
            { ...ACME, id: 'third', path: '/Users/dev/.claude3', label: 'Third' },
          ],
        },
      });
    });

    await waitFor(() => expect(useAppStore.getState().pendingAccount).toBeNull());
    expect(accountGroup().getAttribute('data-value')).toBe('__default__');
  });

  it('keeps a held pick when the registry stops being readable at all', async () => {
    // An empty list is not evidence the account is gone: only a positive
    // "registry present, id absent" read may end a pick.
    mockServerConfig = withAccounts();
    const user = userEvent.setup();
    render(<Chip />);
    await waitFor(() => expect(accountGroup()).toHaveTextContent('Acme Corp'));
    await user.click(within(accountGroup()).getByText('Acme Corp'));

    act(() => {
      lastQueryClient.setQueryData(configKeys.current(), {
        claudeCode: { resolvedAccount: PERSONAL.path, inherited: true, accounts: [] },
      });
    });

    // The gate closes with no accounts, so the chip goes away…
    await waitFor(() => expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument());
    // …and the pick stays.
    expect(useAppStore.getState().pendingAccount).toEqual({ id: 'acme-corp', sessionId: SESSION });
  });

  it('never shows a pick made on another session, and keeps its own across a remount', async () => {
    mockServerConfig = withAccounts();
    useAppStore.setState({ pendingAccount: { id: 'acme-corp', sessionId: 'a-different-session' } });
    render(<Chip />);
    await waitFor(() => expect(accountGroup()).toHaveTextContent('Acme Corp'));
    expect(accountGroup().getAttribute('data-value')).toBe('__default__');

    const user = userEvent.setup();
    await user.click(within(accountGroup()).getByText('Acme Corp'));
    expect(accountGroup().getAttribute('data-value')).toBe('acme-corp');
    cleanup();
    render(<Chip />);

    await waitFor(() => expect(accountGroup().getAttribute('data-value')).toBe('acme-corp'));
  });

  it('never offers a root nobody registered, which no hint could name', async () => {
    mockServerConfig = {
      claudeCode: {
        resolvedAccount: '/Users/dev/.claude-adhoc',
        inherited: false,
        accounts: [
          PERSONAL,
          ACME,
          { ...PERSONAL, id: null, path: '/Users/dev/.claude-adhoc', label: null },
        ],
      },
    } as unknown as Partial<ServerConfig>;
    render(<Chip />);
    await waitFor(() => expect(accountGroup()).toHaveTextContent('Default: .claude-adhoc'));
    expect(radioValues()).toEqual(['__default__', 'personal', 'acme-corp']);
  });

  it('says so when a registered folder is not a usable account, instead of offering it plainly', async () => {
    mockServerConfig = {
      claudeCode: {
        resolvedAccount: PERSONAL.path,
        inherited: true,
        accounts: [PERSONAL, { ...ACME, isAccountRoot: false }],
      },
    };
    render(<Chip />);
    await waitFor(() => expect(accountGroup()).toHaveTextContent('Acme Corp'));
    const rows = within(accountGroup()).getAllByRole('radio');
    const acme = rows.find((el) => el.getAttribute('data-radio-value') === 'acme-corp')!;
    const personal = rows.find((el) => el.getAttribute('data-radio-value') === 'personal')!;
    expect(acme).toHaveTextContent('Does not look like an account folder yet');
    expect(personal).not.toHaveTextContent('Does not look like an account folder yet');
  });

  it('is not there with one account, where there is nothing to choose', async () => {
    mockServerConfig = {
      claudeCode: { resolvedAccount: PERSONAL.path, inherited: true, accounts: [PERSONAL] },
    };
    render(<Chip />);
    await waitFor(() => expect(lastQueryClient.getQueryData(configKeys.current())).toBeDefined());
    await waitFor(() => expect(lastQueryClient.getQueryData(['capabilities'])).toBeDefined());
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
