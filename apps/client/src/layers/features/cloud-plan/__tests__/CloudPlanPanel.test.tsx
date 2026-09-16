/**
 * @vitest-environment jsdom
 *
 * The plan-aware surfaces, driven by the contract package's OWN conformance
 * fixtures.
 *
 * Fixtures rather than hand-written payloads, for the reason that matters here:
 * every value in them is synthetic — opaque identifiers and placeholder display
 * strings — so these tests prove the UI renders what the wire said WITHOUT any
 * catalog value existing in this repository to render.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import balanceFixture from '@dork-labs/cloud-api/fixtures/v1/billing/balance.json' with { type: 'json' };
import entitlementsFixture from '@dork-labs/cloud-api/fixtures/v1/billing/entitlements-free.json' with { type: 'json' };
import usageFixture from '@dork-labs/cloud-api/fixtures/v1/billing/usage-by-model.json' with { type: 'json' };
import nudgeFixture from '@dork-labs/cloud-api/fixtures/v1/billing/nudge.json' with { type: 'json' };
import orgFixture from '@dork-labs/cloud-api/fixtures/v1/seats/org.json' with { type: 'json' };
import seatFixture from '@dork-labs/cloud-api/fixtures/v1/seats/seat.json' with { type: 'json' };
import membersFixture from '@dork-labs/cloud-api/fixtures/v1/seats/members.json' with { type: 'json' };
import seatRequiredFixture from '@dork-labs/cloud-api/fixtures/v1/problem/person-seat-required.json' with { type: 'json' };
import { TransportProvider } from '@/layers/shared/model';
import { CloudPlanPanel } from '../ui/CloudPlanPanel';

function renderPanel(transport: Transport) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <CloudPlanPanel />
      </TransportProvider>
    </QueryClientProvider>
  );
}

/** A transport whose plan reads answer from the contract fixtures. */
function linkedTransport(overrides: Partial<Record<string, unknown>> = {}): Transport {
  const transport = createMockTransport();
  vi.mocked(transport.getCloudPlan).mockResolvedValue({
    available: true,
    entitlements: entitlementsFixture as never,
    balance: balanceFixture as never,
  });
  vi.mocked(transport.getCloudUsage).mockResolvedValue({
    available: true,
    usage: usageFixture as never,
  });
  vi.mocked(transport.getCloudOrgs).mockResolvedValue({
    available: true,
    orgs: [orgFixture as never],
  });
  vi.mocked(transport.getCloudSeats).mockResolvedValue({
    available: true,
    seats: [seatFixture as never],
  });
  vi.mocked(transport.getCloudMembers).mockResolvedValue({
    available: true,
    members: membersFixture.items as never,
  });
  for (const [name, value] of Object.entries(overrides)) {
    vi.mocked(
      transport[name as keyof Transport] as never as ReturnType<typeof vi.fn>
    ).mockResolvedValue(value as never);
  }
  return transport;
}

