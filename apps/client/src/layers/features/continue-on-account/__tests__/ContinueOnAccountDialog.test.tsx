/**
 * @vitest-environment jsdom
 *
 * The "Continue on another account" picker (spec `claude-account-ui` §6.6),
 * driven entirely by what `getContinueOptions` answers: without an advisor,
 * with one, and the rules both share. The server decides order, eligibility
 * and the recommended account; these tests prove the picker only displays
 * them (invariant 6).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type {
  AccountUsage,
  ContinueOptionAccount,
  ContinueOptionsResponse,
} from '@dorkos/shared/account-usage';
import type { ServerConfig } from '@dorkos/shared/types';
import type { Transport } from '@dorkos/shared/transport';
import {
  createMockAccountUsage,
  createMockSessionLimit,
  createMockTransport,
} from '@dorkos/test-utils';
import { createTestQueryClient } from '@dorkos/test-utils/react-helpers';
import { QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';

const mockSetSessionId = vi.fn();
vi.mock('@/layers/entities/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useSessionId: () => [null, mockSetSessionId],
}));
vi.mock('@/layers/shared/model/media/use-is-mobile', () => ({ useIsMobile: () => false }));

import { ContinueOnAccountDialog } from '../ui/ContinueOnAccountDialog';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const DAY_MS = 24 * 60 * 60 * 1000;
/** A Sunday noon in local time, so "resets <day>" is the same on every machine. */
const NOW = new Date(2026, 8, 27, 12, 0, 0);
const SID = 'session-limited';

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true });
  mockSetSessionId.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Usage for account `n` with `usedPct` of its week used, resetting `days` from now. */
function usage(n: number, usedPct: number | null, days = 3, extra: Partial<AccountUsage> = {}) {
  const base = createMockAccountUsage({
    accountId: `acct-${n}`,
    path: `/Users/test/.claude-acct-${n}`,
    label: `Acct ${n}`,
  });
  return {
    ...base,
    windows: [
      {
        ...base.windows[1]!,
        usedPct,
        resetsAt: new Date(NOW.getTime() + days * DAY_MS).toISOString(),
      },
    ],
    ...extra,
  };
}

/** One ranked row for account `n`. */
function row(
  n: number,
  usedPct: number | null,
  extra: Partial<ContinueOptionAccount> = {}
): ContinueOptionAccount {
  return {
    id: `acct-${n}`,
    label: `Acct ${n}`,
    color: '#2f7be0',
    usage: usage(n, usedPct),
    eligible: true,
    reason: 'Has usage left.',
    runtime: 'claude-code',
    ...extra,
  };
}

/** An account that is out of usage until Tuesday. */
function outRow(n: number): ContinueOptionAccount {
  return row(n, 100, {
    eligible: false,
    reason: 'Out until Tue 3pm',
    usage: usage(n, 100, 2, { state: 'limited' }),
  });
}

function options(
  accounts: ContinueOptionAccount[],
  extra: Partial<ContinueOptionsResponse> = {}
): ContinueOptionsResponse {
  return {
    plan: { mode: 'ask' },
    ranking: { accounts, recommendedId: accounts[0]?.id ?? null },
    advised: false,
    ...extra,
  };
}

/** A config registering Acct 1..count; Acct 1 is the session's own account. */
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

interface RenderOptions {
  answer: ContinueOptionsResponse;
  registered?: number;
  runtime?: string;
  trackerItem?: { id: string } | null;
  accountId?: string | null;
  limitAccountId?: string | null;
  cancelAutoFirst?: boolean;
  overrides?: Partial<Transport>;
}

function renderDialog({
  answer,
  registered = 3,
  runtime = 'claude-code',
  trackerItem = null,
  accountId = 'acct-1',
  limitAccountId = null,
  cancelAutoFirst = false,
  overrides = {},
}: RenderOptions) {
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue(configWith(registered)),
    getContinueOptions: vi.fn().mockResolvedValue(answer),
    ...overrides,
  });
  const onOpenChange = vi.fn();
  const queryClient = createTestQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <ContinueOnAccountDialog
            open
            onOpenChange={onOpenChange}
            sessionId={SID}
            account={{
              runtime,
              accountId,
              trackerItem,
              limit: limitAccountId
                ? createMockSessionLimit('ask', { accountId: limitAccountId })
                : null,
            }}
            cancelAutoFirst={cancelAutoFirst}
            now={NOW}
          />
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  return { transport, onOpenChange, queryClient };
}

const dialog = () => screen.getByRole('dialog');
const radios = async () => {
  await screen.findAllByRole('radio');
  return screen.getAllByRole('radio');
};
const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

