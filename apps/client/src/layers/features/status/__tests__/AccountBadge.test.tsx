/**
 * @vitest-environment jsdom
 *
 * The session header's account badge (spec `claude-account-ui` §6.3): the
 * account's dot and name, `· out` on the error surface when the account ran
 * out, the normal pill when only one model did, and nothing at all unless the
 * identity gate is open (invariant 1).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { Session, ServerConfig } from '@dorkos/shared/types';
import type { Transport } from '@dorkos/shared/transport';
import type { AccountUsage } from '@dorkos/shared/account-usage';
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

// The session list: stubbed, because the real one needs a router.
let mockSessions: Session[] = [];
vi.mock('@/layers/entities/session/model/query/use-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session/model/query/use-sessions')>()),
  useSessions: () => ({ sessions: mockSessions, isLoading: false }) as never,
}));
vi.mock('@/layers/shared/model/media/use-is-mobile', () => ({ useIsMobile: () => false }));

import { AccountBadge } from '../ui/AccountBadge';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const SID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  mockSessions = [];
  useAppStore.setState({ pendingAccount: null, pendingRuntime: null, selectedCwd: '/work' });
});

afterEach(cleanup);

function registered(n: number) {
  return {
    id: `acct-${n}`,
    path: `/Users/test/.claude-acct-${n}`,
    label: `Acct ${n}`,
    color: '#9b51e0',
    colorIsDefault: true,
    isAccountRoot: true,
  };
}

/** A transport whose config registers `count` Claude accounts (Acct 1, Acct 2, …). */
function transportWith(count: number): Transport {
  const config = {
    claudeCode: {
      resolvedAccount: '/Users/test/.claude-acct-1',
      inherited: false,
      accounts: Array.from({ length: count }, (_, i) => registered(i + 1)),
    },
  } as unknown as ServerConfig;
  return createMockTransport({ getConfig: vi.fn().mockResolvedValue(config) });
}

function renderBadge(transport: Transport, usage: AccountUsage[] = []): QueryClient {
  const queryClient = createTestQueryClient();
  seedAccountUsage(queryClient, usage);
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <div data-testid="header">
            <AccountBadge sessionId={SID} />
          </div>
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  return queryClient;
}

/** Wait until config and capabilities have landed, so an absence is the answer. */
async function settled(queryClient: QueryClient) {
  await waitFor(() => {
    expect(queryClient.getQueryData(configKeys.current())).toBeDefined();
    expect(queryClient.getQueryData(['capabilities'])).toBeDefined();
  });
}

/** A started Claude session on account `n`, optionally out of usage. */
function onAccount(n: number, overrides: Partial<Session> = {}): Session {
  return createMockSession({
    id: SID,
    runtime: 'claude-code',
    accountId: `acct-${n}`,
    account: `/Users/test/.claude-acct-${n}`,
    ...overrides,
  });
}

describe('AccountBadge', () => {
  it('names the account with its dot', async () => {
    mockSessions = [onAccount(2)];
    renderBadge(transportWith(2));
    expect(await screen.findByText('Acct 2')).toBeInTheDocument();
    expect(screen.getByTestId('header')).toHaveTextContent(/^Acct 2$/);
  });

  it('reads "Acct 4 · out" when the account ran out', async () => {
    mockSessions = [
      onAccount(4, { status: { lifecycle: 'idle', limit: createMockSessionLimit('ask') } }),
    ];
    renderBadge(transportWith(4));
    await screen.findByText('Acct 4');
    expect(screen.getByTestId('header')).toHaveTextContent('Acct 4 · out');
  });

  it('keeps the normal badge when only one model ran out (chip state `model-out`)', async () => {
    mockSessions = [
      onAccount(4, {
        status: {
          lifecycle: 'idle',
          limit: createMockSessionLimit('ask', { scope: 'model', state: 'model-limited' }),
        },
      }),
    ];
    renderBadge(transportWith(4));
    await screen.findByText('Acct 4');
    expect(screen.getByTestId('header')).toHaveTextContent(/^Acct 4$/);
    expect(screen.queryByText(/out/)).toBeNull();
  });

  it('keeps the normal badge for a moved session', async () => {
    mockSessions = [
      onAccount(4, { status: { lifecycle: 'idle', limit: createMockSessionLimit('continued') } }),
    ];
    renderBadge(transportWith(4));
    await screen.findByText('Acct 4');
    expect(screen.getByTestId('header')).toHaveTextContent(/^Acct 4$/);
  });

  it.each([0, 1])('draws nothing with %i Claude account(s)', async (count) => {
    mockSessions = [onAccount(1)];
    const queryClient = renderBadge(transportWith(count));
    await settled(queryClient);
    expect(screen.getByTestId('header')).toBeEmptyDOMElement();
  });

  it('draws nothing on a Codex session, even one that ran out', async () => {
    mockSessions = [
      createMockSession({
        id: SID,
        runtime: 'codex',
        accountId: 'default',
        status: { lifecycle: 'idle', limit: createMockSessionLimit('ask') },
      }),
    ];
    const queryClient = renderBadge(transportWith(2));
    await settled(queryClient);
    expect(screen.getByTestId('header')).toBeEmptyDOMElement();
  });

  it('names this computer’s own sign-in by the host’s label, never ".claude"', async () => {
    const MAIN = "Main (this computer's sign-in)";
    mockSessions = [
      createMockSession({
        id: SID,
        runtime: 'claude-code',
        accountId: 'default',
        account: '/Users/test/.claude',
      }),
    ];
    renderBadge(transportWith(2), [
      createMockAccountUsage({ accountId: 'default', path: '/Users/test/.claude', label: MAIN }),
    ]);
    expect(await screen.findByText(MAIN)).toBeInTheDocument();
    expect(screen.queryByText('.claude')).toBeNull();
  });
});
