/**
 * The status-bar account chip and its popover (spec `claude-account-ui` §6.1,
 * §13), in every state the chip can be in.
 *
 * Every demo renders the REAL `AccountItem` — the component the status line
 * mounts — with an injected `SessionAccount`, so the states can sit side by
 * side without a server. Usage comes from `MOCK_ACCOUNT_USAGE`; the session
 * limits are built here in the shape `createMockSessionLimit` produces (that
 * factory imports `vitest`, so it cannot run in the browser).
 *
 * @module dev/showcases/AccountChipShowcases
 */
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import type { Transport } from '@dorkos/shared/transport';
import type { ServerConfig } from '@dorkos/shared/types';
import { TransportProvider, seedAccountUsage } from '@/layers/shared/model';
import { AccountItem, type SessionAccount } from '@/layers/features/status';
import type { LimitState, SessionLimitView } from '@/layers/shared/lib';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { createPlaygroundTransport } from '../playground-transport';
import { MOCK_ACCOUNT_USAGE } from './account-mock-data';
import { CLAUDE_CODE_CATALOG } from './model-picker-showcase-data';

const MINUTE_MS = 60_000;

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

/** A session limit on `window`, in S4's shape with `state` and `scope`. */
function sessionLimit(
  state: LimitState,
  overrides: Partial<SessionLimitView> = {}
): SessionLimitView {
  return {
    accountId: 'acct-3',
    window: 'seven_day',
    resetsAt: nextTuesday3pm(),
    since: new Date().toISOString(),
    plan: { mode: 'ask' },
    scope: 'account',
    state,
    ...overrides,
  };
}

/** A started Claude session on the account at `n`, gate open. */
function onAccount(n: number, overrides: Partial<SessionAccount> = {}): SessionAccount {
  const usage = claudeUsage(n);
  return {
    visible: true,
    runtime: 'claude-code',
    accountId: usage.accountId,
    path: usage.path,
    name: usage.label,
    color: usage.color,
    usage,
    limit: null,
    chipState: 'ok',
    trackerItems: [],
    lifecycle: 'idle',
    pending: false,
    ...overrides,
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
        isAccountRoot: n !== 4,
      };
    }),
  },
} as unknown as ServerConfig;

/**
 * The playground transport with the three reads the chip makes answered: the
 * accounts, Claude's models, and no agent at the launch directory.
 */