describe('without an advisor', () => {
  const answer = options([row(3, 20), row(2, 72), outRow(4), row(5, null)], {
    ranking: {
      accounts: [row(3, 20), row(2, 72), outRow(4), row(5, null)],
      recommendedId: 'acct-2',
    },
  });

  it('keeps the server order and shows each account state in words', async () => {
    renderDialog({ answer });
    const list = await radios();
    expect(list.map((radio) => radio.closest('label')?.textContent)).toEqual([
      'Acct 380% left · resets Wed',
      'Acct 228% left · resets Wed',
      'Acct 4Out until Tue 3pm',
      'Acct 5usage unknown',
    ]);
  });

  it('shows no recommended pill and names no kept-out account', async () => {
    renderDialog({ answer, registered: 6 });
    await radios();
    expect(within(dialog()).queryByText(/recommended/i)).not.toBeInTheDocument();
    expect(within(dialog()).queryByText(/kept out/)).not.toBeInTheDocument();
  });

  it('says how the list is sorted and what carries over', async () => {
    renderDialog({ answer });
    await radios();
    expect(
      screen.getByText(
        'Starts a new chat in the same folder, with a summary of this one. Sorted by most usage left.'
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText('Carries over: the folder and a summary of this chat')
    ).toBeInTheDocument();
    expect(screen.getByText("Doesn't: the chat itself")).toBeInTheDocument();
  });

  it('selects the recommended account on open, not the first', async () => {
    renderDialog({ answer });
    await radios();
    expect(screen.getByRole('radio', { name: /Acct 2/ })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Continue on Acct 2' })).toBeEnabled();
  });

  it('disables an account that is out, with its reason', async () => {
    renderDialog({ answer });
    await radios();
    const out = screen.getByRole('radio', { name: /Acct 4/ });
    expect(out).toBeDisabled();
    expect(out).toHaveAccessibleName(/Out until Tue 3pm/);
  });
});

describe('with an advisor', () => {
  const reserved = row(1, 50, {
    id: 'acct-5',
    label: 'Main',
    eligible: false,
    reason: 'kept in reserve (50%)',
    badge: 'reserved',
  });
  const advised = (accounts: ContinueOptionAccount[], recommendedId = 'acct-2') =>
    options(accounts, { advised: true, ranking: { accounts, recommendedId } });

  it('puts the recommended pill on the recommended row only', async () => {
    renderDialog({
      answer: advised([row(2, 72, { badge: 'recommended' }), row(3, 91), outRow(4)]),
    });
    await radios();
    expect(screen.getByRole('radio', { name: /Acct 2/ })).toHaveAccessibleName(/recommended/);
    expect(screen.getByRole('radio', { name: /Acct 3/ })).not.toHaveAccessibleName(/recommended/);
    expect(screen.getByRole('radio', { name: /Acct 4/ })).toBeDisabled();
  });

  it('dims a reserved account with its reason and still lets you pick it (Q2)', async () => {
    const { transport } = renderDialog({
      answer: advised([row(2, 72, { badge: 'recommended' }), reserved]),
    });
    await radios();
    const main = screen.getByRole('radio', { name: /Main/ });
    expect(main).toBeEnabled();
    expect(main).toHaveAccessibleName(/kept in reserve \(50%\)/);
    expect(main.closest('[data-slot="continue-account-row"]')).toHaveAttribute(
      'data-eligible',
      'false'
    );
    await user().click(main);
    expect(main).toBeChecked();
    await user().click(screen.getByRole('button', { name: 'Continue on Main' }));
    await waitFor(() =>
      expect(transport.continueSession).toHaveBeenCalledWith(SID, { account: 'acct-5' })
    );
  });

  it('names one account the advisor kept out', async () => {
    // Registered: Acct 1 (the session's own), 2 and 3; the advisor listed only Acct 2.
    renderDialog({ answer: advised([row(2, 72)]), registered: 3 });
    await radios();
    expect(screen.getByText("Acct 3 is kept out, so it isn't listed.")).toBeInTheDocument();
  });

  it('names two accounts the advisor kept out in one line', async () => {
    renderDialog({ answer: advised([row(2, 72)]), registered: 4 });
    await radios();
    expect(
      screen.getByText("Acct 3 and Acct 4 are kept out, so they aren't listed.")
    ).toBeInTheDocument();
  });

  it('uses the flow wording only for a flow run (advised and a tracker item)', async () => {
    renderDialog({ answer: advised([row(2, 72)]), trackerItem: { id: 'DOR-2353' } });
    await radios();
    expect(
      screen.getByText("Picks up in the same folder and branch from flow's checkpoint.")
    ).toBeInTheDocument();
    expect(screen.getByText('Carries over: files, branch, checkpoint, task')).toBeInTheDocument();
  });

  it('drops "Sorted by most usage left." when advised without a tracker item', async () => {
    renderDialog({ answer: advised([row(2, 72)]) });
    await radios();
    expect(
      screen.getByText('Starts a new chat in the same folder, with a summary of this one.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/Sorted by most usage left/)).not.toBeInTheDocument();
    expect(screen.queryByText(/checkpoint/)).not.toBeInTheDocument();
  });

  it('shows no "Other runtimes" heading when every row is this runtime', async () => {
    renderDialog({ answer: advised([row(2, 72)]) });
    await radios();
    expect(screen.queryByText('Other runtimes')).not.toBeInTheDocument();
  });

  it("names another runtime's unnamed account by its runtime, never its id", async () => {
    const codex = row(9, 30, { id: 'work-codex', label: null, runtime: 'codex' });
    renderDialog({ answer: advised([row(2, 72), codex]) });
    await radios();
    const radio = screen.getByRole('radio', { name: /^Codex/ });
    expect(radio).not.toHaveAccessibleName(/work-codex/);
  });

  it("falls back to the limit's account to leave the session's own out of the kept-out line", async () => {
    renderDialog({ answer: advised([row(2, 72)]), accountId: null, limitAccountId: 'acct-1' });
    await radios();
    expect(screen.getByText("Acct 3 is kept out, so it isn't listed.")).toBeInTheDocument();
  });

  it("shows no kept-out line when the session's own account is unknown", async () => {
    renderDialog({ answer: advised([row(2, 72)]), accountId: null, limitAccountId: null });
    await radios();
    expect(screen.queryByText(/kept out/)).not.toBeInTheDocument();
  });

  it('groups another runtime under "Other runtimes" and posts its runtime', async () => {
    const codex = row(9, 30, { id: 'default', label: null, runtime: 'codex' });
    const { transport } = renderDialog({ answer: advised([row(2, 72), codex]) });
    await radios();
    expect(screen.getByText('Other runtimes')).toBeInTheDocument();
    const codexRadio = screen.getByRole('radio', { name: /Codex \(this computer's sign-in\)/ });
    await user().click(codexRadio);
    await user().click(
      screen.getByRole('button', { name: "Continue on Codex (this computer's sign-in)" })
    );
    await waitFor(() =>
      expect(transport.continueSession).toHaveBeenCalledWith(SID, {
        account: 'default',
        runtime: 'codex',
      })
    );
  });
});

describe('with or without an advisor', () => {
  const answer = options([row(2, 72), row(3, 20)]);

  it('names the selected account on the button', async () => {
    renderDialog({ answer });
    await radios();
    expect(screen.getByRole('button', { name: 'Continue on Acct 2' })).toBeInTheDocument();
    await user().click(screen.getByRole('radio', { name: /Acct 3/ }));
    expect(screen.getByRole('button', { name: 'Continue on Acct 3' })).toBeInTheDocument();
  });

  it('posts the account, closes, and opens the new session', async () => {
    const { transport, onOpenChange } = renderDialog({ answer });
    await radios();
    await user().click(screen.getByRole('button', { name: 'Continue on Acct 2' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(transport.continueSession).toHaveBeenCalledWith(SID, { account: 'acct-2' });
    expect(mockSetSessionId).toHaveBeenCalledWith('session-continued');
  });

  it('closes without navigating when flow takes the move (202 with no session)', async () => {
    const { onOpenChange } = renderDialog({
      answer,
      overrides: { continueSession: vi.fn().mockResolvedValue({}) },
    });
    await radios();
    await user().click(screen.getByRole('button', { name: 'Continue on Acct 2' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(mockSetSessionId).not.toHaveBeenCalled();
  });

  it('shows a 503 inline, stays open, and asks once', async () => {
    const refusal = Object.assign(
      new Error('Flow could not be reached, so this was not changed.'),
      {
        status: 503,
      }
    );
    const { transport, onOpenChange } = renderDialog({
      answer,
      overrides: { continueSession: vi.fn().mockRejectedValue(refusal) },
    });
    await radios();
    await user().click(screen.getByRole('button', { name: 'Continue on Acct 2' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Flow could not be reached, so this was not changed.'
    );
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(transport.continueSession).toHaveBeenCalledTimes(1);
    expect(mockSetSessionId).not.toHaveBeenCalled();
  });

  it("shows a 409 in the server's words and stays open", async () => {
    const refusal = Object.assign(
      new Error('This conversation did not start here, so it can only wait for the reset.'),
      { status: 409 }
    );
    const { onOpenChange } = renderDialog({
      answer,
      overrides: { continueSession: vi.fn().mockRejectedValue(refusal) },
    });
    await radios();
    await user().click(screen.getByRole('button', { name: 'Continue on Acct 2' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This conversation did not start here, so it can only wait for the reset.'
    );
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('says nothing can take the work when no row can be picked', async () => {
    const { transport } = renderDialog({ answer: options([outRow(2), outRow(3)]) });
    expect(
      await screen.findByText('No other account can take this work right now.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await user().click(screen.getByRole('button', { name: 'Continue' }));
    expect(transport.continueSession).not.toHaveBeenCalled();
  });

  it('will not post an account that ran out after it was picked', async () => {
    const { transport, queryClient } = renderDialog({
      answer,
      overrides: {
        getContinueOptions: vi
          .fn()
          .mockResolvedValueOnce(answer)
          .mockResolvedValue(options([outRow(3), row(2, 72)])),
      },
    });
    await radios();
    await user().click(screen.getByRole('radio', { name: /Acct 3/ }));
    await queryClient.invalidateQueries();
    await waitFor(() => expect(screen.getByRole('radio', { name: /Acct 3/ })).toBeDisabled());
    const primary = screen.getByRole('button', { name: /^Continue/ });
    expect(primary).toBeDisabled();
    await user().click(primary);
    expect(transport.continueSession).not.toHaveBeenCalled();
  });

  it('moves between accounts with the arrow keys', async () => {
    renderDialog({ answer });
    await radios();
    screen.getByRole('radio', { name: /Acct 2/ }).focus();
    await user().keyboard('{ArrowDown}');
    expect(screen.getByRole('radio', { name: /Acct 3/ })).toHaveFocus();
    await user().keyboard('{ArrowUp}');
    expect(screen.getByRole('radio', { name: /Acct 2/ })).toHaveFocus();
  });

  it('closes on Escape', async () => {
    const { onOpenChange } = renderDialog({ answer });
    await radios();
    await user().keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('a session that cannot carry over (Codex, S4 RUNTIME_NOT_OFFERED)', () => {
  // Even a list with a row in it offers nothing when the plan says no carry-over.
  const refused = options([row(2, 72)], { plan: { mode: 'ask', carryOver: false } });

  it('shows the empty state: the message in place of the list, Continue disabled, and Cancel', async () => {
    renderDialog({ answer: refused, runtime: 'codex' });
    expect(
      await screen.findByText('No other account can take this work right now.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Wait for reset' })).not.toBeInTheDocument();
  });

  it('never asks to continue', async () => {
    const { transport } = renderDialog({ answer: refused, runtime: 'codex' });
    const button = await screen.findByRole('button', { name: 'Continue' });
    await user().click(button);
    expect(transport.continueSession).not.toHaveBeenCalled();
  });
});

describe('closing while a continue is in flight', () => {
  it('stays open until the answer lands, then opens the new session', async () => {
    let answer!: (value: { sessionId?: string }) => void;
    const { onOpenChange } = renderDialog({
      answer: options([row(2, 72)]),
      overrides: {
        continueSession: vi.fn(
          () => new Promise<{ sessionId?: string }>((resolve) => (answer = resolve))
        ),
      },
    });
    await radios();
    await user().click(screen.getByRole('button', { name: 'Continue on Acct 2' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled());
    await user().keyboard('{Escape}');
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    answer({ sessionId: 'session-new' });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(mockSetSessionId).toHaveBeenCalledWith('session-new');
  });
});

describe('an error with no message of its own', () => {
  it('says what failed in plain words', async () => {
    renderDialog({
      answer: options([row(2, 72)]),
      overrides: { continueSession: vi.fn().mockRejectedValue(new Error('')) },
    });
    await radios();
    await user().click(screen.getByRole('button', { name: 'Continue on Acct 2' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't continue on that account. Try again."
    );
  });
});

describe('opening from a countdown (cancelAutoFirst)', () => {
  it('stops the automatic move before asking where the work can go', async () => {
    const order: string[] = [];
    const { transport } = renderDialog({
      answer: options([row(2, 72)]),
      cancelAutoFirst: true,
      overrides: {
        cancelAutoContinue: vi.fn(async () => {
          order.push('cancel');
        }),
        getContinueOptions: vi.fn(async () => {
          order.push('options');
          return options([row(2, 72)]);
        }),
      },
    });
    await radios();
    expect(order).toEqual(['cancel', 'options']);
    expect(transport.cancelAutoContinue).toHaveBeenCalledWith(SID);
  });

  it('shows a failed cancel (a claimed run flow could not reach) and no list', async () => {
    const refusal = Object.assign(
      new Error('Flow could not be reached, so this was not changed.'),
      {
        status: 503,
      }
    );
    const { transport } = renderDialog({
      answer: options([row(2, 72)]),
      cancelAutoFirst: true,
      overrides: { cancelAutoContinue: vi.fn().mockRejectedValue(refusal) },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Flow could not be reached, so this was not changed.'
    );
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(transport.getContinueOptions).not.toHaveBeenCalled();
  });
});
