/**
 * @vitest-environment jsdom
 *
 * The pieces DOR-2628 added to the DorkOS account's home: the "Use credits
 * for" switches (a view onto each runtime's default, never state of their own),
 * the "What's on your account" card, the header menu's one-line status, and
 * the seats card that only appears when there are seats.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { CloudCreditsStatus, CloudPlanResponse } from '@dorkos/shared/cloud-schemas';
import balanceFixture from '@dork-labs/cloud-api/fixtures/v1/billing/balance-denominated.json' with { type: 'json' };
import entitlementsFixture from '@dork-labs/cloud-api/fixtures/v1/billing/entitlements-denominated.json' with { type: 'json' };
import orgFixture from '@dork-labs/cloud-api/fixtures/v1/seats/org.json' with { type: 'json' };
import seatFixture from '@dork-labs/cloud-api/fixtures/v1/seats/seat.json' with { type: 'json' };
import { TransportProvider } from '@/layers/shared/model';
import { creditsRuntimesOnOffer, errorReason, readCreditsFor } from '../model/use-credits-for';
import { describeDorkosAccountLine, lowCreditsFigure } from '../model/use-dorkos-account-line';
import { AccountContents } from '../ui/AccountContents';
import { SeatManagement } from '../ui/SeatManagement';
import { UseCreditsFor } from '../ui/UseCreditsFor';

const OFF: CloudCreditsStatus = {
  enabled: false,
  killed: false,
  linked: false,
  ready: false,
  runtimes: { 'claude-code': 'wired', opencode: 'follow-up', codex: 'follow-up' },
  defaults: {},
  notices: [],
};
/** Linked, credits can be chosen, nothing chosen. */
const ARMED: CloudCreditsStatus = { ...OFF, enabled: true, linked: true };
/** A person chose credits for Claude Code. */
const LIVE: CloudCreditsStatus = {
  ...ARMED,
  ready: true,
  defaults: { 'claude-code': { runsOn: 'credits', chosenBy: 'user' } },
};
/** A person said no: a recorded own-sign-in choice, with a token held anyway. */
const SAID_NO: CloudCreditsStatus = {
  ...ARMED,
  ready: true,
  defaults: { 'claude-code': { runsOn: 'own-sign-in', chosenBy: 'user' } },
};

/** An error shaped the way the HTTP transport throws one for a non-OK answer. */
function serverError(status: number, message: string, body: object = { error: message }) {
  return Object.assign(new Error(message), { status, body });
}

function renderWith(ui: ReactNode, transport: Transport) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{ui}</TransportProvider>
    </QueryClientProvider>
  );
}