function accountTransport(): Transport {
  const base = createPlaygroundTransport();
  return new Proxy(base, {
    get: (target, prop, receiver) => {
      if (prop === 'getConfig') return async () => ACCOUNTS_CONFIG;
      if (prop === 'getModels') return async () => CLAUDE_CODE_CATALOG;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

/** Its own query cache, seeded with every account's usage as the session list would. */
function AccountDemo({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedAccountUsage(client, MOCK_ACCOUNT_USAGE);
    return client;
  });
  const [transport] = useState(accountTransport);
  return (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        {/* The status line's own type scale. */}
        <div className="text-muted-foreground flex items-center text-xs">{children}</div>
      </TransportProvider>
    </QueryClientProvider>
  );
}

/** One chip, labelled. */
function Chip({
  label,
  account,
  onContinue,
}: {
  label: string;
  account: SessionAccount;
  onContinue?: () => void;
}) {
  return (
    <>
      <ShowcaseLabel>{label}</ShowcaseLabel>
      <ShowcaseDemo>
        <AccountDemo>
          <AccountItem
            sessionId="playground-account-chip"
            account={account}
            onContinue={onContinue}
          />
        </AccountDemo>
      </ShowcaseDemo>
    </>
  );
}

/** A 5-hour window close to its limit, for the near-on-5h chip. */
const NEAR_FIVE_HOUR: AccountUsage = {
  ...claudeUsage(2),
  windows: claudeUsage(2).windows.map((window) =>
    window.key === 'five_hour' ? { ...window, usedPct: 93 } : { ...window, usedPct: 40 }
  ),
};

/** Acct 1 after its 5-hour window reset: the server reads it at 0%, `expired`. */
const FIVE_HOUR_RESET: AccountUsage = {
  ...claudeUsage(1),
  windows: claudeUsage(1).windows.map((entry) =>
    entry.key === 'five_hour' ? { ...entry, usedPct: 0, status: null, expired: true } : entry
  ),
};

/** 47 minutes after the page loaded: the 5-hour window's reset, for the countdown chip. */
const IN_FORTY_SEVEN_MIN = new Date(Date.now() + 47 * MINUTE_MS).toISOString();

/** A label longer than a phone-width status bar can hold. */
const LONG_NAME = 'Client work for Acme Corporation Holdings';

/** The status-bar account chip in each state, then the pre-launch picker. */
export function AccountItemShowcases() {
  return (
    <PlaygroundSection
      title="AccountItem"
      description="The status-bar account chip: which Claude account a session spends and how much is left. It shows only with two or more accounts. Click a chip for its popover."
    >
      <Chip label="ok — the name and two usage bars (5-hour, week)" account={onAccount(1)} />
      <Chip
        label="reset — the 5-hour window reset; its popover row says so (click)"
        account={onAccount(1, { usage: FIVE_HOUR_RESET })}
      />
      <Chip
        label="unknown — no reading yet, never an empty 0%"
        account={onAccount(4, { chipState: 'unknown' })}
      />
      <Chip label="near — the week" account={onAccount(2, { chipState: 'near' })} />
      <Chip
        label="near — the 5-hour window"
        account={onAccount(2, { chipState: 'near', usage: NEAR_FIVE_HOUR })}
      />
      <Chip
        label="out — a weekly window"
        account={onAccount(3, { chipState: 'out', limit: sessionLimit('limited') })}
      />
      <Chip
        label="out — the 5-hour window, counting down"
        account={onAccount(3, {
          chipState: 'out',
          limit: sessionLimit('limited', { window: 'five_hour', resetsAt: IN_FORTY_SEVEN_MIN }),
        })}
      />
      <Chip
        label="out — no reset time"
        account={onAccount(3, {
          chipState: 'out',
          limit: sessionLimit('limited', { resetsAt: null }),
        })}
      />
      <Chip
        label="model-out — only Opus ran out, so amber"
        account={onAccount(5, {
          chipState: 'model-out',
          limit: sessionLimit('model-limited', {
            accountId: 'acct-5',
            scope: 'model',
            window: 'seven_day_opus',
          }),
        })}
      />
      <Chip
        label="A long name truncates first; near words stay whole"
        account={onAccount(2, { chipState: 'near', name: LONG_NAME })}
      />
      <Chip
        label="A long name truncates first; out words stay whole"
        account={onAccount(3, {
          chipState: 'out',
          name: LONG_NAME,
          limit: sessionLimit('limited'),
        })}
      />
      <Chip
        label="Before the first message — the account picker"
        account={onAccount(1, { pending: true, lifecycle: null })}
      />
    </PlaygroundSection>
  );
}

/** The popover behind the chip, with and without each optional part. */
export function AccountPopoverShowcases() {
  return (
    <PlaygroundSection
      title="AccountPopover"
      description="Click a chip to open its popover: one bar per usage window with when it resets, the flow item the session serves, and the continue action while the session is out."
    >
      <Chip label="With a plan" account={onAccount(1)} />
      <Chip label="Without a plan" account={onAccount(4, { chipState: 'unknown' })} />
      <Chip
        label="With a flow item"
        account={onAccount(1, {
          trackerItems: [
            {
              id: 'DOR-2353',
              stage: 'execute',
              runStatus: 'running',
              startedAt: '2026-09-27T16:00:00.000Z',
              via: 'this-chat',
              ownChatSessionId: null,
            },
          ],
        })}
      />
      <Chip label="With an extra window (Opus)" account={onAccount(5)} />
      <Chip
        label="Out, with the continue action"
        account={onAccount(3, { chipState: 'out', limit: sessionLimit('limited') })}
        onContinue={() => {}}
      />
    </PlaygroundSection>
  );
}
