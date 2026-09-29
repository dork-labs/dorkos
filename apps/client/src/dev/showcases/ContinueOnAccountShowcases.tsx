/**
 * The "Continue on another account" picker (spec `claude-account-ui` §6.6,
 * §13), in each shape the server's answer gives it.
 *
 * Every demo renders the REAL `ContinueOnAccountDialog` over a playground
 * transport whose `getContinueOptions` answers that variant, so nothing here
 * rebuilds the dialog's layout. The session is limited on Acct 3.
 *
 * @module dev/showcases/ContinueOnAccountShowcases
 */
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  AccountUsage,
  ContinueOptionAccount,
  ContinueOptionsResponse,
} from '@dorkos/shared/account-usage';
import type { Transport } from '@dorkos/shared/transport';
import type { ServerConfig } from '@dorkos/shared/types';
import { TransportProvider } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { ContinueOnAccountDialog } from '@/layers/features/continue-on-account';
import type { SessionTrackerItem } from '@/layers/features/status';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { createPlaygroundTransport } from '../playground-transport';
import { MOCK_ACCOUNT_USAGE } from './account-mock-data';

/** The Claude account at `n` (from 1) in {@link MOCK_ACCOUNT_USAGE}. */
function claudeUsage(n: number): AccountUsage {
  return MOCK_ACCOUNT_USAGE[n - 1]!;
}

/** Codex's implicit account, from the same fixtures. */
const CODEX_USAGE = MOCK_ACCOUNT_USAGE.find((usage) => usage.runtime === 'codex')!;

/** One row of the server's answer for Claude account `n`. */
function row(n: number, extra: Partial<ContinueOptionAccount> = {}): ContinueOptionAccount {
  const usage = claudeUsage(n);
  return {
    id: usage.accountId!,
    label: usage.label,
    color: usage.color,
    usage,
    eligible: true,
    reason: 'Has usage left.',
    runtime: 'claude-code',
    ...extra,
  };
}

/** An account that is out, as S4 reports it. */
function outRow(n: number): ContinueOptionAccount {
  return row(n, {
    eligible: false,
    reason: 'Out until Tue 3pm',
    usage: { ...claudeUsage(n), state: 'limited' },
  });
}

/** Acct 1 as flow's reserved Main. */
const RESERVED_MAIN = row(1, {
  label: 'Main',
  eligible: false,
  reason: 'kept in reserve (50%)',
  badge: 'reserved',
});

/** Without an advisor: S4's own order by weekly headroom, nothing hidden, no pill. */
const NO_ADVISOR: ContinueOptionsResponse = {
  plan: { mode: 'ask' },
  ranking: { accounts: [row(5), row(1), row(2), row(4)], recommendedId: 'acct-5' },
  advised: false,
};

/** With flow: Acct 5 recommended, Main reserved, Acct 4 kept out (not listed). */
const ADVISED: ContinueOptionsResponse = {
  plan: { mode: 'ask' },
  ranking: {
    accounts: [row(5, { badge: 'recommended' }), row(2), RESERVED_MAIN],
    recommendedId: 'acct-5',
  },
  advised: true,
};

/** With flow's cross-runtime fallback on: Codex's own sign-in joins as another runtime. */
const OTHER_RUNTIMES: ContinueOptionsResponse = {
  plan: { mode: 'ask' },
  ranking: {
    accounts: [
      row(5, { badge: 'recommended' }),
      row(2),
      {
        id: CODEX_USAGE.accountId!,
        label: null,
        color: CODEX_USAGE.color,
        usage: CODEX_USAGE,
        eligible: true,
        reason: 'Has usage left.',
        runtime: 'codex',
      },
    ],
    recommendedId: 'acct-5',
  },
  advised: true,
};

/** Every other account is out. */
const NOTHING: ContinueOptionsResponse = {
  plan: { mode: 'ask' },
  ranking: { accounts: [outRow(1), outRow(2), outRow(5)], recommendedId: null },
  advised: false,
};

/** Five registered Claude accounts, as `GET /api/config` would report them. */
const ACCOUNTS_CONFIG = {
  claudeCode: {
    resolvedAccount: claudeUsage(1).path,
    inherited: false,
    accounts: [1, 2, 3, 4, 5].map((n) => {
      const usage = claudeUsage(n);
      return {
        id: usage.accountId,
        path: usage.path,
        label: usage.label,
        color: usage.color,
        colorIsDefault: true,
        isAccountRoot: true,
      };
    }),
  },
} as unknown as ServerConfig;

/** A refusal in the server's words, as the transport rejects with it. */
function refusal(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

/** The playground transport answering this variant's options and, optionally, refusing to continue. */
function variantTransport(answer: ContinueOptionsResponse, continueError?: Error): Transport {
  const base = createPlaygroundTransport();
  return new Proxy(base, {
    get: (target, prop, receiver) => {
      if (prop === 'getConfig') return async () => ACCOUNTS_CONFIG;
      if (prop === 'getContinueOptions') return async () => answer;
      if (prop === 'continueSession' && continueError) {
        return async () => {
          throw continueError;
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

/** The one flow item the flow-run variants serve. */
const FLOW_ITEMS: readonly SessionTrackerItem[] = [
  {
    id: 'DOR-2353',
    stage: 'execute',
    runStatus: 'running',
    startedAt: '2026-09-27T16:00:00.000Z',
    via: 'this-chat',
    ownChatSessionId: null,
  },
];

/** One labelled variant: a button that opens the real picker over its own transport. */
function Variant({
  label,
  answer,
  trackerItems = [],
  continueError,
}: {
  label: string;
  answer: ContinueOptionsResponse;
  trackerItems?: readonly SessionTrackerItem[];
  continueError?: Error;
}) {
  const [open, setOpen] = useState(false);
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  const [transport] = useState(() => variantTransport(answer, continueError));
  return (
    <>
      <ShowcaseLabel>{label}</ShowcaseLabel>
      <ShowcaseDemo>
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              Open the picker
            </Button>
            <ContinueOnAccountDialog
              open={open}
              onOpenChange={setOpen}
              sessionId="playground-limited-session"
              account={{ runtime: 'claude-code', accountId: 'acct-3', limit: null, trackerItems }}
            />
          </TransportProvider>
        </QueryClientProvider>
      </ShowcaseDemo>
    </>
  );
}

/** The picker for each answer the server can give. */
export function ContinueOnAccountShowcases() {
  return (
    <PlaygroundSection
      title="ContinueOnAccountDialog"
      description="The picker a limited session opens to carry its work over to another account. Everything it shows comes from the server's answer: order, what is eligible, the recommended pill, and accounts flow keeps out."
    >
      <Variant
        label="No advisor — sorted by most usage left, no pill, nothing hidden"
        answer={NO_ADVISOR}
      />
      <Variant
        label="Advisor, flow run — recommended pill, Main reserved (dimmed, still selectable), Acct 4 kept out"
        answer={ADVISED}
        trackerItems={FLOW_ITEMS}
      />
      <Variant
        label="Advisor, not a flow run — new-chat wording without the sort sentence"
        answer={ADVISED}
      />
      <Variant label="Other runtimes — Codex's own sign-in" answer={OTHER_RUNTIMES} />
      <Variant label="Nothing to offer — every other account is out" answer={NOTHING} />
      <Variant
        label="Server error — Continue is refused and the reason shows inline"
        answer={ADVISED}
        trackerItems={FLOW_ITEMS}
        continueError={refusal('Flow could not be reached, so this was not changed.', 503)}
      />
    </PlaygroundSection>
  );
}