/** A plan whose balance has the given allowance left and added credits. */
function planWith(remainingMicro: string, purchasedMicro: string): CloudPlanResponse {
  const balance = structuredClone(balanceFixture);
  balance.allowance.remainingMicro = remainingMicro;
  balance.purchased.remainingMicro = purchasedMicro;
  return {
    available: true,
    entitlements: entitlementsFixture as never,
    balance: balance as never,
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('readCreditsFor', () => {
  it('offers nothing where credits cannot be chosen', () => {
    expect(readCreditsFor(OFF)).toEqual([]);
    expect(readCreditsFor(undefined)).toEqual([]);
  });

  it('offers one row per runtime the server reports as wired, and no others', () => {
    expect(readCreditsFor(ARMED).map((row) => row.runtime)).toEqual(['claude-code']);
  });

  it('reads on only from a recorded credits choice, never from a token being held', () => {
    expect(readCreditsFor(ARMED)[0]).toMatchObject({ on: false, canTurnOn: true });
    expect(readCreditsFor(SAID_NO)[0]).toMatchObject({ on: false });
    expect(readCreditsFor(LIVE, () => 'Main')[0]).toMatchObject({
      on: true,
      chosenBy: 'user',
      canTurnOff: true,
      previousSignIn: 'Main',
    });
  });
});

describe('readCreditsFor — a runtime still recorded on credits', () => {
  it('keeps its row, which can only be turned off, wherever credits cannot reach it', () => {
    const stranded: CloudCreditsStatus = {
      ...OFF,
      defaults: { opencode: { runsOn: 'credits', chosenBy: 'user' } },
    };
    expect(readCreditsFor(stranded)).toEqual([
      expect.objectContaining({
        runtime: 'opencode',
        on: true,
        canTurnOn: false,
        canTurnOff: true,
        unreachable: true,
      }),
    ]);
  });
});

describe('readCreditsFor — what a runtime does not get on credits', () => {
  it('carries the runtime’s own caveat onto its row', () => {
    const report: CloudCreditsStatus = {
      ...ARMED,
      runtimes: { ...ARMED.runtimes, codex: 'wired' },
    };
    const rows = readCreditsFor(report, () => null, {
      codex: {
        credits: {
          protocol: 'openai-responses',
          scope: 'conversation',
          caveat: "Codex can't search the web on DorkOS credits.",
        },
      } as never,
    });
    expect(rows.find((row) => row.runtime === 'codex')?.caveat).toBe(
      "Codex can't search the web on DorkOS credits."
    );
    expect(rows.find((row) => row.runtime === 'claude-code')?.caveat).toBeUndefined();
  });
});

describe('creditsRuntimesOnOffer', () => {
  // Before linking, `enabled` is false by definition; the offer must not wait on it.
  it('names the wired runtimes before linking, by the name every runtime surface uses', () => {
    expect(creditsRuntimesOnOffer(OFF)).toEqual(['Claude Code']);
  });

  it('offers nothing where credits are switched off on this computer', () => {
    expect(creditsRuntimesOnOffer({ ...OFF, killed: true })).toEqual([]);
    expect(creditsRuntimesOnOffer(undefined)).toEqual([]);
  });
});

describe('Use credits for', () => {
  /** A config whose Claude sign-in is the given folder, registered or not. */
  function configWith(path: string, accounts: { path: string; label: string | null }[] = []) {
    return vi.fn().mockResolvedValue({
      claudeCode: {
        resolvedAccount: path,
        inherited: false,
        accounts: accounts.map((account, i) => ({
          id: `a${i}`,
          color: '#111111',
          colorIsDefault: true,
          isAccountRoot: true,
          ...account,
        })),
      },
    });
  }

  it('says “its own sign-in” rather than naming a raw folder', async () => {
    const transport = createMockTransport({
      getCloudCredits: vi.fn().mockResolvedValue(LIVE),
      getConfig: configWith('/home/me/.claude-work'),
    });
    renderWith(<UseCreditsFor />, transport);
    expect(
      await screen.findByText(/Turning this off puts it back on its own sign-in\./)
    ).toBeVisible();
    expect(screen.queryByText(/claude-work/)).not.toBeInTheDocument();
  });

  it('names the sign-in it goes back to by the name the person gave it', async () => {
    const transport = createMockTransport({
      getCloudCredits: vi.fn().mockResolvedValue(LIVE),
      getConfig: configWith('/home/me/.claude-work', [
        { path: '/home/me/.claude-work', label: 'Work' },
      ]),
    });
    renderWith(<UseCreditsFor />, transport);
    expect(await screen.findByText(/Turning this off puts it back on Work\./)).toBeVisible();
  });

  it('is absent where credits cannot be chosen', async () => {
    const transport = createMockTransport({ getCloudCredits: vi.fn().mockResolvedValue(OFF) });
    renderWith(<UseCreditsFor />, transport);
    await waitFor(() => expect(transport.getCloudCredits).toHaveBeenCalled());
    expect(screen.queryByText('Use credits for')).not.toBeInTheDocument();
  });

  it('turns a runtime on by recording the person’s choice', async () => {
    const transport = createMockTransport({
      getCloudCredits: vi.fn().mockResolvedValue(ARMED),
      setCloudCreditsDefault: vi.fn().mockResolvedValue(LIVE),
    });
    renderWith(<UseCreditsFor />, transport);
    const toggle = await screen.findByRole('switch', { name: 'Use credits for Claude Code' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(transport.setCloudCreditsDefault).toHaveBeenCalledWith('claude-code', true)
    );
    await waitFor(() => expect(toggle).toBeChecked());
  });

  it('turns a runtime off, recording the no, and names where it goes back to', async () => {
    const transport = createMockTransport({
      getCloudCredits: vi.fn().mockResolvedValue(LIVE),
      setCloudCreditsDefault: vi.fn().mockResolvedValue(SAID_NO),
    });
    renderWith(<UseCreditsFor />, transport);
    const toggle = await screen.findByRole('switch', { name: 'Use credits for Claude Code' });
    expect(toggle).toBeChecked();
    expect(toggle).toBeEnabled();
    expect(screen.getByText(/Turning this off puts it back on/)).toBeVisible();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(transport.setCloudCreditsDefault).toHaveBeenCalledWith('claude-code', false)
    );
    await waitFor(() => expect(toggle).not.toBeChecked());
  });

  it('never reads on for a computer whose new work is not on credits', async () => {
    const transport = createMockTransport({ getCloudCredits: vi.fn().mockResolvedValue(SAID_NO) });
    renderWith(<UseCreditsFor />, transport);
    expect(
      await screen.findByRole('switch', { name: 'Use credits for Claude Code' })
    ).not.toBeChecked();
  });

  it('says calmly when DorkOS turned it on, and shows the notices owed', async () => {
    const transport = createMockTransport({
      getCloudCredits: vi.fn().mockResolvedValue({
        ...ARMED,
        defaults: { 'claude-code': { runsOn: 'credits', chosenBy: 'default' } },
        notices: [{ kind: 'filled', runtimes: ['claude-code'] }],
      }),
    });
    renderWith(<UseCreditsFor />, transport);
    expect(await screen.findByText(/DorkOS turned this on when you linked/)).toBeVisible();
    expect(screen.getByTestId('credits-notice-filled')).toBeVisible();
  });

  it('gives the reason a failed change came back with', async () => {
    const transport = createMockTransport({
      getCloudCredits: vi.fn().mockResolvedValue(ARMED),
      setCloudCreditsDefault: vi
        .fn()
        .mockRejectedValue(serverError(409, 'Sign in to your DorkOS account first.')),
    });
    renderWith(<UseCreditsFor />, transport);
    fireEvent.click(await screen.findByRole('switch', { name: 'Use credits for Claude Code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t change that. Sign in to your DorkOS account first.'
    );
  });
});

describe('errorReason', () => {
  it('passes through a sentence the server wrote', () => {
    expect(
      errorReason(serverError(502, 'Could not reach the DorkOS cloud. Try again shortly.'))
    ).toBe('Could not reach the DorkOS cloud. Try again shortly.');
  });

  it.each([
    ['a network failure', new Error('Failed to fetch')],
    ['a Safari network failure', new Error('Load failed')],
    ['a body-less status', serverError(500, 'HTTP 500', { error: undefined })],
    ['a status text', serverError(502, 'Bad Gateway')],
    ['a timeout with no answer', new Error('Request timed out after 30s. Check your network.')],
    ['something not an Error', 'boom'],
  ])('shows the fixed sentence for %s', (_case, error) => {
    expect(errorReason(error)).toBe('Try again in a moment.');
  });
});

describe('What’s on your account', () => {
  it('lists the runtimes on credits, the apps connected through it and its communities', async () => {
    const transport = createMockTransport({
      getCloudCredits: vi.fn().mockResolvedValue(LIVE),
      getConnectorConnections: vi.fn().mockResolvedValue({
        connections: [
          {
            connectionId: 'c1',
            toolkit: 'gmail',
            label: 'work',
            mode: 'managed',
            agentCount: 1,
            everyAgent: null,
            readiness: { state: 'ready' },
          },
          {
            connectionId: 'c2',
            toolkit: 'slack',
            label: 'own key',
            mode: 'byo',
            agentCount: 1,
            everyAgent: null,
            readiness: { state: 'ready' },
          },
        ],
      }),
      listHostedCommunities: vi.fn().mockResolvedValue({
        available: true,
        communities: [{ name: 'Acme Robotics' }],
        moves: [],
        allowance: null,
      }),
    });
    renderWith(<AccountContents />, transport);
    expect(await screen.findByText('Claude Code')).toBeInTheDocument();
    expect(await screen.findByText('Acme Robotics')).toBeInTheDocument();
    expect(await screen.findByText(/^Gmail/)).toBeInTheDocument();
    // An app on the person's own key is not on the DorkOS account.
    expect(screen.queryByText(/Slack/)).not.toBeInTheDocument();
  });

  it('says one plain line when nothing is on the account yet', async () => {
    renderWith(<AccountContents />, createMockTransport());
    expect(await screen.findByText(/^Nothing yet\./)).toBeInTheDocument();
  });
});

describe('the account line', () => {
  it('reads "Not signed in", then "Signed in" with the service’s label', () => {
    expect(describeDorkosAccountLine({ state: 'loading' })).toBeUndefined();
    expect(describeDorkosAccountLine({ state: 'signed-out' })).toBe('Not signed in');
    expect(
      describeDorkosAccountLine({ state: 'signed-in', label: 'kai@dork.dev', lowCredits: null })
    ).toBe('Signed in · kai@dork.dev');
    expect(describeDorkosAccountLine({ state: 'signed-in', label: null, lowCredits: null })).toBe(
      'Signed in'
    );
  });

  it('adds a credit figure only when credits are low', () => {
    // granted 750,000: 612,345 left is plenty; 50,000 left (under a tenth) is low.
    expect(lowCreditsFigure(planWith('612345', '0'))).toBeNull();
    // 50,000 / 250 = 200 credits, rounded down as a position.
    expect(lowCreditsFigure(planWith('50000', '0'))).toBe('200 credits left');
    expect(
      describeDorkosAccountLine({
        state: 'signed-in',
        label: 'Kai',
        lowCredits: '200 credits left',
      })
    ).toBe('Signed in · Kai · 200 credits left');
  });

  it('is not low while added credits remain behind the allowance', () => {
    expect(lowCreditsFigure(planWith('50000', '99999'))).toBeNull();
  });

  it('shows no figure for an account with no plan to read', () => {
    expect(lowCreditsFigure({ available: false })).toBeNull();
    expect(lowCreditsFigure(undefined)).toBeNull();
  });
});

describe('Seats', () => {
  it('is absent when the account holds no seats', async () => {
    const transport = createMockTransport({
      getCloudOrgs: vi.fn().mockResolvedValue({ available: true, orgs: [orgFixture] }),
      getCloudSeats: vi.fn().mockResolvedValue({ available: true, seats: [] }),
    });
    renderWith(<SeatManagement />, transport);
    await waitFor(() => expect(transport.getCloudSeats).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Seats')).not.toBeInTheDocument());
    expect(screen.queryByText(/No seats yet/)).not.toBeInTheDocument();
  });

  it('keeps the organization picker when the first organization holds no seats', async () => {
    const second = { ...orgFixture, id: `${orgFixture.id}-b`, name: 'Second org' };
    const transport = createMockTransport({
      getCloudOrgs: vi.fn().mockResolvedValue({ available: true, orgs: [orgFixture, second] }),
      getCloudSeats: vi.fn((orgId: string) =>
        Promise.resolve({
          available: true as const,
          seats: orgId === second.id ? [seatFixture as never] : [],
        })
      ),
    });
    renderWith(<SeatManagement />, transport);
    const picker = await screen.findByRole('combobox', { name: 'Organization' });
    expect(await screen.findByText('No seats in this organization.')).toBeInTheDocument();
    fireEvent.change(picker, { target: { value: second.id } });
    expect(await screen.findByText(seatFixture.address.canonical)).toBeInTheDocument();
  });
});
