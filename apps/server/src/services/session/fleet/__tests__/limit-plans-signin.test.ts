/**
 * An automatic move never lands on a Claude sign-in DorkOS may not pick on its
 * own (DOR-3245, Security's old M1): the advisor's `auto` plan degrades to
 * `ask`, a planned move whose target's sign-in changed during the countdown
 * fails when it fires (AUTO_MOVE_FAILED, nothing carried over), core's own
 * ranking offers it last and not eligible, and room reseat skips it. Keeping
 * the sign-in makes it eligible again.
 *
 * The same shape as `limit-plans-eligibility.test.ts`, with the sign-in check
 * as the one double that changes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { Db } from '@dorkos/db';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import type { AccountAdvisor } from '@dorkos/extension-api/server';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../flow-run-link.js', () => ({ flowRunsFor: vi.fn(async () => new Map()) }));
vi.mock('../../launch/launch-session.js', () => ({
  dispatchSessionMessage: vi.fn(),
  isSessionLaunchRefusal: (r: object) => 'refused' in r,
  isAgentLaunchCapFull: vi.fn(() => false),
}));
vi.mock('../../../notifications/emitters/session-lifecycle.js', () => ({
  notifyAutoMoveFailed: vi.fn(),
}));

/** The stored `runtimes.claudeCode` block the account rules are read from. */
let claudeCode: Record<string, unknown> = {};

vi.mock('../../../core/config-manager.js', () => ({
  configManager: { get: (key: string) => (key === 'runtimes' ? { claudeCode } : undefined) },
}));

const CWD = '/work/project';
const PROJECT = { root: CWD, name: 'project' };

vi.mock('../../../core/usage/account-eligibility.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/usage/account-eligibility.js')>()),
  projectOfFolder: vi.fn(async (cwd: string | null | undefined) => (cwd === CWD ? PROJECT : null)),
}));

/** Folders whose sign-in is new or changed, set per test. */
const unconfirmed = new Set<string>();
vi.mock('../../../runtimes/claude-code/accounts/account-login-metadata.js', async (original) => ({
  ...(await original<
    typeof import('../../../runtimes/claude-code/accounts/account-login-metadata.js')
  >()),
  mayAutoPickClaudeRoot: (root: string) => !unconfirmed.has(root),
}));

import { dispatchSessionMessage } from '../../launch/launch-session.js';
import { notifyAutoMoveFailed } from '../../../notifications/emitters/session-lifecycle.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import {
  __resetAccountAdvisorForTests,
  registerAccountAdvisor,
} from '../../../core/usage/account-advisor.js';
import { setAccountUsageStore } from '../../../core/usage/current-usage-store.js';
import type { AccountUsageStore } from '../../../core/usage/account-usage-store.js';
import type { RuntimeAccount } from '../../../core/usage/runtime-accounts.js';
import { SessionLimitStore, setSessionLimitStore } from '../session-limit-store.js';
import { planNewLimit, startLimitPlanning } from '../limit-plans.js';
import {
  coreRanking,
  rankAccounts,
  SIGNIN_NEEDS_REVIEW_REASON,
} from '../../../core/usage/account-ranking.js';
import { pickReseatAccount } from '../../../rooms/reseat/reseat-accounts.js';
import { installContinueService } from '../continue-service.js';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const SINCE = '2026-09-27T11:59:00.000Z';
const RESETS = '2026-09-27T17:00:00.000Z';

let db: Db;
let store: SessionLimitStore;
let stopPlanning: () => void;
let uninstall: () => void;

interface AccountFixture {
  id: string;
  state?: AccountUsage['state'];
  weekly?: number;
}

const FIXTURES: AccountFixture[] = [
  { id: 'main', state: 'limited', weekly: 100 },
  { id: 'spare', weekly: 40 },
  { id: 'busy', weekly: 90 },
];

function usageOf(f: AccountFixture): AccountUsage {
  const state = f.state ?? 'ok';
  return {
    runtime: 'claude-code',
    accountId: f.id,
    path: `/accounts/${f.id}`,
    label: f.id.toUpperCase(),
    color: '#123456',
    subscriptionType: null,
    plan: null,
    credits: null,
    spend: null,
    windows: [
      {
        key: 'seven_day',
        label: 'Weekly',
        usedPct: f.weekly ?? 0,
        resetsAt: null,
        status: null,
        expired: false,
        observedAt: '2026-09-27T00:00:00.000Z',
        source: 'sdk_event',
      },
    ],
    state,
    limit: state === 'limited' ? { window: 'seven_day', resetsAt: RESETS } : null,
    updatedAt: null,
  };
}

function runtimeAccount(f: AccountFixture): RuntimeAccount {
  return {
    runtime: 'claude-code',
    id: f.id,
    path: `/accounts/${f.id}`,
    canonicalPath: `/accounts/${f.id}`,
    label: f.id.toUpperCase(),
    color: '#123456',
    storedColor: null,
    routable: true,
    implicit: false,
    isDefault: false,
    ledgerId: f.id,
  };
}

