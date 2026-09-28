/**
 * The sidebar's account dot and its out-of-usage rows (spec `claude-account-ui`
 * §6.2, §13).
 *
 * The dots are the REAL `AccountMark` with an injected row account, one per
 * palette color. The rows are the REAL `SessionRow`, full and compact, over a
 * transport that registers five Claude accounts, so the identity gate opens
 * exactly as it does in the app. Limits are built here in the shape
 * `createMockSessionLimit` produces (that factory imports `vitest`, so it
 * cannot run in the browser).
 *
 * @module dev/showcases/AccountMarkShowcases
 */
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_ACCOUNT_COLORS } from '@dorkos/shared/account-usage';
import type { SessionLimit } from '@dorkos/shared/session-stream';
import type { Transport } from '@dorkos/shared/transport';
import type { ServerConfig, Session } from '@dorkos/shared/types';
import { TransportProvider, seedAccountUsage } from '@/layers/shared/model';
import { AccountMark, SessionRow } from '@/layers/entities/session';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { createPlaygroundTransport } from '../playground-transport';
import { CLAUDE_CODE_CATALOG } from './model-picker-showcase-data';
import { MOCK_ACCOUNT_USAGE } from './account-mock-data';

/** The palette's color names, by position (spec §5). */
const PALETTE_NAMES = ['blue', 'green', 'amber', 'purple', 'pink', 'teal', 'indigo', 'stone'];

const HOUR_MS = 60 * 60 * 1000;

/** Five registered Claude accounts, as `GET /api/config` would report them. */
const ACCOUNTS_CONFIG = {
  claudeCode: {
    resolvedAccount: MOCK_ACCOUNT_USAGE[0]!.path,
    inherited: false,
    accounts: MOCK_ACCOUNT_USAGE.slice(0, 5).map((usage) => ({
      id: usage.accountId,
      path: usage.path,
      label: usage.label,
      color: usage.color,
      colorIsDefault: true,
      isAccountRoot: true,
    })),
  },
} as unknown as ServerConfig;

