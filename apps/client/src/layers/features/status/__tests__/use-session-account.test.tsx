/**
 * @vitest-environment jsdom
 *
 * `useSessionAccount`, the one source for "which account and how is it"
 * (spec `claude-account-ui` §6.4), and the chip it drives: the identity gate
 * (invariant 1), the seeded usage, the live stream, and the `account_usage`
 * event.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { Session, ServerConfig } from '@dorkos/shared/types';
import type { Transport } from '@dorkos/shared/transport';
import {
  createMockAccountUsage,
  createMockSession,
  createMockSessionLimit,
  createMockTransport,
} from '@dorkos/test-utils';
import { createTestQueryClient } from '@dorkos/test-utils/react-helpers';
import {
  TransportProvider,
  configKeys,
  seedAccountUsage,
  useAccountUsageSync,
  useAppStore,
} from '@/layers/shared/model';
import { useSessionStreamStore } from '@/layers/entities/session';
import { TooltipProvider } from '@/layers/shared/ui';

// ── The session list: stubbed, because the real one needs a router ─────────
let mockSessions: Session[] = [];
vi.mock('@/layers/entities/session/model/query/use-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session/model/query/use-sessions')>()),
  useSessions: () => ({ sessions: mockSessions, isLoading: false }) as never,
}));

// ── The global event stream: the handler each event was subscribed with ────
const handlers = new Map<string, (data: unknown) => void>();
vi.mock('@/layers/shared/model/event-stream-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model/event-stream-context')>()),
  useEventSubscription: (event: string, handler: (data: unknown) => void) => {
    handlers.set(event, handler);
  },
}));

vi.mock('@/layers/shared/model/media/use-is-mobile', () => ({ useIsMobile: () => false }));

import { useSessionAccount } from '../model/use-session-account';
import { AccountItem } from '../ui/AccountItem';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const SID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  // The fixtures' readings are from 2026-09-27 noon, with the 5-hour window
  // resetting at 15:00; the chip now reads a past reset as "reset", so the
  // clock is pinned to when the readings were taken.
  vi.useFakeTimers({ now: new Date('2026-09-27T12:05:00.000Z'), shouldAdvanceTime: true });
  handlers.clear();
  mockSessions = [];
  useAppStore.setState({ pendingAccount: null, pendingRuntime: null, selectedCwd: '/work' });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useSessionStreamStore.getState().removeSession(SID);
});

function registered(n: number) {
  return {
    id: `acct-${n}`,
    path: `/Users/test/.claude-acct-${n}`,
    label: `Acct ${n}`,
    color: n === 2 ? '#1d8a4a' : '#2f7be0',
    colorIsDefault: true,
    isAccountRoot: true,
  };
}

/** A transport whose config registers `count` Claude accounts (Acct 1, Acct 2, …). */
function transportWith(count: number, overrides: Partial<Transport> = {}) {
  const config = {
    claudeCode: {
      resolvedAccount: '/Users/test/.claude-acct-1',
      inherited: false,
      accounts: Array.from({ length: count }, (_, i) => registered(i + 1)),
    },
  } as unknown as ServerConfig;
  return createMockTransport({ getConfig: vi.fn().mockResolvedValue(config), ...overrides });
}

function wrapperFor(transport: Transport, queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <TooltipProvider>{children}</TooltipProvider>
        </TransportProvider>
      </QueryClientProvider>
    );
  };
}

/** The status line's wiring in miniature: the hook, then the chip it drives. */
function Chip() {
  useAccountUsageSync();
  const account = useSessionAccount(SID);
  return <AccountItem sessionId={SID} account={account} />;
}

function renderChip(transport: Transport, queryClient = createTestQueryClient()) {
  render(<Chip />, { wrapper: wrapperFor(transport, queryClient) });
  return queryClient;
}

/** Wait until config and capabilities have landed, so an absence is the answer. */
async function settled(queryClient: QueryClient) {
  await waitFor(() => {
    expect(queryClient.getQueryData(configKeys.current())).toBeDefined();
    expect(queryClient.getQueryData(['capabilities'])).toBeDefined();
  });
}

const ACCT_2 = createMockAccountUsage();

