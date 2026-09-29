/**
 * @vitest-environment jsdom
 *
 * The out-of-usage banner (spec `claude-account-ui` §6.7): one test per state
 * row, driven by the session's limit as S4 serves it (invariant 6), for any
 * runtime and any number of accounts (invariant 5).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { ACCOUNT_RESUME_PROMPT } from '@dorkos/shared/account-usage';
import type { LimitPlan, SessionLimit } from '@dorkos/shared/session-stream';
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
vi.mock('@/layers/shared/model/media/use-is-mobile', () => ({ useIsMobile: () => false }));

import { AccountLimitBanner } from '../ui/AccountLimitBanner';
import { useLimitComposer } from '../model/use-limit-composer';
import { PAUSED_MOVING_TEXT, PAUSED_TEXT } from '../lib/limit-banner';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A Sunday noon in local time, so "Tue 3pm" reads the same on every machine. */
const NOW = new Date(2026, 8, 27, 12, 0, 0);
const SID = '22222222-2222-4222-8222-222222222222';
const FLOW_DOWN = 'Flow could not be reached, so this was not changed.';

/** An instant `ms` from the pinned clock. */
function at(ms: number): string {
  return new Date(NOW.getTime() + ms).toISOString();
}

/** Tuesday 3pm local, two days and three hours after {@link NOW}. */
const TUE_3PM = at(2 * DAY + 3 * HOUR);

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

/** A limit in `state` with `plan`: Acct 4 out of its week until Tuesday 3pm, hit a minute ago. */
function limitOf(mode: LimitPlan['mode'], overrides: Partial<SessionLimit> = {}): SessionLimit {
  const plans: Record<LimitPlan['mode'], LimitPlan> = {
    ask: { mode: 'ask' },
    auto: { mode: 'auto', target: 'acct-2', fireAt: at(10_000) },
    waiting: { mode: 'waiting', resumeAt: TUE_3PM, autoResume: false },
    continued: { mode: 'continued', sessionId: 'session-moved', accountId: 'acct-2' },
  };
  return createMockSessionLimit(mode, {
    since: at(-MINUTE),
    resetsAt: TUE_3PM,
    plan: plans[mode],
    ...overrides,
  });
}

/** A config registering Acct 1..count. */
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
  limit: SessionLimit | null;
  accounts?: number;
  runtime?: string;
  accountId?: string;
  transport?: Partial<Transport>;
}

function transportFor({ accounts = 4, transport = {} }: Setup): Transport {
  return createMockTransport({
    getConfig: vi.fn().mockResolvedValue(configWith(accounts)),
    getModels: vi.fn().mockResolvedValue([
      { value: 'claude-opus-4-6', displayName: 'Opus', description: '' },
      { value: 'claude-sonnet-4-6', displayName: 'Sonnet', description: '' },
    ]),
    continueSession: vi.fn().mockResolvedValue({}),
    waitForReset: vi.fn().mockResolvedValue(undefined),
    cancelAutoContinue: vi.fn().mockResolvedValue(undefined),
    ...transport,
  });
}

function providers(transport: Transport, queryClient: QueryClient) {
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

function setSession(setup: Setup) {
  mockSessions = [
    createMockSession({
      id: SID,
      runtime: setup.runtime ?? 'claude-code',
      accountId: setup.accountId ?? 'acct-4',
      status: { lifecycle: 'idle', limit: setup.limit },
    } as Partial<Session>),
  ];
}

/** Render the banner over a session with `setup`'s limit; resolves once config and capabilities land. */
async function renderBanner(setup: Setup) {
  setSession(setup);
  const transport = transportFor(setup);
  const queryClient = createTestQueryClient();
  const onSend = vi.fn();
  const view = render(<AccountLimitBanner sessionId={SID} onSend={onSend} />, {
    wrapper: providers(transport, queryClient),
  });
  await waitFor(() => {
    expect(queryClient.getQueryData(['capabilities'])).toBeDefined();
    expect(transport.getConfig).toHaveBeenCalled();
  });
  return { transport, queryClient, onSend, view };
}

function bannerEl(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-slot="account-limit-banner"]');
  if (!el) throw new Error('no banner');
  return el;
}

/** The banner's buttons, in order. */
function buttons(): string[] {
  return within(bannerEl())
    .queryAllByRole('button')
    .map((button) => button.textContent ?? '');
}

