/**
 * The out-of-usage banner and its transcript marker (spec `claude-account-ui`
 * §6.7, §13), in every state.
 *
 * Every banner is the REAL `AccountLimitBanner` with the session's account
 * handed in, and every marker is the REAL `ErrorMessageBlock` for a turn's
 * `rate_limit` error, over a playground transport whose `getLimitHistory`
 * answers each session with its own episode. The limits are built here in the
 * shape `createMockSessionLimit` produces (that factory imports `vitest`, so
 * it cannot run in the browser).
 *
 * @module dev/showcases/AccountLimitShowcases
 */
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import type { Transport } from '@dorkos/shared/transport';
import type { ServerConfig } from '@dorkos/shared/types';
import { TransportProvider, seedAccountUsage } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import type { LimitState, SessionLimitView } from '@/layers/shared/lib';
import { AccountLimitBanner, type LimitBannerAccount } from '@/layers/features/continue-on-account';
import { ErrorMessageBlock } from '@/layers/features/chat';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { createPlaygroundTransport } from '../playground-transport';
import { MOCK_ACCOUNT_USAGE, MOCK_LIMIT_STOPPED_AT } from './account-mock-data';
import { CLAUDE_CODE_CATALOG } from './model-picker-showcase-data';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** The Claude account at `n` (from 1) in {@link MOCK_ACCOUNT_USAGE}. */
function claudeUsage(n: number): AccountUsage {
  return MOCK_ACCOUNT_USAGE[n - 1]!;
}

/** The next Tuesday at 3pm local time. */
function nextTuesday3pm(): string {
  const date = new Date();
  date.setHours(15, 0, 0, 0);
  date.setDate(date.getDate() + ((2 - date.getDay() + 7) % 7 || 7));
  return date.toISOString();
}