describe('the identity gate (invariant 1)', () => {
  it.each([0, 1])('shows no chip with %i Claude accounts', async (count) => {
    mockSessions = [createMockSession({ id: SID, runtime: 'claude-code', accountId: 'acct-1' })];
    const transport = transportWith(count);
    const queryClient = renderChip(transport);
    await settled(queryClient);
    // Any button at all: the chip is the only one this tree can draw, and a
    // closed gate must not name the account in any spelling.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(transport.getAccountUsage).not.toHaveBeenCalled();
  });

  it('shows no chip on a Codex session, which does not tell accounts apart', async () => {
    mockSessions = [createMockSession({ id: SID, runtime: 'codex', accountId: 'default' })];
    const transport = transportWith(2);
    const queryClient = renderChip(transport);
    await settled(queryClient);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(transport.getAccountUsage).not.toHaveBeenCalled();
  });

  it('shows the chip with two Claude accounts, from the seed, with no usage request', async () => {
    mockSessions = [
      createMockSession({
        id: SID,
        runtime: 'claude-code',
        accountId: 'acct-2',
        account: '/Users/test/.claude-acct-2',
      }),
    ];
    const transport = transportWith(2);
    const queryClient = createTestQueryClient();
    // What the session list envelope's `accountUsage` does on the way in.
    seedAccountUsage(queryClient, [ACCT_2]);
    renderChip(transport, queryClient);

    const chip = await screen.findByRole('button', { name: /^Acct 2/ });
    expect(chip).toHaveAccessibleName('Acct 2, 5-hour window 40% used, weekly 72% used');
    expect(transport.getAccountUsage).not.toHaveBeenCalled();
  });
});

describe('a window past its reset (spec claude-account-ui §6.8)', () => {
  it('reads "reset" on the chip and in its popover alike, before the server marks it', async () => {
    mockSessions = [
      createMockSession({
        id: SID,
        runtime: 'claude-code',
        accountId: 'acct-2',
        account: '/Users/test/.claude-acct-2',
      }),
    ];
    const queryClient = createTestQueryClient();
    // A cached reading: the 5-hour window reset a minute ago, still at 97%, and
    // the server has not flagged it yet, so the account still reads `warning`.
    const past = new Date(Date.now() - 60_000).toISOString();
    seedAccountUsage(queryClient, [
      createMockAccountUsage({
        state: 'warning',
        windows: [
          { ...ACCT_2.windows[0]!, usedPct: 97, resetsAt: past, status: 'allowed_warning' },
          { ...ACCT_2.windows[1]!, usedPct: 30, resetsAt: null },
        ],
      }),
    ]);
    renderChip(transportWith(2), queryClient);

    // No "97% of 5h" words: the chip draws its bars, and names the window reset.
    const chip = await screen.findByRole('button', { name: /^Acct 2/ });
    expect(chip).toHaveAccessibleName('Acct 2, 5-hour window reset, weekly 30% used');

    await userEvent.setup().click(chip);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('img', { name: '5-hour reset' })).toBeInTheDocument();
  });
});

describe('live updates, with no polling', () => {
  function startedOnAcct2() {
    mockSessions = [
      createMockSession({
        id: SID,
        runtime: 'claude-code',
        accountId: 'acct-2',
        account: '/Users/test/.claude-acct-2',
      }),
    ];
  }

  it('an account_usage event re-renders the chip without a refetch', async () => {
    startedOnAcct2();
    const transport = transportWith(2);
    const queryClient = createTestQueryClient();
    seedAccountUsage(queryClient, [ACCT_2]);
    renderChip(transport, queryClient);
    await screen.findByRole('button', { name: /^Acct 2/ });

    act(() => {
      handlers.get('account_usage')!({
        ...ACCT_2,
        state: 'warning',
        updatedAt: '2026-09-27T13:00:00.000Z',
        windows: [ACCT_2.windows[0], { ...ACCT_2.windows[1]!, usedPct: 91 }],
      });
    });

    expect(await screen.findByRole('button', { name: 'Acct 2, 91% of week' })).toBeInTheDocument();
    expect(transport.getAccountUsage).not.toHaveBeenCalled();
  });

  it('a status_change carrying a limit turns the chip out', async () => {
    startedOnAcct2();
    const queryClient = createTestQueryClient();
    seedAccountUsage(queryClient, [ACCT_2]);
    renderChip(transportWith(2), queryClient);
    await screen.findByRole('button', { name: /^Acct 2/ });

    act(() => {
      useSessionStreamStore.getState().applyEvent(SID, {
        type: 'status_change',
        seq: 1,
        status: { limit: createMockSessionLimit('ask', { resetsAt: null }) },
      });
    });

    expect(await screen.findByRole('button', { name: 'Acct 2, out' })).toBeInTheDocument();
  });
});

