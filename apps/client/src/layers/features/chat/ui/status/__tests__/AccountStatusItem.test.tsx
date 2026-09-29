/**
 * @vitest-environment jsdom
 *
 * The status bar's account chip wired to the "Continue on another account"
 * picker (spec `claude-account-ui` §6.1, §6.6): the popover's action opens
 * the picker, closing it returns focus to the chip, and with one account or a
 * Codex session there is no chip, so no action either (invariant 1).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { Session, ServerConfig } from '@dorkos/shared/types';
import type { ContinueOptionsResponse } from '@dorkos/shared/account-usage';
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
  useAppStore,
} from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';

// The session list and navigation are stubbed, because the real ones need a router.
let mockSessions: Session[] = [];
vi.mock('@/layers/entities/session/model/query/use-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session/model/query/use-sessions')>()),
  useSessions: () => ({ sessions: mockSessions, isLoading: false }) as never,
}));
vi.mock('@/layers/entities/session/model/navigation/use-session-id', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/layers/entities/session/model/navigation/use-session-id')
  >()),
  useSessionId: () => [null, vi.fn()],
}));
vi.mock('@/layers/shared/model/media/use-is-mobile', () => ({ useIsMobile: () => false }));

import { useSessionAccount } from '@/layers/features/status';
import { AccountStatusItem } from '../AccountStatusItem';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const SID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  // The usage fixtures are read on 2026-09-27; pin the clock to then.
  vi.useFakeTimers({ now: new Date('2026-09-27T12:05:00.000Z'), shouldAdvanceTime: true });
  mockSessions = [];
  useAppStore.setState({ pendingAccount: null, pendingRuntime: null, selectedCwd: '/work' });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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
  const answer: ContinueOptionsResponse = {
    plan: { mode: 'ask' },
    ranking: {
      accounts: [
        {
          id: 'acct-2',
          label: 'Acct 2',
          color: '#1d8a4a',
          usage: createMockAccountUsage(),
          eligible: true,
          reason: 'Has usage left.',
          runtime: 'claude-code',
        },
      ],
      recommendedId: 'acct-2',
    },
    advised: false,
  };
  return createMockTransport({
    getConfig: vi.fn().mockResolvedValue(config),
    getContinueOptions: vi.fn().mockResolvedValue(answer),
  });
}

function Harness() {
  const account = useSessionAccount(SID);
  return <AccountStatusItem sessionId={SID} account={account} />;
}

function renderItem(count: number, runtime = 'claude-code') {
  mockSessions = [
    createMockSession({
      id: SID,
      runtime,
      accountId: runtime === 'claude-code' ? 'acct-1' : 'default',
      account: runtime === 'claude-code' ? '/Users/test/.claude-acct-1' : undefined,
      status: { lifecycle: 'idle', limit: createMockSessionLimit('ask', { accountId: 'acct-1' }) },
    }),
  ];
  const transport = transportWith(count);
  const queryClient: QueryClient = createTestQueryClient();
  seedAccountUsage(queryClient, [
    createMockAccountUsage({
      accountId: 'acct-1',
      path: '/Users/test/.claude-acct-1',
      label: 'Acct 1',
    }),
  ]);
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <Harness />
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  return { transport, queryClient };
}

const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

describe('the popover opens the picker', () => {
  it('opens the picker from "Continue on another account", and Escape returns to the chip', async () => {
    const { transport } = renderItem(2);
    const chip = await screen.findByRole('button', { name: /^Acct 1/ });
    await user().click(chip);
    await user().click(await screen.findByRole('button', { name: /Continue on another account/ }));

    expect(
      await screen.findByRole('dialog', { name: 'Continue on another account' })
    ).toBeInTheDocument();
    expect(await screen.findByRole('radio', { name: /Acct 2/ })).toBeChecked();
    expect(transport.getContinueOptions).toHaveBeenCalledWith(SID);

    await user().keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: /^Acct 1/ })).toHaveFocus());
  });
});

describe('the identity gate (invariant 1)', () => {
  async function settled(queryClient: QueryClient) {
    await waitFor(() => {
      expect(queryClient.getQueryData(configKeys.current())).toBeDefined();
      expect(queryClient.getQueryData(['capabilities'])).toBeDefined();
    });
  }

  it.each([0, 1])('renders no chip and no action with %i Claude accounts', async (count) => {
    const { queryClient, transport } = renderItem(count);
    await settled(queryClient);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(transport.getContinueOptions).not.toHaveBeenCalled();
  });

  it('renders no chip and no action on a Codex session', async () => {
    const { queryClient, transport } = renderItem(2, 'codex');
    await settled(queryClient);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(transport.getContinueOptions).not.toHaveBeenCalled();
  });
});