/** The playground transport, with the accounts read answered. */
function accountTransport(): Transport {
  const base = createPlaygroundTransport();
  return new Proxy(base, {
    get: (target, prop, receiver) => {
      if (prop === 'getConfig') return async () => ACCOUNTS_CONFIG;
      // The catalog gives a row's context gauge its window, so a row with a
      // listed context reading draws a percent and an "as of" tooltip.
      if (prop === 'getModels') return async () => CLAUDE_CODE_CATALOG;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

/** Its own query cache, seeded with every account's usage as the session list would. */
function AccountsDemo({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedAccountUsage(client, MOCK_ACCOUNT_USAGE);
    return client;
  });
  const [transport] = useState(accountTransport);
  return (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

/** A limit on account `n`'s week, in S4's shape. */
function limitOn(
  n: number,
  state: SessionLimit['state'],
  plan: SessionLimit['plan']
): SessionLimit {
  return {
    accountId: `acct-${n}`,
    window: 'seven_day',
    resetsAt: new Date(Date.now() + 2 * 24 * HOUR_MS).toISOString(),
    since: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    plan,
    scope: 'account',
    state,
  };
}

/** A Claude Code session on account `n`. */
function sessionOn(n: number, id: string, title: string, limit: SessionLimit | null): Session {
  const usage = MOCK_ACCOUNT_USAGE[n - 1]!;
  const updatedAt = new Date(Date.now() - n * 7 * 60 * 1000).toISOString();
  return {
    id,
    title,
    createdAt: updatedAt,
    updatedAt,
    permissionMode: 'default',
    runtime: 'claude-code',
    accountId: usage.accountId ?? undefined,
    account: usage.path,
    ...(limit ? { status: { lifecycle: 'idle' as const, limit } } : {}),
  };
}

const ROWS: { label: string; session: Session }[] = [
  {
    label: 'Healthy: the dot leads the title',
    session: sessionOn(2, 'account-mark-ok', 'DOR-2353 memory stamps', null),
  },
  {
    label: 'Out, handing off (plan auto): red tint, “out · handing off”',
    session: sessionOn(
      4,
      'account-mark-handing-off',
      'DOR-2361 issuer column',
      limitOn(4, 'handing-off', {
        mode: 'auto',
        target: 'acct-2',
        fireAt: new Date(Date.now() + 30_000).toISOString(),
      })
    ),
  },
  {
    label: 'Out, waiting for the person to choose (plan ask): red tint, “out · needs you”',
    session: sessionOn(
      4,
      'account-mark-limited',
      'DOR-2360 CI flake',
      limitOn(4, 'limited', { mode: 'ask' })
    ),
  },
  {
    label: 'Chose to wait for the reset: no tint, “out · waiting for reset” (Q13)',
    session: sessionOn(
      3,
      'account-mark-waiting',
      'Main · groom check',
      limitOn(3, 'waiting-reset', {
        mode: 'waiting',
        resumeAt: new Date(Date.now() + 2 * 24 * HOUR_MS).toISOString(),
        autoResume: false,
      })
    ),
  },
  {
    label: 'Moved to another account: no tint and no text (Q14)',
    session: sessionOn(
      4,
      'account-mark-moved',
      'DOR-2362 old session',
      limitOn(4, 'moved', { mode: 'continued', sessionId: 'account-mark-ok', accountId: 'acct-2' })
    ),
  },
];

/** A sidebar-width column on the sidebar's own surface. */
function SidebarColumn({ children }: { children: ReactNode }) {
  return <div className="bg-sidebar w-64 space-y-0.5 rounded-md p-1">{children}</div>;
}

/** The account dot on its own, and on full and compact session rows. */
export function AccountMarkShowcase() {
  return (
    <PlaygroundSection
      title="AccountMark"
      description="With two or more Claude accounts, every Claude Code session row leads its title with a dot in its account's color; the row's tooltip names the account. A session that ran out says so where its time sits."
    >
      <ShowcaseLabel>A dot per palette color (hover for the name)</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-wrap items-center gap-4">
          {DEFAULT_ACCOUNT_COLORS.map((color, i) => (
            <span key={color} className="flex items-center gap-1.5 text-xs">
              <AccountMark
                account={{
                  visible: true,
                  name: `Acct ${i + 1}`,
                  color,
                  limitStatus: null,
                  limitDisplay: null,
                }}
              />
              {PALETTE_NAMES[i]}
            </span>
          ))}
        </div>
      </ShowcaseDemo>

      <AccountsDemo>
        <ShowcaseLabel>{`Rows, top to bottom: ${ROWS.map((row) => row.label).join('; ')}.`}</ShowcaseLabel>
        <ShowcaseLabel>Full rows</ShowcaseLabel>
        <ShowcaseDemo>
          <SidebarColumn>
            {ROWS.map(({ session }) => (
              <SessionRow
                key={session.id}
                variant="full"
                session={session}
                isActive={false}
                onClick={() => {}}
                // As the sidebar renders it, so the rename button is on the
                // page for the axe gate and the keyboard to reach.
                onRename={() => {}}
              />
            ))}
          </SidebarColumn>
        </ShowcaseDemo>
        <ShowcaseLabel>
          A full row with a context reading from the list: hover the ring for how old it is
        </ShowcaseLabel>
        <ShowcaseDemo>
          <SidebarColumn>
            <SessionRow
              variant="full"
              session={{
                ...sessionOn(1, 'context-row', 'Long refactor', null),
                model: 'claude-opus-4-6',
                contextTokens: 170_000,
              }}
              isActive={false}
              onClick={() => {}}
              onRename={() => {}}
            />
          </SidebarColumn>
        </ShowcaseDemo>
        <ShowcaseLabel>Compact rows</ShowcaseLabel>
        <ShowcaseDemo>
          <SidebarColumn>
            {ROWS.map(({ session }) => (
              <SessionRow
                key={session.id}
                variant="compact"
                session={session}
                isActive={false}
                onClick={() => {}}
              />
            ))}
          </SidebarColumn>
        </ShowcaseDemo>
        <ShowcaseLabel>
          Selected, out and needs you: the tint gives way to the selection, and the red words still
          read at 4.5:1
        </ShowcaseLabel>
        <ShowcaseDemo>
          <SidebarColumn>
            <SessionRow
              variant="compact"
              session={ROWS[2]!.session}
              isActive={true}
              onClick={() => {}}
            />
          </SidebarColumn>
        </ShowcaseDemo>
      </AccountsDemo>
    </PlaygroundSection>
  );
}
