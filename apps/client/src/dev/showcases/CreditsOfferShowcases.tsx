/**
 * A runtime's connect step when nothing works yet: DorkOS credits first, the
 * runtime's own ways right under it (spec `dorkos-account-by-default` §3).
 *
 * The REAL connect flow and the REAL credits card, over a query cache seeded
 * with what the server would report, so every state is reachable without a
 * server or a DorkOS account. Nothing here can start a link or spend: the
 * playground transport answers every call with nothing.
 *
 * @module dev/showcases/CreditsOfferShowcases
 */
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SystemRequirements } from '@dorkos/shared/agent-runtime';
import type { CloudCreditsStatus, CloudPlanResponse } from '@dorkos/shared/cloud-schemas';
import { cloudCreditsKeys, CreditsOfferProvider } from '@/layers/shared/model';
import { REQUIREMENTS_KEY } from '@/layers/entities/runtime';
import { cloudLinkStatusKey, cloudStatusKey } from '@/layers/features/cloud-link';
import { cloudPlanKeys } from '@/layers/features/cloud-plan';
import { RuntimeConnectFlow } from '@/layers/features/runtime-connect';
import { renderCreditsOffer } from '@/layers/widgets/credits-offer';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/** Claude Code installed, with no sign-in at all. */
const NO_SIGN_IN: SystemRequirements = {
  runtimes: {
    'claude-code': {
      state: 'connect',
      connect: { kind: 'login', label: 'Connect Claude Code' },
      dependencies: [
        { name: 'Claude Code CLI', description: 'Powers agent sessions.', status: 'satisfied' },
        { name: 'Claude Code authentication', description: 'Sign-in.', status: 'missing' },
      ],
    },
  },
};

/** The credits report: Claude Code wired, the others a follow-up. */
function credits(over: Partial<CloudCreditsStatus> = {}): CloudCreditsStatus {
  return {
    enabled: false,
    killed: false,
    linked: false,
    ready: false,
    runtimes: {
      'claude-code': 'wired',
      codex: 'follow-up',
      opencode: 'follow-up',
      doe: 'follow-up',
    },
    defaults: {},
    notices: [],
    ...over,
  };
}

/** A linked account whose included credits are all still there. */
const UNSPENT: CloudPlanResponse = {
  available: true,
  entitlements: {} as never,
  balance: {
    allowance: {
      grantedMicro: '5000000',
      remainingMicro: '5000000',
      resetsAt: '2026-11-01T00:00:00Z',
    },
    purchased: { remainingMicro: '0' },
    denomination: { unit: 'credit', microPerUnit: '1000000' },
  } as never,
};

/** One connect step over its own seeded cache, never refetched. */
function Seeded({
  report,
  linked = false,
  plan,
  children,
}: {
  report: CloudCreditsStatus;
  linked?: boolean;
  plan?: CloudPlanResponse;
  children: ReactNode;
}) {
  const [client] = useState(() => {
    const c = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false },
      },
    });
    c.setQueryData([...REQUIREMENTS_KEY], NO_SIGN_IN);
    c.setQueryData(cloudCreditsKeys.status(), report);
    c.setQueryData(cloudStatusKey, {
      linked,
      accountLabel: linked ? 'kai@dork.dev' : null,
      lastHeartbeatAt: null,
    });
    c.setQueryData(cloudLinkStatusKey, { state: linked ? 'linked' : 'idle' });
    if (plan) c.setQueryData(cloudPlanKeys.plan(), plan);
    return c;
  });
  return (
    <QueryClientProvider client={client}>
      <CreditsOfferProvider slot={renderCreditsOffer}>
        <div className="max-w-sm">{children}</div>
      </CreditsOfferProvider>
    </QueryClientProvider>
  );
}

const CLAUDE_CONNECT = { kind: 'login', label: 'Connect Claude Code' } as const;

/** The default-first connect step in its three states. */
export function CreditsOfferShowcases() {
  return (
    <PlaygroundSection
      title="Runtime connect: DorkOS credits first"
      description="Where a runtime has no sign-in at all and the server reports credits wired for it, its connect step leads with DorkOS credits and shows its own sign-in and a key as visible rows under it, with the line that nothing has to leave this computer. Signed out, choosing credits starts the link right there. Once its new work runs on credits, it says so and shows no card. Switch the viewport to Mobile to see the rows at phone width."
    >
      <ShowcaseLabel>Signed out, nothing works yet</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <Seeded report={credits()}>
          <RuntimeConnectFlow type="claude-code" connect={CLAUDE_CONNECT} />
        </Seeded>
      </ShowcaseDemo>
      <ShowcaseLabel>Signed in, included credits never spent</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <Seeded
          report={credits({ enabled: true, linked: true, ready: true })}
          linked
          plan={UNSPENT}
        >
          <RuntimeConnectFlow type="claude-code" connect={CLAUDE_CONNECT} />
        </Seeded>
      </ShowcaseDemo>
      <ShowcaseLabel>Its new work already runs on credits</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <Seeded
          report={credits({
            enabled: true,
            linked: true,
            ready: true,
            defaults: { 'claude-code': { runsOn: 'credits', chosenBy: 'default' } },
          })}
          linked
        >
          <RuntimeConnectFlow type="claude-code" connect={CLAUDE_CONNECT} />
        </Seeded>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