describe('useSessionAccount', () => {
  function renderAccount(transport: Transport, queryClient = createTestQueryClient()) {
    return renderHook(() => useSessionAccount(SID), {
      wrapper: wrapperFor(transport, queryClient),
    });
  }

  it('finds the account’s usage by id first, then by path', async () => {
    // By id: the row's accountId names the reading even though the path differs.
    mockSessions = [
      createMockSession({
        id: SID,
        runtime: 'claude-code',
        accountId: 'acct-2',
        account: '/elsewhere',
      }),
    ];
    const queryClient = createTestQueryClient();
    const byPathOnly = createMockAccountUsage({
      accountId: null,
      path: '/Users/test/.claude-acct-9',
      label: 'Unregistered',
    });
    seedAccountUsage(queryClient, [ACCT_2, byPathOnly]);
    const byId = renderAccount(transportWith(2), queryClient);
    await waitFor(() => expect(byId.result.current.usage).toBe(ACCT_2));
    byId.unmount();

    // By path: an unregistered root has no id to match.
    mockSessions = [
      createMockSession({ id: SID, runtime: 'claude-code', account: '/Users/test/.claude-acct-9' }),
    ];
    const byPath = renderAccount(transportWith(2), queryClient);
    await waitFor(() => expect(byPath.result.current.usage).toBe(byPathOnly));
  });

  it('reads the row’s stored limit, and the stream’s limit wins once it has one', async () => {
    const stored = createMockSessionLimit('ask');
    mockSessions = [
      createMockSession({
        id: SID,
        runtime: 'claude-code',
        accountId: 'acct-2',
        status: { lifecycle: 'idle', limit: stored },
      }),
    ];
    const { result } = renderAccount(transportWith(2));
    await waitFor(() => expect(result.current.visible).toBe(true));
    expect(result.current.limit).toBe(stored);
    expect(result.current.chipState).toBe('out');

    const live = createMockSessionLimit('continued');
    act(() => {
      useSessionStreamStore
        .getState()
        .applyEvent(SID, { type: 'status_change', seq: 1, status: { limit: live } });
    });
    expect(result.current.limit).toEqual(live);
    expect(result.current.chipState).not.toBe('out');
  });

  it('reads a row with no status as no limit, idle', async () => {
    mockSessions = [createMockSession({ id: SID, runtime: 'claude-code', accountId: 'acct-2' })];
    const { result } = renderAccount(transportWith(2));
    await waitFor(() => expect(result.current.visible).toBe(true));
    expect(result.current.limit).toBeNull();
    expect(result.current.lifecycle).toBe('idle');
    expect(result.current.pending).toBe(false);
  });

  it('before launch, reads the pick for this session and marks it pending', async () => {
    useAppStore.setState({ pendingAccount: { id: 'acct-2', sessionId: SID } });
    const { result } = renderAccount(transportWith(2));
    await waitFor(() => expect(result.current.name).toBe('Acct 2'));
    expect(result.current.pending).toBe(true);
    expect(result.current.accountId).toBe('acct-2');
    expect(result.current.color).toBe('#1d8a4a');
    expect(result.current.limit).toBeNull();
  });

  it('before launch with no pick, reads the account the server would pick', async () => {
    const { result } = renderAccount(
      transportWith(2, {
        getAgentByPath: vi.fn().mockResolvedValue(null),
      })
    );
    await waitFor(() => expect(result.current.name).toBe('Acct 1'));
    expect(result.current.accountId).toBe('acct-1');
  });

  it('carries the flow item the session serves', async () => {
    mockSessions = [
      createMockSession({
        id: SID,
        runtime: 'claude-code',
        accountId: 'acct-2',
        trackerItem: { id: 'DOR-2353', stage: 'execute' },
      }),
    ];
    const { result } = renderAccount(transportWith(2));
    await waitFor(() =>
      expect(result.current.trackerItem).toEqual({ id: 'DOR-2353', stage: 'execute' })
    );
  });
});
