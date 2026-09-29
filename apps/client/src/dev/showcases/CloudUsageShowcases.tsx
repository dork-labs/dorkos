import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { CloudUsageResponse } from '@dorkos/shared/cloud-schemas';
import balanceFixture from '@dork-labs/cloud-api/fixtures/v1/billing/balance-denominated.json' with { type: 'json' };
import entitlementsFixture from '@dork-labs/cloud-api/fixtures/v1/billing/entitlements-denominated.json' with { type: 'json' };
import usageFixture from '@dork-labs/cloud-api/fixtures/v1/billing/usage-denominated.json' with { type: 'json' };
import usageWithOtherChargesFixture from '@dork-labs/cloud-api/fixtures/v1/billing/usage-with-other-charges.json' with { type: 'json' };
import { TransportProvider } from '@/layers/shared/model';
import { CreditsGauge } from '@/layers/features/cloud-plan';
import { createPlaygroundTransport } from '../playground-transport';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';

/*
 * The credits card from Settings, drawn from the contract package's own
 * synthetic fixtures, so every name, unit and figure on it is what a service
 * would send and none of it is a real catalog value.
 */

/** A linked account whose usage read answers `usage`, around the real card. */
function LinkedCard({ usage }: { usage: CloudUsageResponse }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  const [transport] = useState<Transport>(() => {
    // A Proxy, not a spread: the playground transport is itself a Proxy over
    // an empty target, so `{ ...base }` would copy nothing.
    const base = createPlaygroundTransport();
    const answers: Record<string, unknown> = {
      getCloudPlan: {
        available: true,
        entitlements: entitlementsFixture,
        balance: balanceFixture,
      },
      getCloudUsage: usage,
    };
    return new Proxy(base, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && prop in answers) {
          return () => Promise.resolve(answers[prop]);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  });
  return (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <CreditsGauge />
      </TransportProvider>
    </QueryClientProvider>
  );
}

/** One labelled state. */
function State({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <ShowcaseLabel>{label}</ShowcaseLabel>
      {children}
    </div>
  );
}

/** The credits card, with and without charges that are not inference. */
export function CloudUsageShowcases() {
  return (
    <PlaygroundSection
      title="Credits and other charges"
      description="The credits card on a linked DorkOS account. Charges that are not inference, like extra storage, list under Other charges with the service's own name and unit, and are never added to the credits total. With none, the card shows nothing extra."
    >
      <ShowcaseDemo responsive>
        {/* A block, not a grid: a grid column sizes to its widest unwrapped line, and
            the card truncates long names on one line. */}
        <div className="space-y-6">
          <State label="With other charges">
            <LinkedCard usage={{ available: true, usage: usageWithOtherChargesFixture as never }} />
          </State>
          <State label="Without (an older service, or nothing to charge)">
            <LinkedCard usage={{ available: true, usage: usageFixture as never }} />
          </State>
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