/** An instant `ms` from now. */
function fromNow(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/** A limit on Acct 3's week in `state`, in S4's shape. */
function sessionLimit(
  state: LimitState,
  overrides: Partial<SessionLimitView> = {}
): SessionLimitView {
  return {
    accountId: 'acct-3',
    window: 'seven_day',
    resetsAt: nextTuesday3pm(),
    since: fromNow(-MINUTE_MS),
    plan: { mode: 'ask' },
    scope: 'account',
    state,
    ...overrides,
  };
}

/** A Claude session on Acct 3 with two or more accounts (the gate open). */
function onAcct3(limit: SessionLimitView): LimitBannerAccount {
  return {
    visible: true,
    runtime: 'claude-code',
    accountId: 'acct-3',
    name: 'Acct 3',
    limit,
    trackerItem: null,
  };
}

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

/** The playground transport with the accounts and Claude's models answered. */
function limitTransport(): Transport {
  const base = createPlaygroundTransport();
  return new Proxy(base, {
    get: (target, prop, receiver) => {
      if (prop === 'getConfig') return async () => ACCOUNTS_CONFIG;
      if (prop === 'getModels') return async () => CLAUDE_CODE_CATALOG;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

/** One query cache and transport for a section, seeded as the session list would. */
function LimitDemo({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedAccountUsage(client, MOCK_ACCOUNT_USAGE);
    return client;
  });
  const [transport] = useState(limitTransport);
  return (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>{children}</TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

/** One labelled banner. */
function BannerVariant({
  label,
  id,
  account,
}: {
  label: string;
  id: string;
  account: LimitBannerAccount;
}) {
  return (
    <>
      <ShowcaseLabel>{label}</ShowcaseLabel>
      <ShowcaseDemo>
        <AccountLimitBanner
          sessionId={`playground-banner-${id}`}
          account={account}
          onSend={() => undefined}
        />
      </ShowcaseDemo>
    </>
  );
}

/** The banner in every state of spec §6.7. */
export function AccountLimitBannerShowcases() {
  // Built once per mount, so the countdown counts from when the page opened.
  const [limits] = useState(() => ({
    limited: sessionLimit('limited'),
    fiveHour: sessionLimit('limited', { window: 'five_hour', resetsAt: fromNow(47 * MINUTE_MS) }),
    handingOff: sessionLimit('handing-off', {
      plan: { mode: 'auto', target: 'acct-1', fireAt: fromNow(10_000) },
    }),
    handedToFlow: sessionLimit('handing-off', {
      plan: { mode: 'auto', target: 'acct-1', fireAt: fromNow(-5_000) },
    }),
    allOut: sessionLimit('all-accounts-out', {
      allOut: { accountId: 'acct-5', resetsAt: fromNow(2 * 24 * HOUR_MS) },
    }),
    modelLimited: sessionLimit('model-limited', {
      scope: 'model',
      window: 'seven_day_opus',
      modelFallback: 'claude-sonnet-4-6',
    }),
    waiting: sessionLimit('waiting-reset', {
      plan: { mode: 'waiting', resumeAt: fromNow(HOUR_MS + 12 * MINUTE_MS), autoResume: true },
    }),
    waitingOnly: sessionLimit('waiting-reset', {
      plan: { mode: 'waiting', resumeAt: null, autoResume: false, carryOver: false },
    }),
    ready: sessionLimit('reset-ready', {
      plan: { mode: 'waiting', resumeAt: fromNow(-MINUTE_MS), autoResume: false },
    }),
    unconfirmed: sessionLimit('reset-ready', {
      plan: {
        mode: 'waiting',
        resumeAt: fromNow(-MINUTE_MS),
        autoResume: false,
        unconfirmed: true,
      },
    }),
    moved: sessionLimit('moved', {
      plan: { mode: 'continued', sessionId: 'session-moved', accountId: 'acct-1' },
    }),
    oneAccount: sessionLimit('wait-only'),
    codex: sessionLimit('wait-only', {
      accountId: 'default',
      window: 'five_hour',
      resetsAt: fromNow(2 * HOUR_MS),
      plan: { mode: 'ask', carryOver: false },
    }),
  }));

  return (
    <PlaygroundSection
      title="AccountLimitBanner"
      description="Above the message box while a session's account is out: who ran out, until when, and what to do. Red while the person needs to act; grey once they chose to wait, the reset is ready, or the work moved."
    >
      <LimitDemo>
        <BannerVariant
          label="limited — a weekly window"
          id="limited"
          account={onAcct3(limits.limited)}
        />
        <BannerVariant
          label="limited — the 5-hour window"
          id="five-hour"
          account={onAcct3(limits.fiveHour)}
        />
        <BannerVariant
          label="handing-off — counting down to flow's move"
          id="handing-off"
          account={onAcct3(limits.handingOff)}
        />
        <BannerVariant
          label="handing-off — after Move now on a flow run (no digits)"
          id="handed-to-flow"
          account={onAcct3(limits.handedToFlow)}
        />
        <BannerVariant
          label="wait-only — one Claude account"
          id="one-account"
          account={{ ...onAcct3(limits.oneAccount), visible: false }}
        />
        <BannerVariant
          label="wait-only — Codex"
          id="codex"
          account={{
            visible: false,
            runtime: 'codex',
            accountId: 'default',
            name: null,
            limit: limits.codex,
            trackerItem: null,
          }}
        />
        <BannerVariant label="all-accounts-out" id="all-out" account={onAcct3(limits.allOut)} />
        <BannerVariant label="model-limited" id="model" account={onAcct3(limits.modelLimited)} />
        <BannerVariant
          label="waiting-reset — with the checkbox"
          id="waiting"
          account={onAcct3(limits.waiting)}
        />
        <BannerVariant
          label="waiting-reset — a session that can only wait (no checkbox)"
          id="waiting-only"
          account={onAcct3(limits.waitingOnly)}
        />
        <BannerVariant label="reset-ready — confirmed" id="ready" account={onAcct3(limits.ready)} />
        <BannerVariant
          label="reset-ready — unconfirmed"
          id="unconfirmed"
          account={onAcct3(limits.unconfirmed)}
        />
        <BannerVariant label="moved" id="moved" account={onAcct3(limits.moved)} />
      </LimitDemo>
    </PlaygroundSection>
  );
}

/** One labelled marker: the turn's `rate_limit` error as the transcript renders it. */
function MarkerVariant({ label, id }: { label: string; id: string }) {
  return (
    <>
      <ShowcaseLabel>{label}</ShowcaseLabel>
      <ShowcaseDemo>
        <ErrorMessageBlock
          message="You've hit your weekly limit · resets Tue 3pm"
          code="rate_limit"
          sessionId={`playground-marker-${id}`}
          at={MOCK_LIMIT_STOPPED_AT}
        />
      </ShowcaseDemo>
    </>
  );
}

/** The marker for each way an episode ends. */
export function AccountLimitMarkerShowcases() {
  return (
    <PlaygroundSection
      title="AccountLimitMarker"
      description="What a turn that ran out of usage leaves in the transcript once the episode is over: one muted line saying how it ended. An episode older than the history keeps the plain error card."
    >
      <LimitDemo>
        <MarkerVariant label="moved" id="moved" />
        <MarkerVariant label="resumed after the reset" id="reset" />
        <MarkerVariant label="resumed on another model" id="model" />
        <MarkerVariant label="resumed early (Continue here anyway)" id="early" />
        <MarkerVariant label="Codex, resumed early" id="codex" />
        <MarkerVariant label="no history row — the plain error card" id="none" />
      </LimitDemo>
    </PlaygroundSection>
  );
}
