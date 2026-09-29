/**
 * @vitest-environment jsdom
 *
 * A session row's account dot and out-of-usage state (spec `claude-account-ui`
 * §6.2, decisions Q4, Q13 and Q14). Both sit behind the one account identity
 * gate: two or more Claude accounts on a Claude Code session. With one account
 * every row would wear the same dot, and a Codex session has no accounts to
 * tell apart even when it ran out (its banner says so; the row does not).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import type { Session, ServerConfig } from '@dorkos/shared/types';
import type { SessionLimit } from '@dorkos/shared/session-stream';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import {
  createMockAccountUsage,
  createMockSessionLimit,
  createMockTransport,
} from '@dorkos/test-utils';
import { createTestQueryClient } from '@dorkos/test-utils/react-helpers';
import { useRuntimeCapabilities } from '@/layers/entities/runtime';
import { formatRelativeTime } from '@/layers/shared/lib';
import { STATUS_TONE_SURFACE, TooltipProvider } from '@/layers/shared/ui';

/** The red tint's background class, from the token itself, so removing the token fails these tests. */
const RED_TINT = STATUS_TONE_SURFACE.error.split(' ').filter((c) => c.startsWith('bg-'));
import {
  TransportProvider,
  seedAccountUsage,
  useAppStore,
  useClaudeAccounts,
} from '@/layers/shared/model';
import { SessionRow } from '../ui/SessionRow';
import { useSessionChatStore } from '../model/stream/session-chat-store';
import { useSessionListStore } from '../model/stream/session-list-store';
import {
  DEFAULT_SESSION_STREAM_STATE,
  useSessionStreamStore,
} from '../model/stream/session-stream-store';

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

const COLORS = ['#2f7be0', '#1d8a4a', '#c2680a', '#9b51e0'];

function account(n: number) {
  return {
    id: `acct-${n}`,
    path: `/Users/dev/.claude-acct-${n}`,
    label: `Acct ${n}`,
    color: COLORS[n - 1]!,
    colorIsDefault: true,
    isAccountRoot: true,
  };
}

/** A session two hours old (relative, so the fixture never ages into a new bucket). */
function makeSession(overrides: Partial<Session> = {}): Session {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  return {
    id: 'abc12345-def6-7890-abcd-ef1234567890',
    title: 'Memory stamps',
    createdAt: twoHoursAgo,
    updatedAt: twoHoursAgo,
    permissionMode: 'default',
    runtime: 'claude-code',
    accountId: 'acct-2',
    account: '/Users/dev/.claude-acct-2',
    ...overrides,
  };
}

/** A session on account 2 whose status carries `limit`. */
function limitedSession(limit: SessionLimit, overrides: Partial<Session> = {}): Session {
  return makeSession({ status: { lifecycle: 'idle', limit }, ...overrides });
}

/** Reports when the accounts and the runtime capabilities have both landed. */
function ReadsProbe() {
  const { accounts } = useClaudeAccounts();
  const { data } = useRuntimeCapabilities();
  return <span data-testid="reads">{data ? `${accounts.length} accounts` : 'loading'}</span>;
}

function renderRow(
  session: Session,
  { accounts = 2, variant = 'full' as 'full' | 'compact', usage = [] as AccountUsage[] } = {}
) {
  const base = createMockTransport();
  const config = {
    claudeCode: {
      resolvedAccount: account(1).path,
      inherited: false,
      accounts: Array.from({ length: accounts }, (_, i) => account(i + 1)),
    },
  } as unknown as ServerConfig;
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue(config),
    getCapabilities: base.getCapabilities,
  });
  const queryClient = createTestQueryClient();
  // What the session list's envelope seeds.
  seedAccountUsage(queryClient, usage);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <ReadsProbe />
          <SessionRow variant={variant} session={session} isActive={false} onClick={() => {}} />
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  /** Wait until the gate has what it needs, so an absence is the answer and not the loading state. */
  const settled = () =>
    waitFor(() => expect(screen.getByTestId('reads')).toHaveTextContent(`${accounts} accounts`));
  return { ...view, settled };
}

/** The row's own control: the full row's `role="button"`, or the compact row's `<button>`. */
function rowControl() {
  return screen.getByRole('button', { name: /Memory stamps/ });
}

/** Account-wide states that wait on the person: red, "out · needs you". */
const NEEDS_YOU_STATES = ['limited', 'wait-only', 'all-accounts-out'] as const;
/** States after the person chose to wait: neutral, "out · waiting for reset". */
const CHOSE_TO_WAIT_STATES = ['waiting-reset', 'reset-ready'] as const;

