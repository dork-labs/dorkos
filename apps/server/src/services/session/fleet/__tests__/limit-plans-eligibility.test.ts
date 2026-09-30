/**
 * An automatic move goes only to an account that may work in the session's
 * project (spec `flow-multiproject` §8.4): the advisor's `auto` plan degrades to
 * `ask` when its target may not work there, and a planned move whose target
 * stopped being allowed fails when it fires.
 *
 * The same shape as `continue-service.test.ts` (real limit store, fake usage
 * store, the launch spied on), with the config the rules live in and the
 * folder → project step as doubles.
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
import { installContinueService } from '../continue-service.js';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const SINCE = '2026-09-27T11:59:00.000Z';
const RESETS = '2026-09-27T17:00:00.000Z';
const FIRE_AT = new Date(NOW.getTime() + 60_000).toISOString();

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

/** Keep `spare` to `roots` (null = any project). */
function keepSpareTo(roots: string[] | null): void {
  claudeCode = {
    accounts: [
      { id: 'main', onlyProjects: null },
      { id: 'spare', onlyProjects: roots },
      { id: 'busy', onlyProjects: null },
    ],
  };
}

/** An advisor that plans `auto` to `spare` in 60 s, without claiming the session. */
function adviseAutoToSpare() {
  const rank = vi.fn<AccountAdvisor['rank']>(async () => ({
    accounts: [
      { id: 'spare', eligible: true, reason: 'fine' },
      { id: 'busy', eligible: true, reason: 'fine' },
    ],
    recommendedId: 'spare',
  }));
  registerAccountAdvisor('flow', {
    rank,
    onLimited: async () => ({ mode: 'auto', target: 'spare', delaySeconds: 60 }),
  } as AccountAdvisor);
  return rank;
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(NOW);
  db = createTestDb();
  store = new SessionLimitStore(db, () => new Date());
  setSessionLimitStore(store);
  runtimeRegistry.setDb(db);
  runtimeRegistry.register(new FakeAgentRuntime('claude-code') as never);
  __resetAccountAdvisorForTests();
  keepSpareTo(null);
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

describe("the advisor's auto plan (planEpisode)", () => {
  it("degrades to ask when the target may not work in the session's project", async () => {
    // Purpose: an unattended move must never land on an account kept to another project.
    keepSpareTo(['/elsewhere']);
    adviseAutoToSpare();
    await limitedSession('src-1');
    expect(plan('src-1')).toEqual({ mode: 'ask' });
  });

  it("degrades to ask when the project's allow list leaves the target out", async () => {
    // Purpose: the project side of the rule holds for advisor plans too.
    claudeCode = { projectAccounts: { [CWD]: { allow: ['busy'] } } };
    adviseAutoToSpare();
    await limitedSession('src-1');
    expect(plan('src-1')).toEqual({ mode: 'ask' });
  });

  it('keeps auto when the target may work in the project', async () => {
    // Purpose: control — the project is resolved from the session's folder and allows `spare`.
    keepSpareTo([CWD]);
    adviseAutoToSpare();
    await limitedSession('src-1');
    expect(plan('src-1')).toEqual({ mode: 'auto', target: 'spare', fireAt: FIRE_AT });
  });
});

describe("core's automatic handoff (fireAutoHandoff)", () => {
  it('drops to ask and starts nothing when the target stopped being allowed before it fired', async () => {
    // Purpose: the move re-checks at fire time; a rule changed during the countdown wins.
    const rank = adviseAutoToSpare();
    await limitedSession('src-1');
    expect(plan('src-1')).toMatchObject({ mode: 'auto', target: 'spare' });

    keepSpareTo(['/elsewhere']);
    rank.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(plan('src-1')).toEqual({ mode: 'ask' }));
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
    expect(notifyAutoMoveFailed).toHaveBeenCalledTimes(1);
    // The re-rank at fire time offered the advisor only accounts allowed here.
    const candidates = rank.mock.calls[0]![0];
    expect(candidates.map((c) => c.id)).not.toContain('spare');
  });

  it('moves the work when the target is still allowed', async () => {
    // Purpose: control — the same countdown with unchanged rules carries the work over.
    adviseAutoToSpare();
    await limitedSession('src-1');
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(plan('src-1')?.mode).toBe('continued'));
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dispatchSessionMessage).mock.calls[0]![0].request).toMatchObject({
      account: 'spare',
    });
  });
});
