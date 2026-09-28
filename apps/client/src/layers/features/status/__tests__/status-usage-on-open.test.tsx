/**
 * @vitest-environment jsdom
 *
 * Usage and context in the status bar from the moment a session opens (spec
 * `claude-account-ui` §6.8): the status line's own wiring in miniature
 * (`useSessionDiagnostics`, `useSessionAccount`, `useStatusUsage`, the
 * registry's promotion rules, and the two items), driven by the seeded account
 * cache, the session's snapshot, live frames and the `account_usage` event.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import type { SessionSnapshot, SessionStatus } from '@dorkos/shared/session-stream';
import type { Session, ServerConfig } from '@dorkos/shared/types';
import type { Transport } from '@dorkos/shared/transport';
import { createMockAccountUsage, createMockSession, createMockTransport } from '@dorkos/test-utils';
import { createTestQueryClient } from '@dorkos/test-utils/react-helpers';
import {
  TransportProvider,
  configKeys,
  seedAccountUsage,
  useAccountUsageSync,
  useAppStore,
} from '@/layers/shared/model';
import { useSessionStreamStatus, useSessionStreamStore } from '@/layers/entities/session';
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

import { useSessionAccount, accountChipPromotion } from '../model/use-session-account';
import { useSessionDiagnostics } from '../model/use-session-diagnostics';
import { useStatusUsage } from '../model/use-status-usage';
import { getStatusBarItem, type StatusPromotionContext } from '../model/status-bar-registry';
import { UsageStatusItem } from '../ui/UsageStatusItem';
import { ContextItem } from '../ui/ContextItem';

const NOW = new Date('2026-09-28T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const SID_A = '11111111-1111-4111-8111-111111111111';
const SID_B = '22222222-2222-4222-8222-222222222222';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true });
  handlers.clear();
  mockSessions = [];
  useAppStore.setState({ pendingAccount: null, pendingRuntime: null, selectedCwd: '/work' });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useSessionStreamStore.getState().removeSession(SID_A);
  useSessionStreamStore.getState().removeSession(SID_B);
});

/** One account reading with a single 5-hour window at `usedPct`. */
function reading(overrides: Partial<AccountUsage> & { usedPct?: number; at?: string } = {}) {
  const { usedPct = 40, at = minutesAgo(5), ...rest } = overrides;
  return createMockAccountUsage({
    updatedAt: at,
    windows: [
      {
        key: 'five_hour',
        label: '5-hour window',
        usedPct,
        resetsAt: null,
        status: 'allowed',
        expired: false,
        observedAt: at,
        source: 'sdk_event',
      },
    ],
    ...rest,
  });
}

const STATUS: SessionStatus = {
  contextUsage: null,
  cost: null,
  usage: null,
  cacheStats: null,
  model: null,
  permissionMode: 'default',
  todoCounts: null,
  runningSubagentCount: 0,
  lifecycle: 'idle',
  lastError: null,
  limit: null,
  accountUsage: null,
};

/** Open a session cold: the snapshot `GET /api/sessions/:id` and the stream hand over. */
function openSession(sessionId: string, status: Partial<SessionStatus> = {}) {
  const snapshot: SessionSnapshot = {
    messages: [],
    inProgressTurn: null,
    status: { ...STATUS, ...status },
    pendingInteractions: [],
    queuedMessages: [],
    canvas: [],
    cursor: 0,
  };
  act(() => useSessionStreamStore.getState().applySnapshot(sessionId, snapshot));
}

/** A transport whose config registers `count` Claude accounts. */
function transportWith(count: number) {
  const config = {
    claudeCode: {
      resolvedAccount: '/Users/test/.claude-acct-1',
      inherited: false,
      accounts: Array.from({ length: count }, (_, i) => ({
        id: `acct-${i + 1}`,
        path: `/Users/test/.claude-acct-${i + 1}`,
        label: `Acct ${i + 1}`,
        color: '#2f7be0',
        colorIsDefault: true,
        isAccountRoot: true,
      })),
    },
  } as unknown as ServerConfig;
  return createMockTransport({ getConfig: vi.fn().mockResolvedValue(config) });
}