describe('limited', () => {
  it('names the account and its reset, offers the picker then the wait, and posts wait {}', async () => {
    const { transport } = await renderBanner({ limit: limitOf('ask') });
    await waitFor(() =>
      expect(bannerEl()).toHaveTextContent('Acct 4 is out of usage until Tue 3pm.')
    );
    expect(buttons()).toEqual(['Continue on another account…', 'Wait for reset']);
    await userEvent.click(screen.getByRole('button', { name: 'Wait for reset' }));
    expect(transport.waitForReset).toHaveBeenCalledWith(SID, {});
  });

  it('opens the picker from "Continue on another account…"', async () => {
    const { transport } = await renderBanner({ limit: limitOf('ask') });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Continue on another account…' })
    );
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(transport.getContinueOptions).toHaveBeenCalledWith(SID);
    expect(transport.cancelAutoContinue).not.toHaveBeenCalled();
  });

  it('says "back in 47 min" for the 5-hour window, ticking each minute', async () => {
    await renderBanner({
      limit: limitOf('ask', { window: 'five_hour', resetsAt: at(47 * MINUTE) }),
    });
    await waitFor(() =>
      expect(bannerEl()).toHaveTextContent('Acct 4 is out of usage · back in 47 min.')
    );
    act(() => {
      vi.advanceTimersByTime(MINUTE);
    });
    expect(bannerEl()).toHaveTextContent('Acct 4 is out of usage · back in 46 min.');
  });

  it('says only "is out of usage." with no known reset', async () => {
    await renderBanner({ limit: limitOf('ask', { resetsAt: null }) });
    await waitFor(() => expect(bannerEl()).toHaveTextContent('Acct 4 is out of usage.'));
    expect(bannerEl()).not.toHaveTextContent(/until|back in/);
  });
});

describe('across the reset (the server only moves a waiting plan on)', () => {
  it('a limited 5-hour window stops counting once its reset passes', async () => {
    await renderBanner({
      limit: limitOf('ask', { window: 'five_hour', resetsAt: at(30_000) }),
    });
    await waitFor(() =>
      expect(bannerEl()).toHaveTextContent('Acct 4 is out of usage · back in 1 min.')
    );
    act(() => {
      vi.advanceTimersByTime(MINUTE);
    });
    expect(bannerEl()).toHaveTextContent('Acct 4 should have reset by now.');
    expect(bannerEl()).not.toHaveTextContent(/back in/);
  });

  it('a Codex wait past its reset says so, never "back in 1 min"', async () => {
    await renderBanner({
      runtime: 'codex',
      accountId: 'default',
      limit: limitOf('waiting', {
        accountId: 'default',
        state: 'waiting-reset',
        resetsAt: at(30_000),
        plan: { mode: 'waiting', resumeAt: at(30_000), autoResume: false, carryOver: false },
      }),
    });
    await waitFor(() => expect(bannerEl()).toHaveTextContent('Waiting for Codex · back in 1 min'));
    act(() => {
      vi.advanceTimersByTime(MINUTE);
    });
    expect(bannerEl()).toHaveTextContent('Codex should have reset by now.');
    expect(bannerEl()).not.toHaveTextContent(/back in/);
  });
});

