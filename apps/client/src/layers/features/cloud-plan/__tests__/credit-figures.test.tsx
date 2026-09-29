/**
 * @vitest-environment jsdom
 *
 * Every Cloud figure on the plan card, the credits gauge and the upgrade nudge
 * is rendered by `@dork-labs/cloud-api/display` in the unit the response
 * served, rounded by the kind of figure it is.
 *
 * Fixtures are the contract package's own denominated ones: the ISO test
 * currency `XTS` and a placeholder scale of 250 micro-units per credit. That
 * placeholder is deliberately NOT a real value, so every credit count below is
 * worked by hand from it (for example 750,000 / 250 = 3,000) and would change
 * if the panel ever reached for a scale of its own instead of the served one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { formatMoney } from '@dork-labs/cloud-api/display';
import balanceFixture from '@dork-labs/cloud-api/fixtures/v1/billing/balance-denominated.json' with { type: 'json' };
import entitlementsFixture from '@dork-labs/cloud-api/fixtures/v1/billing/entitlements-denominated.json' with { type: 'json' };
import usageFixture from '@dork-labs/cloud-api/fixtures/v1/billing/usage-denominated.json' with { type: 'json' };
import nudgeFixture from '@dork-labs/cloud-api/fixtures/v1/billing/nudge-denominated.json' with { type: 'json' };
import legacyBalanceFixture from '@dork-labs/cloud-api/fixtures/v1/billing/balance.json' with { type: 'json' };
import legacyEntitlementsFixture from '@dork-labs/cloud-api/fixtures/v1/billing/entitlements-free.json' with { type: 'json' };
import legacyUsageFixture from '@dork-labs/cloud-api/fixtures/v1/billing/usage-by-model.json' with { type: 'json' };
import legacyNudgeFixture from '@dork-labs/cloud-api/fixtures/v1/billing/nudge.json' with { type: 'json' };
import { TransportProvider } from '@/layers/shared/model';
import { cloudPlanKeys } from '../model/use-cloud-plan';
import { CreditsGauge } from '../ui/CreditsGauge';
import { PlanCard } from '../ui/PlanCard';
import { UpgradeNudge } from '../ui/UpgradeNudge';

type Balance = typeof balanceFixture;

/** The money text for a micro amount in the fixture's own currency. */
function money(micro: string): string {
  const text = formatMoney(micro, balanceFixture.denomination);
  if (text === null) throw new Error(`fixture amount ${micro} did not render`);
  return text.replace(/\u00a0/g, ' ');
}

/** Normalise the non-breaking space `Intl` may put between a code and digits. */
function textOf(element: HTMLElement): string {
  return (element.textContent ?? '').replace(/\u00a0/g, ' ');
}

