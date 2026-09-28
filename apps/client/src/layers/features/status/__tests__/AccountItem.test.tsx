/**
 * @vitest-environment jsdom
 *
 * The status-bar account chip and its popover (spec `claude-account-ui` §6.1,
 * §10, §12 Chip row).
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import {
  createMockAccountUsage,
  createMockSessionLimit,
  createMockTransport,
} from '@dorkos/test-utils';
import { createTestQueryClient } from '@dorkos/test-utils/react-helpers';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import type { LimitState, SessionLimitView } from '@/layers/shared/lib';
import type { SessionAccount } from '../model/use-session-account';
import { AccountItem } from '../ui/AccountItem';

vi.mock('@/layers/shared/model/media/use-is-mobile', () => ({ useIsMobile: () => false }));

beforeAll(() => {
  // Radix popper measures with ResizeObserver, which jsdom lacks.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Sunday 27 Sep 2026, 12:13 local time: every reset below is local too. */
const NOW = new Date('2026-09-27T12:13:00');
/** Tuesday 29 Sep, 3pm local. */
const TUE_3PM = '2026-09-29T15:00:00';
/** 47 minutes after {@link NOW}. */
const IN_47_MIN = '2026-09-27T13:00:00';

type Window = AccountUsage['windows'][number];

function win(key: string, label: string, usedPct: number | null, resetsAt: string | null): Window {
  return {
    key,
    label,
    usedPct,
    resetsAt,
    status: 'allowed',
    expired: false,
    observedAt: '2026-09-27T12:00:00',
    source: 'sdk_event',
  };
}

/** Acct 2 on the Max plan: 5-hour 40% resetting 2:10pm, weekly 72% resetting Thursday 9am. */
function usage(overrides: Partial<AccountUsage> = {}): AccountUsage {
  return createMockAccountUsage({
    windows: [
      win('five_hour', '5-hour window', 40, '2026-09-27T14:10:00'),
      win('seven_day', 'Weekly', 72, '2026-10-01T09:00:00'),
    ],
    ...overrides,
  });
}

/** A limit whose server sends `state` and `scope` (S4 5.1). */
function limitIn(state: LimitState, overrides: Partial<SessionLimitView> = {}): SessionLimitView {
  return {
    ...createMockSessionLimit('ask'),
    resetsAt: TUE_3PM,
    state,
    scope: 'account',
    ...overrides,
  };
}

/** A started Claude session on Acct 2, gate open, reading ok. */
function account(overrides: Partial<SessionAccount> = {}): SessionAccount {
  return {
    visible: true,
    runtime: 'claude-code',
    accountId: 'acct-2',
    path: '/Users/test/.claude-acct-2',
    name: 'Acct 2',
    color: '#1d8a4a',
    usage: usage(),
    limit: null,
    chipState: 'ok',
    trackerItem: null,
    lifecycle: 'idle',
    pending: false,
    ...overrides,
  };
}

