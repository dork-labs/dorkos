import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { SpendingSummary } from '@dorkos/shared/connector-spending';
import type { ApprovalSpend, PendingApproval } from '@dorkos/shared/approval-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { PaidActionMarker } from '@/layers/entities/connectors';
import { SpendingBlock } from '@/layers/features/connections';
import { ApprovalCard } from '@/layers/features/approvals';
import { createPlaygroundTransport } from '../playground-transport';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';

/*
 * The monthly spend limit (DOR-4204 spec 1.0): every Spending block state of
 * §7, the paid-run card of §4, and the marker of §6. Names and amounts are
 * made up: Kestrel, Acme Search, Northwind.
 */

const DOLLAR = 1_000_000;
const micro = (dollars: number) => String(Math.round(dollars * DOLLAR));
const RESETS = new Date(Date.UTC(2026, 11, 1)).toISOString();

/** A month, overriding only what a state needs. */
function month(overrides: Partial<SpendingSummary>): SpendingSummary {
  return {
    currency: 'USD',
    limitMicro: null,
    maxMicro: micro(10_000),
    resetsAt: RESETS,
    prices: { tavily: micro(0.3) },
    meterReadable: true,
    month: '2026-11',
    usedMicro: '0',
    leftMicro: null,
    overMicro: null,
    approximate: false,
    byApp: [],
    ...overrides,
  };
}

const ACME = (amount: number, runs: number, estimated = true) => ({
  toolkit: 'tavily',
  runs,
  amountMicro: micro(amount),
  estimated,
  unknownRuns: 0,
});