describe('the plan-aware surfaces', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('shows one line, and asks for nothing else, on an install with no cloud account', async () => {
    const transport = createMockTransport();
    renderPanel(transport);
    expect(
      await screen.findByText(/link this instance to a dorkos account above/i)
    ).toBeInTheDocument();
    // No card, no gauge, no seat list — nothing to hide, because nothing rendered.
    expect(screen.queryByText(/your plan/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/credits/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /release/i })).not.toBeInTheDocument();
    // And it really did ask for nothing else: the plan read is the ONE request
    // an unlinked install makes, and every other surface is gated behind it.
    expect(transport.getCloudPlan).toHaveBeenCalled();
    expect(transport.getCloudUsage).not.toHaveBeenCalled();
    expect(transport.getCloudNudge).not.toHaveBeenCalled();
    expect(transport.getCloudOrgs).not.toHaveBeenCalled();
    expect(transport.getCloudSeats).not.toHaveBeenCalled();
    expect(transport.getCloudCredits).not.toHaveBeenCalled();
  });

  it('says nothing about linking until the read has settled', async () => {
    // The regression this pins: deciding linked-vs-unlinked before the answer
    // arrives flashes "link this instance" at somebody who linked months ago,
    // on every Settings open. A never-resolving read holds the panel in exactly
    // that window for the length of the assertion.
    const transport = createMockTransport();
    vi.mocked(transport.getCloudPlan).mockReturnValue(new Promise(() => {}));
    renderPanel(transport);

    await waitFor(() => expect(screen.queryByText(/your plan/i)).not.toBeInTheDocument());
    expect(
      screen.queryByText(/link this instance to a dorkos account above/i)
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/couldn’t reach your dorkos account/i)).not.toBeInTheDocument();
  });

  it('says the service is unreachable rather than telling a linked person to link', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getCloudPlan).mockRejectedValue(new Error('502'));
    renderPanel(transport);
    expect(await screen.findByText(/couldn’t reach your dorkos account/i)).toBeInTheDocument();
    expect(screen.queryByText(/link this instance/i)).not.toBeInTheDocument();
  });

  it('renders the plan by the name the service gave it, and the figures it sent', async () => {
    renderPanel(linkedTransport());
    expect(await screen.findByText(entitlementsFixture.planDisplayName)).toBeInTheDocument();
    // Seats used of included, straight off the wire — the people row and the
    // assigned-seats row both read "1 of 1" on this fixture.
    expect(screen.getAllByText('1 of 1').length).toBeGreaterThan(0);
    expect(screen.getByText('0 of 0')).toBeInTheDocument();
    expect(screen.getByText('1 GB')).toBeInTheDocument();
    // The remote-access MODE is wire-supplied; the words for it describe the
    // mechanism and name no plan.
    expect(screen.getByText('Bring your own tunnel')).toBeInTheDocument();
    // Micro-units formatted once, at the edge: 1250000 millionths.
    expect(screen.getByText('1.25')).toBeInTheDocument();
  });

  it('breaks credits down by the labels the service supplied, never by its keys', async () => {
    renderPanel(linkedTransport());
    expect(await screen.findByText(usageFixture.rows[0].displayName)).toBeInTheDocument();
    expect(screen.queryByText(usageFixture.rows[0].key)).not.toBeInTheDocument();
  });

  it('hides the nudge when the service offers none', async () => {
    renderPanel(linkedTransport());
    await screen.findByText(entitlementsFixture.planDisplayName);
    expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument();
  });

  it('renders the nudge already reduced, and lets it be dismissed', async () => {
    renderPanel(linkedTransport({ getCloudNudge: { available: true, nudge: nudgeFixture } }));
    expect(
      await screen.findByText(new RegExp(nudgeFixture.suggestedPlanDisplayName, 'i'))
    ).toBeInTheDocument();
    // The saving is the service's subtraction, rendered as given: 28000000
    // millionths.
    expect(screen.getByText(/28\.00/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(
      screen.queryByText(new RegExp(nudgeFixture.suggestedPlanDisplayName, 'i'))
    ).not.toBeInTheDocument();
  });

  it('explains a refused seat action in the service`s own words', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.releaseCloudSeat).mockResolvedValue({
      ok: false,
      problem: seatRequiredFixture as never,
    });
    renderPanel(transport);
    await userEvent.click(await screen.findByRole('button', { name: /release/i }));
    expect(await screen.findByText(seatRequiredFixture.title)).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(seatRequiredFixture.requiredPlanDisplayName, 'i'))
    ).toBeInTheDocument();
  });

  it('says so when a seat action could not reach the service, rather than nothing', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.releaseCloudSeat).mockRejectedValue(new Error('network'));
    renderPanel(transport);
    await userEvent.click(await screen.findByRole('button', { name: /release/i }));
    expect(await screen.findByText(/nothing changed/i)).toBeInTheDocument();
  });

  it('can actually assign an unassigned seat, to a member it was told about', async () => {
    // The path the refusal envelope exists for. It is reachable only because the
    // app offers the org's own members — an unassigned seat carries no subject to
    // put back, so without a candidate list this button could never be pressed.
    const transport = linkedTransport();
    vi.mocked(transport.getCloudSeats).mockResolvedValue({
      available: true,
      seats: [{ ...seatFixture, status: 'unassigned', subject: null } as never],
    });
    vi.mocked(transport.assignCloudSeat).mockResolvedValue({ ok: true });
    renderPanel(transport);
    const picker = await screen.findByLabelText(/assign this seat to/i);
    // Labelled by ROLE, not by the opaque account id — the contract carries no
    // display name for a member, and an id means nothing to the person picking.
    expect(screen.getByRole('option', { name: 'owner' })).toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: membersFixture.items[0].userId })
    ).not.toBeInTheDocument();
    await userEvent.selectOptions(picker, membersFixture.items[0].userId);
    expect(transport.assignCloudSeat).toHaveBeenCalledWith(seatFixture.id, {
      kind: 'user',
      id: membersFixture.items[0].userId,
    });
  });

  it('renders a seat by its address and status, with no presence dot', async () => {
    renderPanel(linkedTransport());
    expect(await screen.findByText(seatFixture.address.canonical)).toBeInTheDocument();
    expect(screen.getByText('assigned')).toBeInTheDocument();
  });
});
