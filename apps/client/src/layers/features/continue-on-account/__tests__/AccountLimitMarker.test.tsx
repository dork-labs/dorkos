/**
 * @vitest-environment jsdom
 *
 * The transcript marker (spec `claude-account-ui` §6.7): a turn's `rate_limit`
 * error shows nothing while its episode's banner is up, then one muted line
 * from the episode's history row, matched by time; an episode older than the
 * history keeps the plain error card.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { LimitHistoryEntry } from '@dorkos/shared/account-usage';
import type { Session, ServerConfig } from '@dorkos/shared/types';
import type { Transport } from '@dorkos/shared/transport';
import { createMockSession, createMockSessionLimit, createMockTransport } from '@dorkos/test-utils';
import { createTestQueryClient } from '@dorkos/test-utils/react-helpers';
import { TransportProvider, accountKeys } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { useSessionStreamStore } from '@/layers/entities/session';

let mockSessions: Session[] = [];
const mockSetSessionId = vi.fn();
vi.mock('@/layers/entities/session/model/query/use-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session/model/query/use-sessions')>()),
  useSessions: () => ({ sessions: mockSessions, isLoading: false }) as never,
}));
vi.mock('@/layers/entities/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useSessions: () => ({ sessions: mockSessions, isLoading: false }) as never,
  useSessionId: () => [null, mockSetSessionId],
}));

import { AccountLimitMarker } from '../ui/AccountLimitMarker';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const MINUTE = 60_000;
/** Sunday 4pm local, so "at 4:02pm" is the same on every machine. */
const NOW = new Date(2026, 8, 27, 16, 30, 0);
const SID = '33333333-3333-4333-8333-333333333333';
/** When the turn's message was stamped. */
const MESSAGE_AT = new Date(2026, 8, 27, 14, 0, 0).toISOString();

function local(hours: number, minutes: number): string {
  return new Date(2026, 8, 27, hours, minutes, 0).toISOString();
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true });
  mockSessions = [];
  mockSetSessionId.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useSessionStreamStore.getState().removeSession(SID);
});

function entry(overrides: Partial<LimitHistoryEntry> = {}): LimitHistoryEntry {
  return {
    id: 'row-1',
    sessionId: SID,
    since: local(14, 1),
    runtime: 'claude-code',
    accountId: 'acct-4',
    window: 'seven_day',
    scope: 'account',
    resetsAt: null,
    resolution: 'moved',
    resolvedAt: local(14, 14),
    toSessionId: 'session-moved',
    toAccountId: 'acct-2',
    modelFrom: null,
    modelTo: null,
    ...overrides,
  };
}

function configWith(count: number): ServerConfig {
  return {
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
}

interface Setup {
  entries: LimitHistoryEntry[];
  accounts?: number;
  runtime?: string;
  limit?: ReturnType<typeof createMockSessionLimit> | null;
  historyFails?: boolean;
  at?: string;
}

function renderMarker(setup: Setup) {
  mockSessions = [
    createMockSession({
      id: SID,
      runtime: setup.runtime ?? 'claude-code',
      accountId: 'acct-4',
      status: { lifecycle: 'idle', limit: setup.limit ?? null },
    } as Partial<Session>),
  ];
  const transport: Transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue(configWith(setup.accounts ?? 4)),
    getModels: vi.fn().mockResolvedValue([
      { value: 'claude-opus-4-6', displayName: 'Opus', description: '' },
      { value: 'claude-sonnet-4-6', displayName: 'Sonnet', description: '' },
    ]),
    getLimitHistory: setup.historyFails
      ? vi.fn().mockRejectedValue(new Error('down'))
      : vi.fn().mockResolvedValue({ entries: setup.entries }),
  });
  const queryClient = createTestQueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <TooltipProvider>{children}</TooltipProvider>
        </TransportProvider>
      </QueryClientProvider>
    );
  }
  render(
    <AccountLimitMarker
      sessionId={SID}
      at={setup.at ?? MESSAGE_AT}
      fallback={<div data-testid="plain-card">plain error card</div>}
    />,
    { wrapper: Wrapper }
  );
  return { transport, queryClient };
}

function marker(): HTMLElement | null {
  return document.querySelector('[data-slot="account-limit-marker"]');
}