function Providers({ children }: { children: ReactNode }) {
  const transport = createMockTransport({
    getModels: vi.fn().mockResolvedValue([
      { value: 'claude-opus-4-8', displayName: 'Opus 4.8', description: '' },
      { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: '' },
    ]),
  });
  return (
    <QueryClientProvider client={createTestQueryClient()}>
      <TransportProvider transport={transport}>
        <TooltipProvider>{children}</TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

function renderChip(
  props: Partial<Parameters<typeof AccountItem>[0]> & { account: SessionAccount }
) {
  return render(
    <Providers>
      <AccountItem sessionId="session-1" now={NOW} {...props} />
    </Providers>
  );
}

/** The chip: the one button that opens the account popover. */
function chip() {
  return screen.getByRole('button', { name: /^Acct/ });
}

describe('AccountItem — the chip', () => {
  it('ok: the name and two usage bars, both in the accessible name', () => {
    renderChip({ account: account() });
    expect(chip()).toHaveAccessibleName('Acct 2, 5-hour window 40% used, weekly 72% used');
    expect(chip()).toHaveTextContent('Acct 2');
    expect(
      within(chip()).getByRole('img', { name: '5-hour window 40% used, weekly 72% used' })
    ).toBeInTheDocument();
    expect(chip()).toHaveAttribute('data-state-tone', 'neutral');
  });

  it('unknown: unknown bars, never an empty 0%', () => {
    renderChip({ account: account({ usage: null, chipState: 'unknown' }) });
    expect(chip()).toHaveAccessibleName(
      'Acct 2, 5-hour window usage unknown, weekly usage unknown'
    );
    expect(chip()).not.toHaveTextContent('0%');
  });

  it('near on the week: the words replace the bars, amber', () => {
    renderChip({
      account: account({
        name: 'Acct 3',
        chipState: 'near',
        usage: usage({
          state: 'warning',
          windows: [
            win('five_hour', '5-hour window', 35, null),
            win('seven_day', 'Weekly', 91, null),
          ],
        }),
      }),
    });
    expect(chip()).toHaveTextContent('Acct 3· 91% of week');
    expect(chip()).toHaveAccessibleName('Acct 3, 91% of week');
    expect(within(chip()).queryByRole('img', { name: /5-hour window/ })).not.toBeInTheDocument();
    expect(chip()).toHaveAttribute('data-state-tone', 'warning');
  });

  it('near on the 5-hour window', () => {
    renderChip({
      account: account({
        chipState: 'near',
        usage: usage({
          state: 'warning',
          windows: [
            win('five_hour', '5-hour window', 93, null),
            win('seven_day', 'Weekly', 50, null),
          ],
        }),
      }),
    });
    expect(chip()).toHaveAccessibleName('Acct 2, 93% of 5h');
  });

  it('out on a 7-day window: out until the reset, red', () => {
    renderChip({
      account: account({ name: 'Acct 4', chipState: 'out', limit: limitIn('limited') }),
    });
    expect(chip()).toHaveAccessibleName('Acct 4, out until Tue 3pm');
    expect(chip()).toHaveAttribute('data-state-tone', 'error');
  });

  it('out on the 5-hour window counts down, and ticks once a minute', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] });
    render(
      <Providers>
        <AccountItem
          sessionId="session-1"
          account={account({
            name: 'Acct 4',
            chipState: 'out',
            limit: limitIn('limited', { window: 'five_hour', resetsAt: IN_47_MIN }),
          })}
        />
      </Providers>
    );
    expect(chip()).toHaveAccessibleName('Acct 4, back in 47 min');

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(chip()).toHaveAccessibleName('Acct 4, back in 46 min');
  });

  it('out with no reset time says only out', () => {
    renderChip({
      account: account({
        name: 'Acct 4',
        chipState: 'out',
        limit: limitIn('limited', { resetsAt: null }),
      }),
    });
    expect(chip()).toHaveAccessibleName('Acct 4, out');
  });

  it.each(['model-limited', 'waiting-reset'] as const)(
    'model-out (%s): names the model, amber, because the account is not out',
    (state) => {
      renderChip({
        account: account({
          name: 'Acct 3',
          chipState: 'model-out',
          limit: limitIn(state, { scope: 'model', window: 'seven_day_opus' }),
        }),
      });
      expect(chip()).toHaveAccessibleName('Acct 3, Opus out until Tue 3pm');
      expect(chip()).toHaveAttribute('data-state-tone', 'warning');
    }
  );

  it('opens a dialog: aria-haspopup and aria-expanded', async () => {
    const user = userEvent.setup();
    renderChip({ account: account() });
    expect(chip()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(chip()).toHaveAttribute('aria-expanded', 'false');
    await user.click(chip());
    expect(chip()).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders nothing for an account it cannot name, rather than inventing a label', () => {
    renderChip({ account: account({ name: null, accountId: null, path: null }) });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders nothing while the identity gate is closed', () => {
    renderChip({ account: account({ visible: false }) });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('AccountPopover', () => {
  async function openPopover(
    props: Partial<Parameters<typeof AccountItem>[0]> & { account: SessionAccount }
  ) {
    const user = userEvent.setup();
    renderChip(props);
    await user.click(chip());
    return { user, dialog: await screen.findByRole('dialog') };
  }

  it('shows the account, its plan, and a bar per window with local reset times', async () => {
    const { dialog } = await openPopover({ account: account() });
    expect(within(dialog).getByText('Max plan')).toBeInTheDocument();
    expect(
      within(dialog).getByRole('img', { name: '5-hour 40% used, resets 2:10pm' })
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('img', { name: 'This week 72% used, resets Thu 9am' })
    ).toBeInTheDocument();
    expect(within(dialog).getByText('40% · resets 2:10pm')).toBeInTheDocument();
  });

  it('keeps the server’s label for any other window', async () => {
    const withOpus = usage({
      windows: [
        win('five_hour', '5-hour window', 20, null),
        win('seven_day', 'Weekly', 45, null),
        win('seven_day_opus', 'Weekly Opus', 60, null),
      ],
    });
    const { dialog } = await openPopover({ account: account({ usage: withOpus }) });
    const names = within(dialog)
      .getAllByRole('img')
      .map((el) => el.getAttribute('aria-label'))
      .filter((name) => name?.includes('used'));
    expect(names).toEqual(['5-hour 20% used', 'This week 45% used', 'Weekly Opus 60% used']);
  });

  it('leaves the plan out when no source reported one', async () => {
    const { dialog } = await openPopover({
      account: account({ usage: usage({ plan: null, subscriptionType: null }) }),
    });
    expect(within(dialog).queryByText(/plan$/)).not.toBeInTheDocument();
  });

  it('names the flow item only when the session serves one', async () => {
    const { dialog } = await openPopover({
      account: account({ trackerItem: { id: 'DOR-2353', stage: 'execute' } }),
    });
    expect(within(dialog).getByText('Working on DOR-2353')).toBeInTheDocument();
    expect(within(dialog).queryByText(/started on this account/)).not.toBeInTheDocument();
    cleanup();

    const again = await openPopover({ account: account() });
    expect(within(again.dialog).queryByText(/Working on/)).not.toBeInTheDocument();
  });

  it.each(['limited', 'handing-off', 'model-limited'] as const)(
    'offers to continue on another account while the limit is %s',
    async (state) => {
      const onContinue = vi.fn();
      const { user, dialog } = await openPopover({
        account: account({ chipState: 'out', limit: limitIn(state) }),
        onContinue,
      });
      await user.click(
        within(dialog).getByRole('button', { name: 'Continue on another account →' })
      );
      expect(onContinue).toHaveBeenCalledOnce();
    }
  );

  it.each([
    ['a healthy session', {}],
    ['wait-only', { chipState: 'out', limit: limitIn('wait-only') }],
    ['all-accounts-out', { chipState: 'out', limit: limitIn('all-accounts-out') }],
    ['moved', { limit: limitIn('moved') }],
    ['waiting-reset', { chipState: 'out', limit: limitIn('waiting-reset') }],
    ['reset-ready', { chipState: 'out', limit: limitIn('reset-ready') }],
    [
      'a plan that cannot carry over',
      {
        chipState: 'out',
        limit: limitIn('limited', {
          plan: { mode: 'ask', carryOver: false } as SessionLimitView['plan'],
        }),
      },
    ],
    ['a live turn', { chipState: 'out', limit: limitIn('limited'), lifecycle: 'streaming' }],
  ] as const)('does not offer it for %s', async (_name, overrides) => {
    const { dialog } = await openPopover({
      account: account(overrides as Partial<SessionAccount>),
      onContinue: vi.fn(),
    });
    expect(
      within(dialog).queryByRole('button', { name: /Continue on another account/ })
    ).not.toBeInTheDocument();
  });

  it('does not offer it without a picker to open', async () => {
    const { dialog } = await openPopover({
      account: account({ chipState: 'out', limit: limitIn('limited') }),
    });
    expect(
      within(dialog).queryByRole('button', { name: /Continue on another account/ })
    ).not.toBeInTheDocument();
  });

  it('closes on Escape and gives focus back to the chip', async () => {
    const { user } = await openPopover({ account: account() });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(chip()).toHaveFocus();
  });
});