/** Render one surface against a transport answering from the given payloads. */
function renderWith(
  ui: ReactNode,
  payloads: {
    entitlements?: unknown;
    balance?: unknown;
    usage?: unknown;
    nudge?: unknown;
  }
): { transport: Transport; queryClient: QueryClient } {
  const transport = createMockTransport();
  vi.mocked(transport.getCloudPlan).mockResolvedValue({
    available: true,
    entitlements: (payloads.entitlements ?? entitlementsFixture) as never,
    balance: (payloads.balance === undefined ? balanceFixture : payloads.balance) as never,
  });
  vi.mocked(transport.getCloudUsage).mockResolvedValue({
    available: true,
    usage: (payloads.usage ?? usageFixture) as never,
  });
  vi.mocked(transport.getCloudNudge).mockResolvedValue({
    available: true,
    nudge: (payloads.nudge ?? nudgeFixture) as never,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{ui}</TransportProvider>
    </QueryClientProvider>
  );
  return { transport, queryClient };
}

/** The balance fixture with some amounts replaced, keeping its denomination. */
function balanceWith(change: (balance: Balance) => void): Balance {
  const copy = structuredClone(balanceFixture);
  change(copy);
  return copy;
}

describe('the credits gauge', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('shows what is left and what was granted as positions, rounded down', async () => {
    // remaining 612,345 / 250 = 2,449.38 → 2,449; granted 750,000 / 250 = 3,000.
    renderWith(<CreditsGauge />, {});
    expect(await screen.findByText('2,449 of 3,000 credits left in this period')).toBeVisible();
  });

  it('rounds what was granted down too', async () => {
    // 750,200 / 250 = 3,000.8: a position reads 3,000, where a charge would read 3,001.
    renderWith(<CreditsGauge />, {
      balance: balanceWith((b) => {
        b.allowance.grantedMicro = '750200';
      }),
    });
    expect(await screen.findByText('2,449 of 3,000 credits left in this period')).toBeVisible();
  });

  it('reads the balance figures in the balance`s unit, not the usage response`s', async () => {
    renderWith(<CreditsGauge />, { balance: legacyBalanceFixture });
    expect(await screen.findByText('Total for the last 30 days: 18 credits')).toBeVisible();
    expect(screen.getAllByText(/couldn’t read the credit figures/i)).toHaveLength(1);
    expect(screen.queryByText(/left in this period/i)).not.toBeInTheDocument();
  });

  it('reads the usage figures in the usage response`s unit, not the balance`s', async () => {
    renderWith(<CreditsGauge />, { usage: legacyUsageFixture });
    expect(await screen.findByText('2,449 of 3,000 credits left in this period')).toBeVisible();
    expect(screen.getAllByText(/couldn’t read the credit figures/i)).toHaveLength(1);
    expect(screen.queryByText(/total for the last 30 days/i)).not.toBeInTheDocument();
  });

  it('never rounds a position up to credit that cannot be spent', async () => {
    // 999 / 250 = 3.996: a position reads 3, where a charge would read 4.
    renderWith(<CreditsGauge />, {
      balance: balanceWith((b) => {
        b.allowance.remainingMicro = '999';
      }),
    });
    expect(await screen.findByText('3 of 3,000 credits left in this period')).toBeVisible();
  });

  it('shows where the credits went as charges, and the total from the exact sum', async () => {
    // The row is 4,620 / 250 = 18.48 → 18, and so is the total.
    renderWith(<CreditsGauge />, {});
    expect(await screen.findByText(usageFixture.rows[0].displayName)).toBeVisible();
    expect(screen.getByText('18')).toBeVisible();
    expect(screen.getByText('Total for the last 30 days: 18 credits')).toBeVisible();
  });

  it('rounds charges half away from zero, shows a sliver as <1, and never sums rounded rows', async () => {
    // Three rows of 125 micro (half a credit each) read 1, 1, 1 — and <1 for
    // 100 micro. The total is the service's exact 475 / 250 = 1.9 → 2, not the
    // 3 the rounded rows would add up to.
    const row = usageFixture.rows[0];
    renderWith(<CreditsGauge />, {
      usage: {
        ...usageFixture,
        rows: [
          { ...row, key: 'md_a', displayName: 'first', dorkosPriceMicro: '125' },
          { ...row, key: 'md_b', displayName: 'second', dorkosPriceMicro: '250' },
          { ...row, key: 'md_c', displayName: 'third', dorkosPriceMicro: '100' },
        ],
        totals: { listPriceMicro: '0', dorkosPriceMicro: '475' },
      },
    });
    expect(await screen.findByText('first')).toBeVisible();
    expect(screen.getAllByText('1')).toHaveLength(2);
    expect(screen.getByText('<1')).toBeVisible();
    expect(screen.getByText('Total for the last 30 days: 2 credits')).toBeVisible();
  });

  it('says it could not read the figures when a response names no unit', async () => {
    renderWith(<CreditsGauge />, { balance: legacyBalanceFixture, usage: legacyUsageFixture });
    expect(await screen.findByText(legacyUsageFixture.rows[0].displayName)).toBeVisible();
    expect(screen.getAllByText(/couldn’t read the credit figures/i)).toHaveLength(2);
    expect(screen.queryByText(/left in this period/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/total for the last 30 days/i)).not.toBeInTheDocument();
    // No figure from either payload, in any rounding, reached the screen.
    expect(screen.queryByText(/\d/)).not.toBeInTheDocument();
  });
});

