/**
 * @vitest-environment jsdom
 *
 * A session's Claude account, shown in the list row (spec
 * `claude-code-accounts`). The account is a real-money fact — each of the
 * operator's accounts bills a different client — so a row must say which one it
 * belongs to, but ONLY once more than one account is registered: on a
 * single-account machine every row would carry the same badge and answer a
 * question nobody can ask.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session, ServerConfig } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TooltipProvider } from '@/layers/shared/ui';
import { TransportProvider, useAppStore, useClaudeAccounts } from '@/layers/shared/model';
import { SessionRow } from '../ui/SessionRow';
import { useSessionChatStore } from '../model/stream/session-chat-store';
import { useSessionListStore } from '../model/stream/session-list-store';

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
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const WORK_ACCOUNT = '/Users/dev/.claude2';
const HOME_ACCOUNT = '/Users/dev/.claude';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'abc12345-def6-7890-abcd-ef1234567890',
    title: 'Test conversation',
    createdAt: '2026-02-07T10:00:00Z',
    updatedAt: '2026-02-07T14:00:00Z',
    permissionMode: 'default',
    runtime: 'claude-code',
    ...overrides,
  };
}

/** Server config carrying exactly the `claudeCode` block the badge reads. */
function configWithAccounts(
  accounts: { path: string; label: string | null }[]
): Partial<ServerConfig> {
  return {
    claudeCode: {
      resolvedAccount: HOME_ACCOUNT,
      inherited: true,
      accounts: accounts.map((account, index) => ({
        ...account,
        id: `account-${index}`,
        isAccountRoot: true,
      })),
    },
  };
}

/**
 * Reports what the accounts hook currently knows.
 *
 * Mounted next to the row so a test can wait for the config read to LAND before
 * asserting the badge is ABSENT. The row's title renders on the first pass, while
 * the config query is still in flight, so waiting on it would assert the absence
 * of a badge that had not yet had the chance to appear.
 */
function AccountsProbe() {
  const { accounts } = useClaudeAccounts();
  return <span data-testid="accounts-known">{accounts.length}</span>;
}

function renderRowWith(accounts: { path: string; label: string | null }[], ui: React.ReactElement) {
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue(configWithAccounts(accounts)),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(ui, {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <TooltipProvider>{children}</TooltipProvider>
        </TransportProvider>
      </QueryClientProvider>
    ),
  });
}

describe('session account badge', () => {
  beforeEach(() => {
    useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
    useSessionListStore.setState({ sessions: {}, statuses: {}, statusCwds: {}, unseen: {} });
    useAppStore.setState({ selectedCwd: null });
  });
  afterEach(cleanup);

  it('names the account on a full row when more than one is registered', async () => {
    renderRowWith(
      [
        { path: HOME_ACCOUNT, label: 'Personal' },
        { path: WORK_ACCOUNT, label: 'Acme Corp' },
      ],
      <SessionRow
        variant="full"
        session={makeSession({ account: WORK_ACCOUNT })}
        isActive={false}
        onClick={() => {}}
      />
    );

    // Would go red if the badge stopped rendering, read the wrong account, or
    // printed the path instead of the operator's label.
    await waitFor(() => expect(screen.getByText('Acme Corp')).toBeDefined());
  });

  it('names the account on a compact row too', async () => {
    renderRowWith(
      [
        { path: HOME_ACCOUNT, label: 'Personal' },
        { path: WORK_ACCOUNT, label: 'Acme Corp' },
      ],
      <SessionRow
        variant="compact"
        session={makeSession({ account: HOME_ACCOUNT })}
        isActive={false}
        onClick={() => {}}
      />
    );

    await waitFor(() => expect(screen.getByText('Personal')).toBeDefined());
  });

  it('falls back to the folder name when the account has no label, and never prints the path', async () => {
    renderRowWith(
      [
        { path: HOME_ACCOUNT, label: null },
        { path: WORK_ACCOUNT, label: null },
      ],
      <SessionRow
        variant="full"
        session={makeSession({ account: WORK_ACCOUNT })}
        isActive={false}
        onClick={() => {}}
      />
    );

    await waitFor(() => expect(screen.getByText('.claude2')).toBeDefined());
    // A list row is not the place for an absolute path — it swamps the title.
    expect(screen.queryByText(WORK_ACCOUNT)).toBeNull();
  });

  it('stays silent when only one account is registered', async () => {
    renderRowWith(
      [{ path: WORK_ACCOUNT, label: 'Acme Corp' }],
      <>
        <AccountsProbe />
        <SessionRow
          variant="full"
          session={makeSession({ account: WORK_ACCOUNT })}
          isActive={false}
          onClick={() => {}}
        />
      </>
    );

    // Wait for the CONFIG to land — the row's title is on screen before it does,
    // so synchronizing on the title would assert an absence that nothing had yet
    // had the chance to fill.
    await waitFor(() => expect(screen.getByTestId('accounts-known').textContent).toBe('1'));
    expect(screen.queryByText('Acme Corp')).toBeNull();
  });

  it('stays silent when the session has no account (a runtime with no account concept)', async () => {
    renderRowWith(
      [
        { path: HOME_ACCOUNT, label: 'Personal' },
        { path: WORK_ACCOUNT, label: 'Acme Corp' },
      ],
      <>
        <AccountsProbe />
        <SessionRow
          variant="full"
          session={makeSession({ runtime: 'codex' })}
          isActive={false}
          onClick={() => {}}
        />
      </>
    );

    await waitFor(() => expect(screen.getByTestId('accounts-known').textContent).toBe('2'));
    expect(screen.queryByText('Personal')).toBeNull();
    expect(screen.queryByText('Acme Corp')).toBeNull();
  });
});