function installUsageStore(): void {
  const byId = (runtime: string) => (runtime === 'claude-code' ? FIXTURES : []);
  setAccountUsageStore({
    listAccounts: (runtime: string) => byId(runtime).map(runtimeAccount),
    usageOfAccount: (a: RuntimeAccount) => usageOf(FIXTURES.find((f) => f.id === a.id)!),
    peek: (runtime: string, ids: readonly string[]) =>
      byId(runtime)
        .filter((f) => ids.includes(f.id))
        .map(usageOf),
    usageAtPath: () => null,
    onChange: () => () => undefined,
  } as unknown as AccountUsageStore);
}

/** An advisor that plans `auto` to `spare` in 60 s, without claiming the session. */
function adviseAutoToSpare(): void {
  registerAccountAdvisor('flow', {
    rank: async () => ({
      accounts: [
        { id: 'spare', eligible: true, reason: 'fine' },
        { id: 'busy', eligible: true, reason: 'fine' },
      ],
      recommendedId: 'spare',
    }),
    onLimited: async () => ({ mode: 'auto', target: 'spare', delaySeconds: 60 }),
  } as AccountAdvisor);
}

/** A Claude Code session started here, limited on `main`, planned. */
async function limitedSession(id: string): Promise<void> {
  await runtimeRegistry.persistSessionRuntime(id, 'claude-code', { kind: 'interactive' } as never);
  store.upsert({
    sessionId: id,
    limit: {
      accountId: 'main',
      window: 'seven_day',
      resetsAt: RESETS,
      since: SINCE,
      plan: { mode: 'ask' },
      scope: 'account',
      state: 'limited',
    },
    scope: 'account',
    accountPath: '/accounts/main',
    cwd: CWD,
  });
  await planNewLimit(id, SINCE);
}

function plan(id: string) {
  return store.get(id)?.limit.plan;
}

const SPARE = '/accounts/spare';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(NOW);
  db = createTestDb();
  store = new SessionLimitStore(db, () => new Date());
  setSessionLimitStore(store);
  runtimeRegistry.setDb(db);
  runtimeRegistry.register(new FakeAgentRuntime('claude-code') as never);
  __resetAccountAdvisorForTests();
  claudeCode = {};
  unconfirmed.clear();
  installUsageStore();
  vi.mocked(dispatchSessionMessage).mockReset();
  vi.mocked(dispatchSessionMessage).mockImplementation(
    async () =>
      ({
        accepted: true,
        canonicalId: 'new-1',
        outcome: { kind: 'started', messageId: 'm' },
        queued: false,
        queuePosition: 0,
      }) as never
  );
  vi.mocked(notifyAutoMoveFailed).mockClear();
  stopPlanning = startLimitPlanning({ now: () => new Date() });
  uninstall = installContinueService({});
});

afterEach(() => {
  stopPlanning();
  uninstall();
  setSessionLimitStore(undefined);
  setAccountUsageStore(undefined);
  __resetAccountAdvisorForTests();
  vi.useRealTimers();
});

describe('automatic moves and a sign-in that needs a look', () => {
  it("the advisor's auto plan to a new or changed sign-in degrades to ask", async () => {
    unconfirmed.add(SPARE);
    adviseAutoToSpare();
    await limitedSession('src-1');
    expect(plan('src-1')).toEqual({ mode: 'ask' });
  });

  it('a move whose target changed sign-in before it fired fails and carries nothing over', async () => {
    adviseAutoToSpare();
    await limitedSession('src-1');
    expect(plan('src-1')).toMatchObject({ mode: 'auto', target: 'spare' });

    unconfirmed.add(SPARE);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(plan('src-1')).toEqual({ mode: 'ask' }));
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
    expect(notifyAutoMoveFailed).toHaveBeenCalledTimes(1);
  });

  it('control: once the sign-in is kept, the same move goes through', async () => {
    adviseAutoToSpare();
    await limitedSession('src-1');
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(plan('src-1')?.mode).toBe('continued'));
    expect(vi.mocked(dispatchSessionMessage).mock.calls[0]![0].request).toMatchObject({
      account: 'spare',
    });
  });

  it("core's ranking offers it last, not eligible, with the reason; the advisor cannot lift it", async () => {
    unconfirmed.add(SPARE);
    const core = coreRanking('claude-code', null);
    const spare = core.find((row) => row.id === 'spare')!;
    expect(spare).toMatchObject({ eligible: false, reason: SIGNIN_NEEDS_REVIEW_REASON });
    expect(core.at(-1)?.id).toBe('spare');

    adviseAutoToSpare();
    const advised = await rankAccounts({
      purpose: 'continue',
      caller: 'advisor',
      cwd: CWD,
      runtime: 'claude-code',
      excludeAccountId: 'main',
    });
    expect(advised.accounts.find((row) => row.id === 'spare')?.eligible).toBe(false);
    expect(advised.recommendedId).toBe('busy');
  });

  it('room reseat never picks it', () => {
    const seat = { runtime: 'claude-code', currentAccountId: 'main' };
    // Control: with its sign-in confirmed, `spare` is the seat's next account.
    expect(pickReseatAccount(coreRanking('claude-code', null), seat)).toMatchObject({
      kind: 'move',
      account: { id: 'spare' },
    });
    unconfirmed.add(SPARE);
    const pick = pickReseatAccount(coreRanking('claude-code', null), seat);
    expect(pick.kind === 'move' ? pick.account.id : null).not.toBe('spare');
  });
});