describe('the plan card', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  /** The value `<dd>` beside a `<dt>` label. */
  function fact(label: string): string {
    const term = screen.getByText(label);
    return textOf(term.nextElementSibling as HTMLElement);
  }

  it('shows included credits as a position with money worked out from the rounded count', async () => {
    renderWith(<PlanCard />, {});
    await screen.findByText(entitlementsFixture.planDisplayName);
    // 750,000 / 250 = 3,000 credits, and 3,000 × 250 = 750,000 micro of money.
    expect(fact('Included credits')).toBe(`3,000 credits (${money('750000')})`);
  });

  it('rounds included credits down, where a charge would round them up', async () => {
    // 750,200 / 250 = 3,000.8 → 3,000 credits (a charge would say 3,001), and
    // the money beside is 3,000 × 250 = 750,000 micro.
    renderWith(<PlanCard />, {
      entitlements: {
        ...entitlementsFixture,
        limits: { ...entitlementsFixture.limits, includedCreditsMicro: '750200' },
      },
    });
    await screen.findByText(entitlementsFixture.planDisplayName);
    expect(fact('Included credits')).toBe(`3,000 credits (${money('750000')})`);
  });

  it('shows the allowance left as a position and credits bought with money beside', async () => {
    renderWith(<PlanCard />, {});
    await screen.findByText(entitlementsFixture.planDisplayName);
    expect(fact('Allowance left')).toBe('2,449 credits');
    // 99,999 / 250 = 399.996 → 399 credits; the money beside is the rounded
    // count's value, 399 × 250 = 99,750 micro.
    expect(fact('Credits bought')).toBe(`399 credits (${money('99750')})`);
  });

  it('rounds the allowance left down, where a charge would round it up', async () => {
    // 999 / 250 = 3.996 → 3 credits, not 4.
    renderWith(<PlanCard />, {
      balance: balanceWith((b) => {
        b.allowance.remainingMicro = '999';
      }),
    });
    await screen.findByText(entitlementsFixture.planDisplayName);
    expect(fact('Allowance left')).toBe('3 credits');
  });

  it('leaves out an owed line when nothing is owed, and shows even a sliver of debt', async () => {
    renderWith(<PlanCard />, {});
    await screen.findByText(entitlementsFixture.planDisplayName);
    expect(screen.queryByText('Owed')).not.toBeInTheDocument();
    cleanup();

    renderWith(<PlanCard />, {
      balance: balanceWith((b) => {
        b.owedMicro = '1';
      }),
    });
    await screen.findByText('Owed');
    expect(fact('Owed')).toBe('<1 credit');
  });

  it('says it could not read the figures when a response names no unit', async () => {
    renderWith(<PlanCard />, {
      entitlements: legacyEntitlementsFixture,
      balance: legacyBalanceFixture,
    });
    await screen.findByText(legacyEntitlementsFixture.planDisplayName);
    expect(screen.getByText(/couldn’t read the credit figures/i)).toBeVisible();
    expect(screen.queryByText('Included credits')).not.toBeInTheDocument();
    expect(screen.queryByText('Allowance left')).not.toBeInTheDocument();
    expect(screen.queryByText('Credits bought')).not.toBeInTheDocument();
  });

  it('still says so when only the entitlement names no unit', async () => {
    renderWith(<PlanCard />, { entitlements: legacyEntitlementsFixture });
    await screen.findByText(legacyEntitlementsFixture.planDisplayName);
    expect(screen.getByText(/couldn’t read the credit figures/i)).toBeVisible();
    expect(screen.queryByText('Included credits')).not.toBeInTheDocument();
    expect(screen.getByText('Allowance left')).toBeVisible();
  });

  it('still says so when only the balance names no unit', async () => {
    renderWith(<PlanCard />, { balance: legacyBalanceFixture });
    await screen.findByText(entitlementsFixture.planDisplayName);
    expect(screen.getByText(/couldn’t read the credit figures/i)).toBeVisible();
    expect(screen.getByText('Included credits')).toBeVisible();
    expect(screen.queryByText('Allowance left')).not.toBeInTheDocument();
  });
});

describe('the upgrade nudge', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('reads the last 30 days as a charge with money beside, and the price and difference as money', async () => {
    renderWith(<UpgradeNudge />, {});
    const line = await screen.findByText(new RegExp(nudgeFixture.suggestedPlanDisplayName));
    // 7,654,321 / 250 = 30,617.28 → 30,617 credits; money beside is
    // 30,617 × 250 = 7,654,250 micro. The plan price and the saving are money.
    expect(textOf(line)).toBe(
      `Your last 30 days: 30,617 credits (${money('7654250')}). ` +
        `${nudgeFixture.suggestedPlanDisplayName}: ${money('5000000')}. ` +
        `Difference: ${money('2654321')}.`
    );
  });

  it('rounds the last 30 days as a charge: half a credit goes up', async () => {
    // 7,654,375 / 250 = 30,617.5 → 30,618 as a charge (a position would say
    // 30,617), and the money beside is 30,618 × 250 = 7,654,500 micro.
    renderWith(<UpgradeNudge />, { nudge: { ...nudgeFixture, trailing30Micro: '7654375' } });
    const line = await screen.findByText(new RegExp(nudgeFixture.suggestedPlanDisplayName));
    expect(textOf(line)).toContain(`Your last 30 days: 30,618 credits (${money('7654500')}).`);
  });

  it('renders a plan price as money, never through a credit rule', async () => {
    renderWith(<UpgradeNudge />, {});
    const line = await screen.findByText(new RegExp(nudgeFixture.suggestedPlanDisplayName));
    // 5,000,000 / 250 = 20,000: the figure the price would read as credits.
    expect(textOf(line)).not.toMatch(/20,000/);
  });

  it('renders nothing when the nudge names no unit', async () => {
    const { queryClient } = renderWith(<UpgradeNudge />, { nudge: legacyNudgeFixture });
    // Wait for the read to SETTLE, so "nothing rendered" is the answer and not
    // the loading state.
    await waitFor(() =>
      expect(queryClient.getQueryState(cloudPlanKeys.nudge())?.status).toBe('success')
    );
    expect(
      screen.queryByText(new RegExp(legacyNudgeFixture.suggestedPlanDisplayName))
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument();
  });
});
