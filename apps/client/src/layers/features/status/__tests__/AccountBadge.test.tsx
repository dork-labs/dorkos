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
import { STATUS_TONE_SURFACE, TooltipProvider } from '@/layers/shared/ui';
import { SessionRow } from '@/layers/entities/session';

// The session list: stubbed, because the real one needs a router.
let mockSessions: Session[] = [];
vi.mock('@/layers/entities/session/model/query/use-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session/model/query/use-sessions')>()),
  useSessions: () => ({ sessions: mockSessions, isLoading: false }) as never,
}));
vi.mock('@/layers/shared/model/media/use-is-mobile', () => ({ useIsMobile: () => false }));

import { AccountBadge } from '../ui/AccountBadge';

/** The red surface's background class, from the token itself. */
const RED = STATUS_TONE_SURFACE.error.split(' ').filter((c) => c.startsWith('bg-'));

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

function renderBadge(
  transport: Transport,
  usage: AccountUsage[] = [],
  { withRow = false } = {}
): QueryClient {
  const queryClient = createTestQueryClient();
  seedAccountUsage(queryClient, usage);
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <div data-testid="header">
            <AccountBadge sessionId={SID} />
          </div>
          {withRow && mockSessions[0] && (
            <SessionRow
              variant="compact"
              session={mockSessions[0]}
              isActive={false}
              onClick={() => {}}
            />
          )}
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

  it('reads "Acct 4 · out" in red while the session needs action, and says why', async () => {
    mockSessions = [
      onAccount(4, { status: { lifecycle: 'idle', limit: createMockSessionLimit('ask') } }),
    ];
    renderBadge(transportWith(4));
    const badge = await screen.findByRole('group', { name: 'Acct 4, out · needs you' });
    // The row's own words are printed, not just "out" (color is never the only signal).
    expect(badge).toHaveTextContent('Acct 4 · out · needs you');
    expect(badge).toHaveClass(...RED);
  });

  it('says "handing off" while the work is about to move by itself', async () => {
    mockSessions = [
      onAccount(4, { status: { lifecycle: 'idle', limit: createMockSessionLimit('auto') } }),
    ];
    renderBadge(transportWith(4));
    const badge = await screen.findByRole('group', { name: 'Acct 4, out · handing off' });
    expect(badge).toHaveTextContent('Acct 4 · out · handing off');
    expect(badge).toHaveClass(...RED);
  });

  it.each(['waiting-reset', 'reset-ready'] as const)(
    'stays neutral once the person chose to wait (`%s`, Q13)',
    async (state) => {
      mockSessions = [
        onAccount(4, {
          status: { lifecycle: 'idle', limit: createMockSessionLimit('waiting', { state }) },
        }),
      ];
      renderBadge(transportWith(4));
      const badge = await screen.findByRole('group', { name: 'Acct 4, out · waiting for reset' });
      expect(badge).toHaveTextContent('Acct 4 · out · waiting for reset');
      expect(badge).not.toHaveClass(...RED);
      // A narrow bar prints the short form; the accessible name and the
      // tooltip keep the full words (04 §15).
      const narrow = badge.querySelector('[data-slot="account-badge-narrow"]');
      expect(narrow).toHaveTextContent('· out · waiting');
      expect(narrow).not.toHaveTextContent('reset');
      expect(badge).toHaveAttribute('title', 'Acct 4 · out · waiting for reset');
    }
  );

  it('stays plain when the account reads limited but this session has no limit of its own', async () => {
    mockSessions = [onAccount(4)];
    renderBadge(transportWith(4), [
      createMockAccountUsage({
        accountId: 'acct-4',
        path: '/Users/test/.claude-acct-4',
        label: 'Acct 4',
        state: 'limited',
      }),
    ]);
    const badge = await screen.findByRole('group', { name: 'Acct 4' });
    expect(badge).toHaveTextContent(/^Acct 4$/);
    expect(badge).not.toHaveClass(...RED);
  });

  it.each([
    ['needs you', createMockSessionLimit('ask'), 'out · needs you'],
    ['handing off', createMockSessionLimit('auto'), 'out · handing off'],
    ['waiting', createMockSessionLimit('waiting'), 'out · waiting for reset'],
    ['moved', createMockSessionLimit('continued'), null],
    ['model only', createMockSessionLimit('ask', { scope: 'model', state: 'model-limited' }), null],
  ])('agrees with the sidebar row (%s)', async (_case, limit, text) => {
    mockSessions = [onAccount(4, { status: { lifecycle: 'idle', limit } })];
    renderBadge(transportWith(4), [], { withRow: true });
    const badge = await screen.findByRole('group', { name: text ? `Acct 4, ${text}` : 'Acct 4' });
    const row = screen.getByTestId('session-row');
    if (text) {
      expect(row).toHaveTextContent(text);
      expect(badge).toHaveTextContent(`Acct 4 · ${text}`);
      expect(badge.classList.contains(RED[0]!)).toBe(row.classList.contains(RED[0]!));
    } else {
      expect(row).not.toHaveTextContent(/out ·/);
      expect(badge).not.toHaveClass(...RED);
      expect(row).not.toHaveClass(...RED);
    }
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
    const badge = await screen.findByRole('group', { name: 'Acct 4' });
    expect(badge).toHaveTextContent(/^Acct 4$/);
    expect(badge).not.toHaveClass(...RED);
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