/** A transport whose spending read answers `summary`, or fails when it is an Error. */
function Spending({
  summary,
  children,
}: {
  summary: SpendingSummary | Error;
  children: ReactNode;
}) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  const [transport] = useState<Transport>(() => {
    // A Proxy, not a spread: the playground transport is itself a Proxy.
    const base = createPlaygroundTransport();
    const answers: Record<string, () => Promise<unknown>> = {
      getConnectorSpending: () =>
        summary instanceof Error ? Promise.reject(summary) : Promise.resolve(summary),
      setConnectorSpendingLimit: () => Promise.reject(new Error('Not saved in the playground')),
      grantApproval: () => Promise.resolve({ ok: true }),
      denyApproval: () => Promise.resolve({ ok: true }),
    };
    return new Proxy(base, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && prop in answers) return answers[prop];
        return Reflect.get(target, prop, receiver);
      },
    });
  });
  return (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

const nameOf = (toolkit: string) => (toolkit === 'tavily' ? 'Acme Search' : 'Northwind Data');

/** One labelled Spending block state. */
function BlockState({ label, summary }: { label: string; summary: SpendingSummary | Error }) {
  return (
    <div className="space-y-2">
      <ShowcaseLabel>{label}</ShowcaseLabel>
      <Spending summary={summary}>
        <SpendingBlock canSpend nameOf={nameOf} />
      </Spending>
    </div>
  );
}

const LIMIT = micro(40);
const STATES: { label: string; summary: SpendingSummary | Error }[] = [
  { label: '7.2 No limit, nothing spent', summary: month({}) },
  {
    label: 'No limit, some spent',
    summary: month({ usedMicro: micro(4.2), approximate: true, byApp: [ACME(4.2, 14)] }),
  },
  {
    label: '7.3 Limit set, nothing spent',
    summary: month({ limitMicro: LIMIT, leftMicro: LIMIT, overMicro: '0' }),
  },
  {
    label: '7.4 Under the limit',
    summary: month({
      limitMicro: LIMIT,
      usedMicro: micro(12.4),
      leftMicro: micro(27.6),
      overMicro: '0',
      approximate: true,
      byApp: [ACME(9.3, 31), { ...ACME(3.1, 2, false), toolkit: 'exa' }],
    }),
  },
  {
    label: '7.5 At 80% or more',
    summary: month({
      limitMicro: LIMIT,
      usedMicro: micro(32.1),
      leftMicro: micro(7.9),
      overMicro: '0',
      byApp: [ACME(32.1, 107, false)],
    }),
  },
  {
    label: '7.6 At the limit',
    summary: month({
      limitMicro: LIMIT,
      usedMicro: LIMIT,
      leftMicro: '0',
      overMicro: '0',
      byApp: [ACME(40, 133, false)],
    }),
  },
  {
    label: '7.7 Over (a reported cost went past)',
    summary: month({
      limitMicro: LIMIT,
      usedMicro: micro(41.2),
      leftMicro: '0',
      overMicro: micro(1.2),
      byApp: [ACME(41.2, 134, false)],
    }),
  },
  {
    label: '7.8 Unknown prices this month',
    summary: month({
      limitMicro: LIMIT,
      usedMicro: micro(9.3),
      leftMicro: micro(30.7),
      overMicro: '0',
      approximate: true,
      byApp: [
        ACME(9.3, 31),
        { toolkit: 'exa', runs: 3, amountMicro: '0', estimated: false, unknownRuns: 3 },
      ],
    }),
  },
  {
    label: '7.9 Meter unreadable',
    summary: { ...month({ limitMicro: LIMIT }), meterReadable: false },
  },
  { label: '7.10 Load error', summary: new Error('down') },
];

/** A paid-run card, overriding only its money. */
function paidCard(id: string, spend: ApprovalSpend): PendingApproval {
  return {
    approvalId: id,
    capabilityId: 'connectors.execute_read',
    capabilityTitle: 'Run an app action',
    tier: 'act',
    summary: 'Acme Search: Search the web for "Northwind pricing".',
    requestedBy: '/agents/kestrel',
    hasAgentPath: true,
    area: null,
    alwaysOffered: false,
    requestedAt: '2026-11-14T12:00:00.000Z',
    expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
    serviceAction: {
      serviceId: 'tavily',
      serviceName: 'Acme Search',
      accountLabel: 'Team account',
      actionName: 'Search the web',
      details: [{ label: 'Query', value: 'Northwind pricing' }],
      keptCardBecause: 'spend',
      spend,
    },
  };
}

const CARDS: { label: string; approval: PendingApproval }[] = [
  {
    label: 'Your price, under a limit',
    approval: paidCard('01JZSPEND00000000000000001', {
      priceMicro: micro(0.3),
      priceSource: 'person',
      limitMicro: LIMIT,
      leftMicro: micro(27.6),
      currency: 'USD',
    }),
  },
  {
    label: 'Price unknown, no limit (with Set a limit)',
    approval: paidCard('01JZSPEND00000000000000002', {
      priceMicro: null,
      priceSource: null,
      limitMicro: null,
      leftMicro: null,
      currency: 'USD',
    }),
  },
];

/** The Spending block's states, the paid-run card and the marker. */
export function SpendingShowcases() {
  return (
    <>
      <PlaygroundSection
        title="Spending"
        description="Connections → Spending: one monthly limit for what agents spend on paid app actions. With no limit, every paid action asks first. Thresholds change the words, never the colour."
      >
        <ShowcaseDemo responsive>
          <div className="space-y-6">
            {STATES.map((state) => (
              <BlockState key={state.label} label={state.label} summary={state.summary} />
            ))}
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>
      <PlaygroundSection
        title="Paid-run card"
        description="The card an agent's paid action waits on: its price and what is left, Allow once and Don't allow, never Always allow. Set a limit opens Spending."
      >
        <ShowcaseDemo responsive>
          <div className="space-y-6">
            {CARDS.map((card) => (
              <div key={card.label} className="space-y-2">
                <ShowcaseLabel>{card.label}</ShowcaseLabel>
                <Spending summary={month({})}>
                  <ApprovalCard approval={card.approval} />
                </Spending>
              </div>
            ))}
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>
      <PlaygroundSection
        title="Spends money marker"
        description="A muted Coins icon and its words wherever an action that spends money is named: a pill in lists and on the card, the icon alone at the end of a chip, and a line on an app row."
      >
        <ShowcaseDemo responsive>
          <div className="flex flex-wrap items-center gap-4">
            <PaidActionMarker />
            <span className="bg-muted inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs">
              Search the web
              <PaidActionMarker variant="icon" />
            </span>
            <PaidActionMarker variant="line" label="Actions spend money" />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