describe('session row account dot', () => {
  beforeEach(() => {
    useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
    useSessionListStore.setState({ sessions: {}, statuses: {}, statusCwds: {}, unseen: {} });
    useSessionStreamStore.setState({ sessions: {} });
    useAppStore.setState({ selectedCwd: null });
  });
  afterEach(cleanup);

  it.each(['full', 'compact'] as const)(
    'draws the account dot, named by its tooltip, on a %s row with two accounts',
    async (variant) => {
      renderRow(makeSession(), { variant });
      const dot = await screen.findByRole('img', { name: 'Acct 2' });
      // The row no longer prints the name beside the dot (Q4).
      expect(screen.queryByText('Acct 2')).toBeNull();
      await userEvent.hover(dot);
      // One tooltip, the row's own, names the account: the dot nests none.
      const tooltips = await screen.findAllByRole('tooltip');
      expect(tooltips).toHaveLength(1);
      expect(tooltips[0]).toHaveTextContent('Acct 2');
    }
  );

  it('leads the title with the dot', async () => {
    renderRow(makeSession(), { variant: 'compact' });
    const dot = await screen.findByRole('img', { name: 'Acct 2' });
    const title = screen.getByText('Memory stamps');
    expect(dot.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('names the account in the full row’s accessible name', async () => {
    renderRow(makeSession());
    await screen.findByRole('img', { name: 'Acct 2' });
    expect(rowControl()).toHaveAccessibleName(expect.stringContaining('Acct 2'));
  });

  it.each([0, 1])('draws no dot and no out text with %i Claude account(s)', async (accounts) => {
    // On account 1, which is registered (and so has a color) whenever any account is.
    const { settled } = renderRow(
      limitedSession(createMockSessionLimit('ask'), {
        accountId: 'acct-1',
        account: '/Users/dev/.claude-acct-1',
      }),
      { accounts }
    );
    await settled();
    expect(screen.queryByRole('img', { name: /Acct/ })).toBeNull();
    expect(screen.queryByText(/^out ·/)).toBeNull();
    expect(screen.getByTestId('session-row')).not.toHaveAttribute('data-limit');
    expect(screen.getByTestId('session-row')).not.toHaveClass(...RED_TINT);
  });

  it('draws no dot and no out text on a Codex session, even one that ran out', async () => {
    const { settled } = renderRow(
      limitedSession(createMockSessionLimit('ask'), { runtime: 'codex', accountId: 'default' })
    );
    await settled();
    expect(screen.queryByRole('img', { name: /Acct/ })).toBeNull();
    expect(screen.queryByText(/^out ·/)).toBeNull();
    expect(rowControl()).not.toHaveAccessibleName(expect.stringContaining('Out of usage'));
  });
});

describe('session row out of usage', () => {
  beforeEach(() => {
    useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
    useSessionListStore.setState({ sessions: {}, statuses: {}, statusCwds: {}, unseen: {} });
    useSessionStreamStore.setState({ sessions: {} });
    useAppStore.setState({ selectedCwd: null });
  });
  afterEach(cleanup);

  it.each(['full', 'compact'] as const)(
    'says "out · handing off" in place of the time on a %s row, tinted red',
    async (variant) => {
      const session = limitedSession(createMockSessionLimit('auto'));
      renderRow(session, { variant });
      expect(await screen.findByText('out · handing off')).toBeInTheDocument();
      expect(screen.queryByText(formatRelativeTime(session.updatedAt))).toBeNull();
      expect(rowControl()).toHaveAccessibleName(expect.stringContaining('out · handing off'));
      expect(screen.getByTestId('session-row')).toHaveAttribute('data-limit', 'action');
      expect(screen.getByTestId('session-row')).toHaveClass(...RED_TINT);
    }
  );

  it.each(NEEDS_YOU_STATES)(
    'says "out · needs you", tinted red, for an account-wide `%s` limit',
    async (state) => {
      renderRow(limitedSession(createMockSessionLimit('ask', { scope: 'account', state })));
      expect(await screen.findByText('out · needs you')).toBeInTheDocument();
      expect(rowControl()).toHaveAccessibleName(expect.stringContaining('out · needs you'));
      // The border's tooltip and spoken state.
      expect(rowControl()).toHaveAccessibleName(expect.stringContaining('Out of usage'));
      expect(screen.getByTestId('session-row')).toHaveAttribute('data-limit', 'action');
      expect(screen.getByTestId('session-row')).toHaveClass(...RED_TINT);
    }
  );

  it.each(CHOSE_TO_WAIT_STATES)(
    'says "out · waiting for reset", untinted, once the person chose to wait (`%s`, Q13)',
    async (state) => {
      renderRow(limitedSession(createMockSessionLimit('waiting', { scope: 'account', state })));
      expect(await screen.findByText('out · waiting for reset')).toBeInTheDocument();
      expect(rowControl()).toHaveAccessibleName(expect.stringContaining('out · waiting for reset'));
      expect(screen.getByTestId('session-row')).toHaveAttribute('data-limit', 'waiting');
      expect(screen.getByTestId('session-row')).not.toHaveClass(...RED_TINT);
    }
  );

  it.each([
    ['model-limited', createMockSessionLimit('ask', { scope: 'model', state: 'model-limited' })],
    ['waiting-reset', createMockSessionLimit('waiting', { scope: 'model' })],
  ])('shows nothing for a model-scope %s limit, and keeps the time', async (_state, limit) => {
    const session = limitedSession(limit);
    const { settled } = renderRow(session);
    await settled();
    await screen.findByRole('img', { name: 'Acct 2' });
    expect(screen.queryByText(/^out ·/)).toBeNull();
    expect(screen.getByText(formatRelativeTime(session.updatedAt))).toBeInTheDocument();
    expect(screen.getByTestId('session-row')).not.toHaveAttribute('data-limit');
    expect(screen.getByTestId('session-row')).not.toHaveClass(...RED_TINT);
    expect(rowControl()).not.toHaveAccessibleName(expect.stringContaining('Out of usage'));
  });

  it('shows nothing for a moved session: its work lives in the new one (Q14)', async () => {
    const session = limitedSession(createMockSessionLimit('continued'));
    renderRow(session);
    await screen.findByRole('img', { name: 'Acct 2' });
    expect(screen.queryByText(/^out ·/)).toBeNull();
    expect(screen.getByText(formatRelativeTime(session.updatedAt))).toBeInTheDocument();
    expect(screen.getByTestId('session-row')).not.toHaveAttribute('data-limit');
    expect(screen.getByTestId('session-row')).not.toHaveClass(...RED_TINT);
  });

  it('shows nothing when the session carries no status', async () => {
    const session = makeSession();
    renderRow(session);
    await screen.findByRole('img', { name: 'Acct 2' });
    expect(screen.queryByText(/^out ·/)).toBeNull();
    expect(screen.getByText(formatRelativeTime(session.updatedAt))).toBeInTheDocument();
  });

  it('follows the live stream status over the list’s', async () => {
    const session = limitedSession(createMockSessionLimit('ask'));
    useSessionStreamStore.setState({
      sessions: {
        [session.id]: {
          ...DEFAULT_SESSION_STREAM_STATE,
          status: { lifecycle: 'idle', limit: createMockSessionLimit('auto') },
        },
      },
    } as never);
    renderRow(session);
    expect(await screen.findByText('out · handing off')).toBeInTheDocument();
    expect(within(screen.getByTestId('session-row')).queryByText('out · needs you')).toBeNull();
  });
});

describe('session row naming the standalone default (decision §12)', () => {
  beforeEach(() => {
    useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
    useSessionListStore.setState({ sessions: {}, statuses: {}, statusCwds: {}, unseen: {} });
    useSessionStreamStore.setState({ sessions: {} });
    useAppStore.setState({ selectedCwd: null });
  });
  afterEach(cleanup);

  const MAIN = "Main (this computer's sign-in)";
  const mainUsage = createMockAccountUsage({
    accountId: 'default',
    path: '/Users/dev/.claude',
    label: MAIN,
    color: '#2f7be0',
  });

  it.each(['full', 'compact'] as const)(
    'names this computer’s own sign-in by the host’s label, never ".claude", on a %s row',
    async (variant) => {
      renderRow(makeSession({ accountId: 'default', account: '/Users/dev/.claude' }), {
        variant,
        usage: [mainUsage],
      });
      const dot = await screen.findByRole('img', { name: MAIN });
      expect(screen.queryByRole('img', { name: '.claude' })).toBeNull();
      await userEvent.hover(dot);
      const tooltips = await screen.findAllByRole('tooltip');
      expect(tooltips).toHaveLength(1);
      expect(tooltips[0]).toHaveTextContent(MAIN);
      expect(rowControl()).toHaveAccessibleName(expect.stringContaining(MAIN));
    }
  );

  it('keeps a registered account’s own label', async () => {
    renderRow(makeSession(), { usage: [mainUsage] });
    expect(await screen.findByRole('img', { name: 'Acct 2' })).toBeInTheDocument();
  });
});