/** The status line's usage and context wiring for one session, in miniature. */
function StatusNumbers({ sessionId }: { sessionId: string }) {
  const diagnostics = useSessionDiagnostics(sessionId);
  const account = useSessionAccount(sessionId);
  const statusUsage = useStatusUsage(sessionId, account, diagnostics.usage);
  const contextReading = useSessionStreamStatus(sessionId)?.contextUsage ?? null;
  const ctx = {
    account: accountChipPromotion(account),
    usage: statusUsage.usage,
    contextPercent: diagnostics.contextPercent,
  } as StatusPromotionContext;
  const usageShown = getStatusBarItem('usage')!.promote(ctx);
  const contextShown = getStatusBarItem('context')!.promote(ctx);
  return (
    <div data-testid={`status-${sessionId}`}>
      {usageShown && statusUsage.usage && (
        <UsageStatusItem usage={statusUsage.usage} observedAt={statusUsage.observedAt} />
      )}
      {contextShown && diagnostics.contextPercent !== null && (
        <ContextItem percent={diagnostics.contextPercent} reading={contextReading} />
      )}
    </div>
  );
}

function Harness({ sessionIds }: { sessionIds: string[] }) {
  useAccountUsageSync();
  return (
    <>
      {sessionIds.map((id) => (
        <StatusNumbers key={id} sessionId={id} />
      ))}
    </>
  );
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

function renderStatus(
  sessionIds: string[],
  { transport = transportWith(1), queryClient = createTestQueryClient() } = {}
) {
  render(<Harness sessionIds={sessionIds} />, { wrapper: wrapperFor(transport, queryClient) });
  return { transport, queryClient };
}

/** The usage item inside one session's status line, or `null`. */
function usageIn(sessionId: string): HTMLElement | null {
  return (
    screen
      .getByTestId(`status-${sessionId}`)
      .querySelector<HTMLElement>('[aria-label="Subscription usage"]') ?? null
  );
}

describe('usage from the moment a session opens', () => {
  it('shows on the FIRST render from the seeded cache, with no turn and no request', () => {
    mockSessions = [createMockSession({ id: SID_A, runtime: 'claude-code', accountId: 'acct-2' })];
    const transport = transportWith(1);
    const queryClient = createTestQueryClient();
    // What the session list envelope's `accountUsage` does on the way in.
    seedAccountUsage(queryClient, [reading({ usedPct: 40 })]);
    renderStatus([SID_A], { transport, queryClient });

    // A healthy 40%: promoted all the same (the §6.8 promotion change).
    expect(usageIn(SID_A)).toHaveTextContent('40%');
    expect(transport.getAccountUsage).not.toHaveBeenCalled();
  });

  it("shows from the session's own snapshot when the shared cache has nothing yet", async () => {
    mockSessions = [createMockSession({ id: SID_A, runtime: 'claude-code', accountId: 'acct-2' })];
    const { transport } = renderStatus([SID_A]);
    expect(usageIn(SID_A)).toBeNull();

    openSession(SID_A, { accountUsage: reading({ usedPct: 63 }) });

    await waitFor(() => expect(usageIn(SID_A)).toHaveTextContent('63%'));
    expect(transport.getAccountUsage).not.toHaveBeenCalled();
  });

  it('shows nothing with no reading at all, never a 0%', async () => {
    mockSessions = [createMockSession({ id: SID_A, runtime: 'claude-code', accountId: 'acct-2' })];
    const { queryClient } = renderStatus([SID_A]);
    openSession(SID_A);
    await waitFor(() => expect(queryClient.getQueryData(configKeys.current())).toBeDefined());
    expect(usageIn(SID_A)).toBeNull();
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('resolves a Codex session to its implicit (codex, default) account', async () => {
    mockSessions = [createMockSession({ id: SID_A, runtime: 'codex', accountId: 'default' })];
    const queryClient = createTestQueryClient();
    seedAccountUsage(queryClient, [
      // The same id on another runtime must not be read.
      reading({ runtime: 'claude-code', accountId: 'default', usedPct: 88 }),
      reading({
        runtime: 'codex',
        accountId: 'default',
        path: '/Users/test/.codex',
        usedPct: 35,
        windows: [
          {
            key: 'seven_day',
            label: 'Weekly',
            usedPct: 35,
            resetsAt: null,
            status: 'allowed',
            expired: false,
            observedAt: minutesAgo(5),
            source: 'rollout',
          },
        ],
      }),
    ]);
    const { transport } = renderStatus([SID_A], { queryClient });

    await waitFor(() => expect(usageIn(SID_A)).toHaveTextContent('35%'));
    expect(transport.getAccountUsage).not.toHaveBeenCalled();
  });

  it('resolves a Codex session with no account id on its row to the implicit account too', async () => {
    mockSessions = [createMockSession({ id: SID_A, runtime: 'codex' })];
    const queryClient = createTestQueryClient();
    seedAccountUsage(queryClient, [
      reading({ runtime: 'codex', accountId: 'default', path: '/Users/test/.codex', usedPct: 35 }),
    ]);
    renderStatus([SID_A], { queryClient });
    await waitFor(() => expect(usageIn(SID_A)).toHaveTextContent('35%'));
  });
});

describe('usage is account-wide', () => {
  it('two sessions on one account show the same numbers and move together on one event', async () => {
    mockSessions = [
      createMockSession({ id: SID_A, runtime: 'claude-code', accountId: 'acct-2' }),
      createMockSession({ id: SID_B, runtime: 'claude-code', accountId: 'acct-2' }),
    ];
    const queryClient = createTestQueryClient();
    seedAccountUsage(queryClient, [reading({ usedPct: 40 })]);
    const { transport } = renderStatus([SID_A, SID_B], { queryClient });
    expect(usageIn(SID_A)).toHaveTextContent('40%');
    expect(usageIn(SID_B)).toHaveTextContent('40%');

    act(() => handlers.get('account_usage')!(reading({ usedPct: 57, at: minutesAgo(1) })));

    await waitFor(() => expect(usageIn(SID_A)).toHaveTextContent('57%'));
    expect(usageIn(SID_B)).toHaveTextContent('57%');
    expect(transport.getAccountUsage).not.toHaveBeenCalled();
  });

  it("a snapshot's old usage never beats the account; a live frame after it does", async () => {
    mockSessions = [createMockSession({ id: SID_A, runtime: 'claude-code', accountId: 'acct-2' })];
    const queryClient = createTestQueryClient();
    seedAccountUsage(queryClient, [reading({ usedPct: 40, at: minutesAgo(5) })]);
    renderStatus([SID_A], { queryClient });

    // Reopened: the snapshot carries an hours-old turn usage with no time.
    openSession(SID_A, { usage: { kind: 'subscription', utilization: 0.9, state: 'warning' } });
    await waitFor(() => expect(usageIn(SID_A)).toHaveTextContent('40%'));

    // A live frame arrives now, after the account's reading.
    act(() =>
      useSessionStreamStore.getState().applyEvent(SID_A, {
        type: 'status_change',
        seq: 1,
        status: { usage: { kind: 'subscription', utilization: 0.55, state: 'ok' } },
      })
    );
    await waitFor(() => expect(usageIn(SID_A)).toHaveTextContent('55%'));
  });

  it('is never gated: one Claude account still shows usage', () => {
    mockSessions = [createMockSession({ id: SID_A, runtime: 'claude-code', accountId: 'acct-1' })];
    const queryClient = createTestQueryClient();
    seedAccountUsage(queryClient, [reading({ accountId: 'acct-1', usedPct: 22 })]);
    renderStatus([SID_A], { transport: transportWith(1), queryClient });
    expect(usageIn(SID_A)).toHaveTextContent('22%');
  });
});

describe('context from the moment a session opens', () => {
  it("shows the session's cached context before any turn, below any warning", async () => {
    mockSessions = [createMockSession({ id: SID_A, runtime: 'claude-code', accountId: 'acct-2' })];
    renderStatus([SID_A]);
    openSession(SID_A, {
      contextUsage: {
        totalTokens: 24_000,
        maxTokens: 200_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        observedAt: minutesAgo(12),
      },
    });
    const status = screen.getByTestId(`status-${SID_A}`);
    await waitFor(() =>
      expect(status.querySelector('[aria-label="Context window usage"]')).toHaveTextContent('12%')
    );
  });

  it('shows no context without a cached reading, as before', async () => {
    mockSessions = [createMockSession({ id: SID_A, runtime: 'claude-code', accountId: 'acct-2' })];
    const { queryClient } = renderStatus([SID_A]);
    openSession(SID_A);
    await waitFor(() => expect(queryClient.getQueryData(configKeys.current())).toBeDefined());
    expect(
      screen.getByTestId(`status-${SID_A}`).querySelector('[aria-label="Context window usage"]')
    ).toBeNull();
  });
});