describe('each resolution', () => {
  it('moved: names both accounts, and the new one opens the moved session', async () => {
    renderMarker({ entries: [entry()] });
    await waitFor(() =>
      expect(marker()).toHaveTextContent('Acct 4 ran out · moved to Acct 2 at 2:14pm')
    );
    await userEvent.click(screen.getByRole('button', { name: 'Acct 2' }));
    expect(mockSetSessionId).toHaveBeenCalledWith('session-moved');
  });

  it('resumed-reset', async () => {
    renderMarker({
      entries: [entry({ resolution: 'resumed-reset', resolvedAt: local(16, 2) })],
    });
    await waitFor(() => expect(marker()).toHaveTextContent('Resumed after reset at 4:02pm'));
  });

  it('resumed-model: the models by their display names', async () => {
    renderMarker({
      entries: [
        entry({
          resolution: 'resumed-model',
          resolvedAt: local(16, 2),
          modelFrom: 'claude-opus-4-6',
          modelTo: 'claude-sonnet-4-6',
        }),
      ],
    });
    await waitFor(() =>
      expect(marker()).toHaveTextContent('Opus ran out · continued on Sonnet at 4:02pm')
    );
  });

  it('resumed-model with an unknown new model never claims a switch', async () => {
    renderMarker({
      entries: [
        entry({
          resolution: 'resumed-model',
          resolvedAt: local(16, 2),
          modelFrom: 'claude-opus-4-6',
          modelTo: null,
        }),
      ],
    });
    await waitFor(() =>
      expect(marker()).toHaveTextContent('Acct 4 ran out · continued here at 4:02pm')
    );
    expect(marker()).not.toHaveTextContent('continued on');
  });

  it('resumed-early ("Continue here anyway")', async () => {
    renderMarker({
      entries: [entry({ resolution: 'resumed-early', resolvedAt: local(16, 2) })],
    });
    await waitFor(() =>
      expect(marker()).toHaveTextContent('Acct 4 ran out · continued here at 4:02pm')
    );
  });

  it('a Codex episode is named "Codex"', async () => {
    renderMarker({
      runtime: 'codex',
      entries: [
        entry({
          runtime: 'codex',
          accountId: 'default',
          resolution: 'resumed-early',
          resolvedAt: local(16, 2),
        }),
      ],
    });
    await waitFor(() =>
      expect(marker()).toHaveTextContent('Codex ran out · continued here at 4:02pm')
    );
  });
});

describe('matching by time', () => {
  it('picks the first episode at or after the message, within five minutes', async () => {
    renderMarker({
      entries: [
        // Before the message: another turn's episode.
        entry({ id: 'a', since: local(13, 58), resolution: 'resumed-early' }),
        entry({
          id: 'b',
          since: local(14, 1),
          resolution: 'resumed-reset',
          resolvedAt: local(16, 2),
        }),
        entry({ id: 'c', since: local(14, 3), resolution: 'resumed-early' }),
      ],
    });
    await waitFor(() => expect(marker()).toHaveTextContent('Resumed after reset at 4:02pm'));
  });

  it('shows the plain card for an episode older than the history', async () => {
    renderMarker({ entries: [] });
    expect(await screen.findByTestId('plain-card')).toBeInTheDocument();
    expect(marker()).toBeNull();
  });

  it('shows the plain card when the nearest row is more than five minutes later', async () => {
    renderMarker({
      entries: [entry({ since: new Date(Date.parse(MESSAGE_AT) + 6 * MINUTE).toISOString() })],
    });
    expect(await screen.findByTestId('plain-card')).toBeInTheDocument();
  });
});

describe('while the episode is open', () => {
  it("draws nothing: that episode's banner speaks for it", async () => {
    const { transport } = renderMarker({
      entries: [],
      limit: createMockSessionLimit('ask', { since: local(14, 1) }),
    });
    await waitFor(() => expect(transport.getLimitHistory).toHaveBeenCalled());
    expect(marker()).toBeNull();
    expect(screen.queryByTestId('plain-card')).toBeNull();
  });

  it('still marks an older episode while a newer one is open', async () => {
    renderMarker({
      entries: [entry({ resolution: 'resumed-reset', resolvedAt: local(16, 2) })],
      limit: createMockSessionLimit('ask', { since: local(16, 20) }),
    });
    await waitFor(() => expect(marker()).toHaveTextContent('Resumed after reset at 4:02pm'));
  });
});

describe('no card flashes beside the banner', () => {
  it('draws nothing on a live turn (no timestamp yet) while a limit is open', async () => {
    const { transport } = renderMarker({
      entries: [],
      at: '',
      limit: createMockSessionLimit('ask', { since: local(14, 1) }),
    });
    await waitFor(() => expect(transport.getLimitHistory).toHaveBeenCalled());
    expect(marker()).toBeNull();
    expect(screen.queryByTestId('plain-card')).toBeNull();
  });

  it('draws nothing while the history is read again after the limit clears', async () => {
    const { transport, queryClient } = renderMarker({
      entries: [],
      limit: createMockSessionLimit('ask', { since: local(14, 1) }),
    });
    await waitFor(() => expect(transport.getLimitHistory).toHaveBeenCalledTimes(1));
    let answer!: (value: { entries: LimitHistoryEntry[] }) => void;
    vi.mocked(transport.getLimitHistory).mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    act(() => {
      useSessionStreamStore
        .getState()
        .applyEvent(SID, { type: 'status_change', seq: 1, status: { limit: null } } as never);
      void queryClient.invalidateQueries({ queryKey: accountKeys.limitHistory(SID) });
    });
    await waitFor(() => expect(transport.getLimitHistory).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('plain-card')).toBeNull();
    await act(async () => {
      answer({ entries: [entry({ resolution: 'resumed-reset', resolvedAt: local(16, 2) })] });
    });
    await waitFor(() => expect(marker()).toHaveTextContent('Resumed after reset at 4:02pm'));
    expect(screen.queryByTestId('plain-card')).toBeNull();
  });

  it("keeps an old episode's plain card through a background refetch", async () => {
    const { transport, queryClient } = renderMarker({ entries: [] });
    expect(await screen.findByTestId('plain-card')).toBeInTheDocument();
    vi.mocked(transport.getLimitHistory).mockReturnValueOnce(new Promise(() => {}));
    act(() => {
      void queryClient.invalidateQueries({ queryKey: accountKeys.limitHistory(SID) });
    });
    await waitFor(() => expect(transport.getLimitHistory).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('plain-card')).toBeInTheDocument();
  });
});
