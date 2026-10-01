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
import { errorReason, readCreditsFor } from '../model/use-credits-for';
import { describeDorkosAccountLine, lowCreditsFigure } from '../model/use-dorkos-account-line';
import { AccountContents } from '../ui/AccountContents';
import { SeatManagement } from '../ui/SeatManagement';
import { UseCreditsFor } from '../ui/UseCreditsFor';

const OFF: CloudCreditsStatus = {
  enabled: false,
  ready: false,
  runtimes: { 'claude-code': 'wired', opencode: 'follow-up', codex: 'follow-up' },
};
const ARMED: CloudCreditsStatus = { ...OFF, enabled: true };
const LIVE: CloudCreditsStatus = { ...ARMED, ready: true };

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
  it('offers nothing while the server has credits switched off', () => {
    expect(readCreditsFor(OFF)).toEqual([]);
    expect(readCreditsFor(undefined)).toEqual([]);
  });

  it('offers one row per runtime the server reports as wired, and no others', () => {
    expect(readCreditsFor(ARMED).map((row) => row.runtime)).toEqual(['claude-code']);
  });

  it('reads on/off from the server’s answer and holds nothing of its own', () => {
    expect(readCreditsFor(ARMED)[0]).toMatchObject({ on: false, canTurnOn: true });
    // No path back to a runtime's own sign-in exists on this build, so a row
    // never offers one — and names no previous sign-in it cannot restore.
    expect(readCreditsFor(LIVE)[0]).toMatchObject({
      on: true,
      canTurnOff: false,
      previousSignIn: null,
    });
  });
});

describe('Use credits for', () => {
  it('is absent where the server has credits switched off', async () => {
    const transport = createMockTransport({ getCloudCredits: vi.fn().mockResolvedValue(OFF) });
    renderWith(<UseCreditsFor />, transport);
    await waitFor(() => expect(transport.getCloudCredits).toHaveBeenCalled());
    expect(screen.queryByText('Use credits for')).not.toBeInTheDocument();
  });

  it('turns a runtime on by asking the server for credits', async () => {
    const transport = createMockTransport({
      getCloudCredits: vi.fn().mockResolvedValue(ARMED),
      selectCloudCredits: vi.fn().mockResolvedValue(LIVE),
    });
    renderWith(<UseCreditsFor />, transport);
    const toggle = await screen.findByRole('switch', { name: 'Use credits for Claude' });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText('Claude uses its own sign-in.')).toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => expect(transport.selectCloudCredits).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toggle).toBeChecked());
  });

  it('cannot be turned off where nothing can hand the runtime back, and says why', async () => {
    const transport = createMockTransport({ getCloudCredits: vi.fn().mockResolvedValue(LIVE) });
    renderWith(<UseCreditsFor />, transport);
    const toggle = await screen.findByRole('switch', { name: 'Use credits for Claude' });
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();
    expect(
      screen.getByText(/stay on until the current pass runs out, DorkOS restarts, or you unlink/)
    ).toBeVisible();
    // No promise of a renewal this build cannot keep.
    expect(screen.queryByRole('button', { name: /refresh/i })).not.toBeInTheDocument();
  });

  it('says credits could not be turned on when the server sends back a report that is not live', async () => {
    const transport = createMockTransport({
      getCloudCredits: vi.fn().mockResolvedValue(ARMED),
      // The same report back, unchanged: nothing was armed.
      selectCloudCredits: vi.fn().mockResolvedValue(ARMED),
    });
    renderWith(<UseCreditsFor />, transport);
    fireEvent.click(await screen.findByRole('switch', { name: 'Use credits for Claude' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t turn on DorkOS credits');
    expect(alert).not.toHaveTextContent(/nothing changed/i);
  });

  it('gives the reason a failed turn-on came back with', async () => {
    const transport = createMockTransport({
      getCloudCredits: vi.fn().mockResolvedValue(ARMED),
      selectCloudCredits: vi
        .fn()
        .mockRejectedValue(serverError(402, 'Your account is out of credits.')),
    });
    renderWith(<UseCreditsFor />, transport);
    fireEvent.click(await screen.findByRole('switch', { name: 'Use credits for Claude' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t turn on DorkOS credits. Your account is out of credits.'
    );
  });

  it('follows the server once the pass runs out: the switch reads off, with no false alert', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const getCloudCredits = vi.fn().mockResolvedValue(ARMED);
      const transport = createMockTransport({
        getCloudCredits,
        selectCloudCredits: vi.fn().mockResolvedValue(LIVE),
      });
      renderWith(<UseCreditsFor />, transport);
      const toggle = await screen.findByRole('switch', { name: 'Use credits for Claude' });
      // Turned on: the select's report is live, and the next reads say so too.
      getCloudCredits.mockResolvedValue(LIVE);
      fireEvent.click(toggle);
      await waitFor(() => expect(toggle).toBeChecked());

      // The pass expires on the server; nothing tells the client but the poll.
      getCloudCredits.mockResolvedValue(ARMED);
      await vi.advanceTimersByTimeAsync(61_000);
      await waitFor(() => expect(toggle).not.toBeChecked());
      expect(toggle).toBeEnabled();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
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
    expect(await screen.findByText('Claude')).toBeInTheDocument();
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