describe('handing-off', () => {
  const handingOff = (overrides: Partial<SessionLimit> = {}) =>
    limitOf('auto', { state: 'handing-off', ...overrides });

  it('counts down to fireAt, says it once, and posts nothing at zero', async () => {
    const { transport } = await renderBanner({ limit: handingOff() });
    await waitFor(() => expect(bannerEl()).toHaveTextContent('Moving this task to Acct 2 in 10s…'));
    expect(buttons()).toEqual(['Move now', 'Choose account…', 'Wait for reset']);
    const spoken = screen.getByText('Moving this task to Acct 2 in 10 seconds.');
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(bannerEl()).toHaveTextContent('in 7s…');
    // The spoken sentence is set once per state, not once a second.
    expect(spoken).toHaveTextContent('Moving this task to Acct 2 in 10 seconds.');
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(bannerEl()).toHaveTextContent('Moving this task to Acct 2…');
    expect(bannerEl()).not.toHaveTextContent(/in \d+s/);
    expect(transport.continueSession).not.toHaveBeenCalled();
  });

  it('resumes from fireAt after a remount, not from 10', async () => {
    const { view } = await renderBanner({ limit: handingOff() });
    await waitFor(() => expect(bannerEl()).toHaveTextContent('in 10s…'));
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    view.unmount();
    await renderBanner({ limit: handingOff() });
    await waitFor(() => expect(bannerEl()).toHaveTextContent('in 6s…'));
  });

  it('Move now posts continue { account: target }', async () => {
    const { transport } = await renderBanner({ limit: handingOff() });
    await userEvent.click(await screen.findByRole('button', { name: 'Move now' }));
    expect(transport.continueSession).toHaveBeenCalledWith(SID, { account: 'acct-2' });
  });

  it('Wait posts wait {}', async () => {
    const { transport } = await renderBanner({ limit: handingOff() });
    await userEvent.click(await screen.findByRole('button', { name: 'Wait for reset' }));
    expect(transport.waitForReset).toHaveBeenCalledWith(SID, {});
  });

  it('after a flow run was told to move (fireAt passed), shows no digits and never posts again', async () => {
    const { transport } = await renderBanner({
      limit: handingOff({ plan: { mode: 'auto', target: 'acct-2', fireAt: at(-5000) } }),
    });
    await waitFor(() => expect(bannerEl()).toHaveTextContent('Moving this task to Acct 2…'));
    expect(bannerEl()).not.toHaveTextContent(/in \d+s/);
    expect(screen.getByRole('button', { name: 'Move now' })).toBeDisabled();
    expect(transport.continueSession).not.toHaveBeenCalled();
  });

  it('Choose account… stops the move before the options load', async () => {
    const order: string[] = [];
    const { transport } = await renderBanner({
      limit: handingOff(),
      transport: {
        cancelAutoContinue: vi.fn(async () => {
          order.push('cancel');
        }),
        getContinueOptions: vi.fn(async () => {
          order.push('options');
          return {
            plan: { mode: 'ask' as const },
            ranking: { accounts: [], recommendedId: null },
            advised: false,
          };
        }),
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Choose account…' }));
    await waitFor(() => expect(transport.getContinueOptions).toHaveBeenCalled());
    expect(order).toEqual(['cancel', 'options']);
  });

  it("Choose account… on a flow run shows flow's 503 inline", async () => {
    await renderBanner({
      limit: handingOff(),
      transport: {
        cancelAutoContinue: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error(FLOW_DOWN), { status: 503 })),
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Choose account…' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(FLOW_DOWN);
  });
});

describe('the picker belongs to its episode', () => {
  function streamLimit(limit: SessionLimit | null, seq: number) {
    act(() => {
      useSessionStreamStore
        .getState()
        .applyEvent(SID, { type: 'status_change', seq, status: { limit } } as never);
    });
  }

  it('closes when the limit moves on, and a new episode does not find it open', async () => {
    await renderBanner({ limit: limitOf('ask') });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Continue on another account…' })
    );
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    streamLimit(limitOf('continued', { state: 'moved' }), 1);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    streamLimit(limitOf('ask', { since: at(MINUTE) }), 2);
    await waitFor(() =>
      expect(bannerEl()).toHaveTextContent('Acct 4 is out of usage until Tue 3pm.')
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('stays open through its own cancel, when handing-off turns limited in the same episode', async () => {
    const handingOff = limitOf('auto', { state: 'handing-off' });
    const { transport } = await renderBanner({ limit: handingOff });
    await userEvent.click(await screen.findByRole('button', { name: 'Choose account…' }));
    await waitFor(() => expect(transport.cancelAutoContinue).toHaveBeenCalledTimes(1));
    // The server reports the cancelled move: same episode, now `limited`.
    streamLimit(limitOf('ask', { since: handingOff.since }), 1);
    await waitFor(() => expect(bannerEl()).toHaveAttribute('data-state', 'limited'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await waitFor(() => expect(transport.getContinueOptions).toHaveBeenCalledWith(SID));
    expect(transport.cancelAutoContinue).toHaveBeenCalledTimes(1);
  });

  it("never cancels the next episode's automatic move unasked", async () => {
    const { transport } = await renderBanner({ limit: limitOf('auto', { state: 'handing-off' }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Choose account…' }));
    await waitFor(() => expect(transport.cancelAutoContinue).toHaveBeenCalledTimes(1));
    streamLimit(null, 1);
    streamLimit(limitOf('auto', { state: 'handing-off', since: at(MINUTE) }), 2);
    await waitFor(() => expect(bannerEl()).toHaveTextContent('Moving this task to Acct 2'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(transport.cancelAutoContinue).toHaveBeenCalledTimes(1);
  });
});

describe('wait-only (invariant 5)', () => {
  it('a Codex session is named "Codex" and can only wait', async () => {
    const { transport } = await renderBanner({
      runtime: 'codex',
      accountId: 'default',
      limit: limitOf('ask', {
        accountId: 'default',
        state: 'wait-only',
        plan: { mode: 'ask', carryOver: false },
      }),
    });
    await waitFor(() =>
      expect(bannerEl()).toHaveTextContent('Codex is out of usage until Tue 3pm.')
    );
    expect(buttons()).toEqual(['Wait for reset']);
    await userEvent.click(screen.getByRole('button', { name: 'Wait for reset' }));
    expect(transport.waitForReset).toHaveBeenCalledWith(SID, {});
    expect(transport.getContinueOptions).not.toHaveBeenCalled();
  });

  it('a Claude chat that did not start here (a schedule) only waits, with 2+ accounts', async () => {
    // The server decides who may carry over (by the chat's origin too), and
    // says so with `carryOver: false`; the runtime alone never offers a move.
    const { transport } = await renderBanner({
      limit: limitOf('ask', { state: 'wait-only', plan: { mode: 'ask', carryOver: false } }),
    });
    await waitFor(() =>
      expect(bannerEl()).toHaveTextContent('Acct 4 is out of usage until Tue 3pm.')
    );
    expect(buttons()).toEqual(['Wait for reset']);
    expect(transport.getContinueOptions).not.toHaveBeenCalled();
  });

  it('never offers a move when the plan refuses one, whatever the state says', async () => {
    await renderBanner({
      limit: limitOf('ask', { state: 'limited', plan: { mode: 'ask', carryOver: false } }),
    });
    await waitFor(() => expect(buttons()).toEqual(['Wait for reset']));
  });

  it('a one-account Claude session is named "Claude"', async () => {
    await renderBanner({ accounts: 1, limit: limitOf('ask', { state: 'wait-only' }) });
    await waitFor(() =>
      expect(bannerEl()).toHaveTextContent('Claude is out of usage until Tue 3pm.')
    );
    expect(buttons()).toEqual(['Wait for reset']);
  });
});

describe('all-accounts-out', () => {
  it('names the soonest account back and offers only the wait', async () => {
    await renderBanner({
      limit: limitOf('ask', {
        state: 'all-accounts-out',
        allOut: { accountId: 'acct-2', resetsAt: at(5 * DAY + 21 * HOUR) },
      }),
    });
    await waitFor(() => expect(bannerEl()).toHaveTextContent('All accounts are out.'));
    expect(bannerEl()).toHaveTextContent('Soonest back: Acct 2, Sat 9am');
    expect(buttons()).toEqual(['Wait for reset']);
  });

  it('never shows a soonest time already past', async () => {
    await renderBanner({
      limit: limitOf('ask', {
        state: 'all-accounts-out',
        allOut: { accountId: 'acct-2', resetsAt: at(30_000) },
      }),
    });
    await waitFor(() => expect(bannerEl()).toHaveTextContent('Soonest back: Acct 2, 12pm'));
    act(() => {
      vi.advanceTimersByTime(MINUTE);
    });
    expect(bannerEl()).toHaveTextContent('All accounts are out. Acct 2 should have reset by now.');
    expect(bannerEl()).not.toHaveTextContent('Soonest back');
  });

  it('leaves out "Soonest back" when its reset is unknown', async () => {
    await renderBanner({
      limit: limitOf('ask', {
        state: 'all-accounts-out',
        allOut: { accountId: 'acct-2', resetsAt: null },
      }),
    });
    await waitFor(() => expect(bannerEl()).toHaveTextContent('All accounts are out.'));
    expect(bannerEl()).not.toHaveTextContent('Soonest back');
  });
});

describe('model-limited', () => {
  const modelLimited = (overrides: Partial<SessionLimit> = {}) =>
    limitOf('ask', {
      state: 'model-limited',
      scope: 'model',
      window: 'seven_day_opus',
      modelFallback: 'claude-sonnet-4-6',
      ...overrides,
    });

  /** The server's ranking with Acct 2 free to take the work, or with no one. */
  const ranking = (accounts: 'one' | 'none') => ({
    getContinueOptions: vi.fn().mockResolvedValue({
      plan: { mode: 'ask' },
      ranking: {
        accounts:
          accounts === 'one'
            ? [
                {
                  runtime: 'claude-code',
                  id: 'acct-2',
                  label: 'Acct 2',
                  color: '#2f7be0',
                  usage: { state: 'ok' },
                  eligible: true,
                  reason: 'Has usage left.',
                },
              ]
            : [],
        recommendedId: accounts === 'one' ? 'acct-2' : null,
      },
      advised: false,
    }),
  });

  it('names the model by its display name, and keeps going on the fallback', async () => {
    const { transport } = await renderBanner({
      limit: modelLimited(),
      transport: ranking('one') as Partial<Transport>,
    });
    await waitFor(() =>
      expect(bannerEl()).toHaveTextContent('Opus is out on Acct 4 for this week.')
    );
    await waitFor(() =>
      expect(buttons()).toEqual([
        'Keep going on Sonnet, same account',
        'Continue on another account…',
        'Wait for reset',
      ])
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Keep going on Sonnet, same account' })
    );
    expect(transport.continueSession).toHaveBeenCalledWith(SID, { model: 'claude-sonnet-4-6' });
  });

  it('offers no other account when the ranking has none that can take the work', async () => {
    const { transport } = await renderBanner({
      limit: modelLimited(),
      transport: ranking('none') as Partial<Transport>,
    });
    await waitFor(() => expect(transport.getContinueOptions).toHaveBeenCalledWith(SID));
    await waitFor(() =>
      expect(buttons()).toEqual(['Keep going on Sonnet, same account', 'Wait for reset'])
    );
  });

  it('offers no other account with the gate closed', async () => {
    await renderBanner({ accounts: 1, limit: modelLimited() });
    await waitFor(() =>
      expect(buttons()).toEqual(['Keep going on Sonnet, same account', 'Wait for reset'])
    );
  });

  it('offers no other account when the plan says carryOver: false', async () => {
    await renderBanner({ limit: modelLimited({ plan: { mode: 'ask', carryOver: false } }) });
    await waitFor(() =>
      expect(buttons()).toEqual(['Keep going on Sonnet, same account', 'Wait for reset'])
    );
  });
});

describe('waiting-reset', () => {
  const waiting = (plan: Partial<Extract<LimitPlan, { mode: 'waiting' }>> = {}) =>
    limitOf('waiting', {
      state: 'waiting-reset',
      plan: { mode: 'waiting', resumeAt: TUE_3PM, autoResume: false, ...plan },
    });

  it('counts to resumeAt in hours under a day, and ticks', async () => {
    await renderBanner({ limit: waiting({ resumeAt: at(HOUR + 12 * MINUTE) }) });
    await waitFor(() =>
      expect(bannerEl()).toHaveTextContent('Waiting for Acct 4 · back in 1h 12m')
    );
    act(() => {
      vi.advanceTimersByTime(MINUTE);
    });
    expect(bannerEl()).toHaveTextContent('Waiting for Acct 4 · back in 1h 11m');
  });

  it('says the day beyond a day', async () => {
    await renderBanner({ limit: waiting() });
    await waitFor(() => expect(bannerEl()).toHaveTextContent('Waiting for Acct 4 · back Tue 3pm'));
    expect(buttons()).toEqual([]);
  });

  it('binds the checkbox to the stored autoResume and posts wait { autoResume }', async () => {
    const { transport } = await renderBanner({ limit: waiting({ autoResume: false }) });
    const box = await screen.findByRole('checkbox', {
      name: 'Continue automatically when it resets',
    });
    expect(box).not.toBeChecked();
    await userEvent.click(box);
    expect(transport.waitForReset).toHaveBeenCalledWith(SID, { autoResume: true });
    // Only the stored plan checks it: nothing was stored, so it stays off.
    await waitFor(() => expect(box).not.toBeChecked());
  });

  it('shows the checkbox checked when the plan stored autoResume', async () => {
    await renderBanner({ limit: waiting({ autoResume: true }) });
    expect(
      await screen.findByRole('checkbox', { name: 'Continue automatically when it resets' })
    ).toBeChecked();
  });

  it('hides the checkbox for a session that can only wait (carryOver: false)', async () => {
    await renderBanner({ limit: waiting({ carryOver: false }) });
    await waitFor(() => expect(bannerEl()).toHaveTextContent('Waiting for Acct 4'));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('never promises a Codex wait will continue by itself', async () => {
    await renderBanner({
      runtime: 'codex',
      accountId: 'default',
      limit: limitOf('waiting', {
        accountId: 'default',
        state: 'waiting-reset',
        // What S4 stores for Codex, whatever the request asked for.
        plan: { mode: 'waiting', resumeAt: TUE_3PM, autoResume: false, carryOver: false },
      }),
    });
    await waitFor(() => expect(bannerEl()).toHaveTextContent('Waiting for Codex · back Tue 3pm'));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(bannerEl()).not.toHaveTextContent(/automatically|by itself/i);
  });
});

describe('reset-ready', () => {
  const ready = (plan: Partial<Extract<LimitPlan, { mode: 'waiting' }>> = {}) =>
    limitOf('waiting', {
      state: 'reset-ready',
      plan: { mode: 'waiting', resumeAt: at(-MINUTE), autoResume: false, ...plan },
    });

  it('says the account has reset, and Continue sends the resume message', async () => {
    const { onSend, transport } = await renderBanner({ limit: ready() });
    await waitFor(() => expect(bannerEl()).toHaveTextContent('Acct 4 has reset.'));
    expect(buttons()).toEqual(['Continue']);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onSend).toHaveBeenCalledWith(ACCOUNT_RESUME_PROMPT);
    expect(transport.continueSession).not.toHaveBeenCalled();
  });

  it('says "should have reset by now" when the reset could not be confirmed', async () => {
    await renderBanner({ limit: ready({ unconfirmed: true }) });
    await waitFor(() => expect(bannerEl()).toHaveTextContent('Acct 4 should have reset by now.'));
  });
});

describe('moved', () => {
  const moved = (overrides: Partial<SessionLimit> = {}) =>
    limitOf('continued', { state: 'moved', ...overrides });

  it('names where it went, and "Open it →" opens that session', async () => {
    await renderBanner({ limit: moved() });
    await waitFor(() => expect(bannerEl()).toHaveTextContent('This task continued on Acct 2.'));
    expect(buttons()).toEqual(['Open it →', 'Continue here anyway']);
    await userEvent.click(screen.getByRole('button', { name: 'Open it →' }));
    expect(mockSetSessionId).toHaveBeenCalledWith('session-moved');
  });
});

describe('tone (Q13) and role', () => {
  const cases: [string, 'critical' | 'neutral', SessionLimit][] = [
    ['limited', 'critical', limitOf('ask')],
    ['handing-off', 'critical', limitOf('auto', { state: 'handing-off' })],
    ['wait-only', 'critical', limitOf('ask', { state: 'wait-only' })],
    [
      'all-accounts-out',
      'critical',
      limitOf('ask', {
        state: 'all-accounts-out',
        allOut: { accountId: 'acct-2', resetsAt: null },
      }),
    ],
    [
      'model-limited',
      'critical',
      limitOf('ask', { state: 'model-limited', scope: 'model', window: 'seven_day_opus' }),
    ],
    ['waiting-reset', 'neutral', limitOf('waiting', { state: 'waiting-reset' })],
    ['reset-ready', 'neutral', limitOf('waiting', { state: 'reset-ready' })],
    ['moved', 'neutral', limitOf('continued', { state: 'moved' })],
  ];

  it.each(cases)(
    '%s is %s, announced politely, and asks for no usage',
    async (_, variant, limit) => {
      const { transport } = await renderBanner({ limit });
      await waitFor(() => expect(bannerEl()).toHaveAttribute('data-variant', variant));
      expect(bannerEl()).toHaveAttribute('role', 'status');
      expect(transport.getAccountUsage).not.toHaveBeenCalled();
    }
  );

  it('renders nothing without a limit (near-limit is the chip alone)', async () => {
    await renderBanner({ limit: null });
    expect(document.querySelector('[data-slot="account-limit-banner"]')).toBeNull();
  });
});

describe('flow unreachable (Q1)', () => {
  const refused = () =>
    vi.fn().mockRejectedValue(Object.assign(new Error(FLOW_DOWN), { status: 503 }));

  it('a refused wait shows inline and the banner keeps its state', async () => {
    await renderBanner({
      limit: limitOf('auto', { state: 'handing-off' }),
      transport: { waitForReset: refused() },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Wait for reset' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(FLOW_DOWN);
    expect(bannerEl()).toHaveAttribute('data-state', 'handing-off');
  });

  it('a refusal with no message of its own says so plainly', async () => {
    await renderBanner({
      limit: limitOf('ask'),
      transport: { waitForReset: vi.fn().mockRejectedValue(new Error('')) },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Wait for reset' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't do that. Try again.");
  });

  it('a refused Move now shows inline too, and nothing is retried', async () => {
    const continueSession = refused();
    await renderBanner({
      limit: limitOf('auto', { state: 'handing-off' }),
      transport: { continueSession },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Move now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(FLOW_DOWN);
    expect(continueSession).toHaveBeenCalledTimes(1);
  });
});

describe('the limit clears', () => {
  it('reads the history again, so the marker can replace the banner', async () => {
    const { queryClient } = await renderBanner({
      limit: limitOf('waiting', { state: 'reset-ready' }),
    });
    await waitFor(() => expect(bannerEl()).toBeInTheDocument());
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    act(() => {
      useSessionStreamStore
        .getState()
        .applyEvent(SID, { type: 'status_change', seq: 1, status: { limit: null } } as never);
    });
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: accountKeys.limitHistory(SID) })
    );
    expect(document.querySelector('[data-slot="account-limit-banner"]')).toBeNull();
  });
});

describe('the composer', () => {
  function composerFor(limit: SessionLimit | null, accounts = 4) {
    setSession({ limit });
    const transport = transportFor({ limit, accounts });
    return renderHook(() => useLimitComposer(SID), {
      wrapper: providers(transport, createTestQueryClient()),
    });
  }

  it.each([
    ['limited', limitOf('ask'), PAUSED_TEXT],
    ['handing-off', limitOf('auto', { state: 'handing-off' }), PAUSED_MOVING_TEXT],
    ['wait-only', limitOf('ask', { state: 'wait-only' }), PAUSED_TEXT],
    ['all-accounts-out', limitOf('ask', { state: 'all-accounts-out' }), PAUSED_TEXT],
    ['model-limited', limitOf('ask', { state: 'model-limited', scope: 'model' }), PAUSED_TEXT],
    ['waiting-reset', limitOf('waiting', { state: 'waiting-reset' }), PAUSED_TEXT],
  ])('pauses in %s', async (_, limit, text) => {
    const { result } = composerFor(limit);
    await waitFor(() => expect(result.current).toEqual({ canSubmit: false, placeholder: text }));
  });

  it('opens once the reset passes, though the server leaves the state as it is', async () => {
    const { result } = composerFor(limitOf('ask', { window: 'five_hour', resetsAt: at(30_000) }));
    await waitFor(() => expect(result.current.canSubmit).toBe(false));
    act(() => {
      vi.advanceTimersByTime(MINUTE);
    });
    expect(result.current).toEqual({ canSubmit: true, placeholder: null });
  });

  it('is open when the reset is ready', async () => {
    const { result } = composerFor(limitOf('waiting', { state: 'reset-ready' }));
    await waitFor(() => expect(result.current).toEqual({ canSubmit: true, placeholder: null }));
  });

  it('never pauses a limit with no known reset', async () => {
    const { result } = composerFor(limitOf('ask', { resetsAt: null }));
    await waitFor(() => expect(result.current).toEqual({ canSubmit: true, placeholder: null }));
  });

  it('after a move, is shut until "Continue here anyway", for this episode only', async () => {
    const first = limitOf('continued', { state: 'moved', since: at(-2 * MINUTE) });
    await renderBanner({ limit: first });
    const hook = composerFor(first);
    await waitFor(() => expect(hook.result.current.canSubmit).toBe(false));
    await userEvent.click(await screen.findByRole('button', { name: 'Continue here anyway' }));
    await waitFor(() => expect(hook.result.current.canSubmit).toBe(true));
    // The choice is kept for this episode across a remount.
    hook.unmount();
    expect(composerFor(first).result.current.canSubmit).toBe(true);
    // A new limit (a new `since`) asks again.
    const second = limitOf('continued', { state: 'moved', since: at(MINUTE) });
    expect(composerFor(second).result.current.canSubmit).toBe(false);
  });
});
