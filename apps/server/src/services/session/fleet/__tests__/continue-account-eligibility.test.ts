/**
 * Continuing a limited session holds to the account rules (spec
 * `flow-multiproject` §8.4, D7): a person's own pick of an account that may not
 * work in the session's project is refused with the plain sentence, the
 * choices list that account disabled with its reason, and the carry-over
 * itself refuses an ineligible target whoever chose it (defence in depth).
 *
 * The same real `session_limits` / `session_metadata` tables and registry as
 * `continue-service.test.ts`; the rules live in a stand-in config, and the
 * session's folder is one project (`/work/project`), so the rules decide.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const rules = vi.hoisted(() => ({
  claudeCode: {} as Record<string, unknown>,
}));

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
vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'runtimes' ? { claudeCode: rules.claudeCode } : undefined),
    set: vi.fn(),
  },
}));
vi.mock('../../../core/usage/account-eligibility.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/usage/account-eligibility.js')>()),
  projectOfFolder: vi.fn(async (cwd: string | null | undefined) =>
    cwd === '/work/project' ? { root: '/work/project', name: 'project' } : null
  ),
}));

import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import { dispatchSessionMessage } from '../../launch/launch-session.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { __resetAccountAdvisorForTests } from '../../../core/usage/account-advisor.js';
import { setAccountUsageStore } from '../../../core/usage/current-usage-store.js';
import type { AccountUsageStore } from '../../../core/usage/account-usage-store.js';
import type { RuntimeAccount } from '../../../core/usage/runtime-accounts.js';
import { AccountNotAllowedError } from '../../../core/usage/account-eligibility.js';
import { SessionLimitStore, setSessionLimitStore } from '../session-limit-store.js';
import { planNewLimit, readStoredLimit, startLimitPlanning } from '../limit-plans.js';
import {
  continueOptions,
  continueSession,
  installContinueService,
  type ContinueLaunchDeps,
} from '../continue-service.js';
import { carryOverSession } from '../carry-over.js';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const SINCE = '2026-09-27T11:59:00.000Z';
const RESETS = '2026-09-27T17:00:00.000Z';

let store: SessionLimitStore;
let stopPlanning: () => void;
let uninstall: () => void;

const IDS = ['main', 'spare', 'client'] as const;

function usageOf(id: string): AccountUsage {
  const limited = id === 'main';
  return {
    runtime: 'claude-code',
    accountId: id,
    path: `/accounts/${id}`,
    label: id === 'client' ? 'Client Work' : id.toUpperCase(),
    color: '#123456',
    subscriptionType: null,
    plan: null,
    credits: null,
    spend: null,
    windows: [
      {
        key: 'seven_day',
        label: 'Weekly',
        usedPct: limited ? 100 : 30,
        resetsAt: null,
        status: null,
        expired: false,
        observedAt: '2026-09-27T00:00:00.000Z',
        source: 'sdk_event',
      },
    ],
    state: limited ? 'limited' : 'ok',
    limit: limited ? { window: 'seven_day', resetsAt: RESETS } : null,
    updatedAt: null,
  };
}

function runtimeAccount(id: string): RuntimeAccount {
  return {
    runtime: 'claude-code',
    id,
    path: `/accounts/${id}`,
    canonicalPath: `/accounts/${id}`,
    label: usageOf(id).label,
    color: '#123456',
    storedColor: null,
    routable: true,
    implicit: false,
    isDefault: false,
    ledgerId: id,
  };
}

function installUsageStore(): void {
  setAccountUsageStore({
    listAccounts: (runtime: string) =>
      runtime === 'claude-code' ? IDS.map((id) => runtimeAccount(id)) : [],
    usageOfAccount: (a: RuntimeAccount) => usageOf(a.id),
    peek: (_runtime: string, ids: readonly string[]) =>
      IDS.filter((id) => ids.includes(id)).map(usageOf),
    usageAtPath: () => null,
    onChange: () => () => undefined,
  } as unknown as AccountUsageStore);
}

const deps: ContinueLaunchDeps = {
  meshCore: undefined,
  roomSessionPlace: undefined,
  clientId: 'client-1',
  checkModel: vi.fn(async () => null),
};

async function limitedSession(id: string): Promise<void> {
  await runtimeRegistry.persistSessionRuntime(id, 'claude-code', {
    kind: 'interactive',
  } as never);
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
    cwd: '/work/project',
  });
  await planNewLimit(id, SINCE);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(NOW);
  // `client` is kept to another project; nothing else is restricted.
  rules.claudeCode = {
    accounts: [
      { id: 'spare', path: '/accounts/spare', label: 'SPARE', onlyProjects: null },
      {
        id: 'client',
        path: '/accounts/client',
        label: 'Client Work',
        onlyProjects: ['/clients/client-app'],
      },
    ],
    defaultAccountOnlyProjects: null,
    projectAccounts: {},
  };
  const db = createTestDb();
  store = new SessionLimitStore(db, () => new Date());
  setSessionLimitStore(store);
  runtimeRegistry.setDb(db);
  runtimeRegistry.register(new FakeAgentRuntime('claude-code') as never);
  __resetAccountAdvisorForTests();
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

describe('continueOptions', () => {
  it('lists an account that may not work here, disabled, with its reason', async () => {
    await limitedSession('src-1');
    const options = await continueOptions('src-1');
    const rows = options.ranking.accounts.map((a) => [a.id, a.eligible, a.reason ?? null]);
    expect(rows).toContainEqual(['client', false, 'Only for client-app']);
    // The allowed spare account is still offered, and is not the ineligible one.
    expect(rows.find(([id]) => id === 'spare')?.[1]).toBe(true);
    expect(rows.filter(([id]) => id === 'client')).toHaveLength(1);
    expect(options.ranking.recommendedId).not.toBe('client');
  });

  it('lists every account as eligible when no rule restricts one', async () => {
    (rules.claudeCode.accounts as Record<string, unknown>[])[1].onlyProjects = null;
    await limitedSession('src-1');
    const options = await continueOptions('src-1');
    expect(options.ranking.accounts.find((a) => a.id === 'client')?.eligible).toBe(true);
  });
});

describe('continueSession', () => {
  it("refuses a person's pick of an account that may not work in the project, and starts nothing", async () => {
    await limitedSession('src-1');
    const err = await rejection(continueSession('src-1', { account: 'client' }, deps));

    expect(err).toBeInstanceOf(AccountNotAllowedError);
    const refusal = err as AccountNotAllowedError;
    expect(refusal.status).toBe(409);
    expect(refusal.toBody()).toEqual({
      error: expect.stringContaining("Client Work can't be used in project"),
      message: refusal.message,
      code: 'account_not_allowed_here',
      project: { root: '/work/project', name: 'project' },
      accountId: 'client',
    });
    expect(refusal.message).toContain('only in client-app');
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
    expect(readStoredLimit('src-1')?.limit.plan).toEqual({ mode: 'ask' });
  });

  it("refuses an account the project's own list leaves out", async () => {
    rules.claudeCode.projectAccounts = { '/work/project': { allow: ['client'] } };
    (rules.claudeCode.accounts as Record<string, unknown>[])[1].onlyProjects = null;
    await limitedSession('src-1');
    const err = await rejection(continueSession('src-1', { account: 'spare' }, deps));
    expect(err).toBeInstanceOf(AccountNotAllowedError);
    expect((err as Error).message).toBe(
      "project isn't set to use SPARE. Pick another account, or remove project's account limit in Settings → Runtimes."
    );
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
  });

  it('continues on an eligible account (control)', async () => {
    await limitedSession('src-1');
    expect(await continueSession('src-1', { account: 'spare' }, deps)).toEqual({
      sessionId: 'new-1',
    });
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(1);
  });
});

describe('carryOverSession (defence in depth)', () => {
  it('throws AccountNotAllowedError for an ineligible target and dispatches nothing', async () => {
    await limitedSession('src-1');
    const source = readStoredLimit('src-1')!;
    const err = await rejection(
      carryOverSession({
        source,
        targetAccountId: 'client',
        by: 'advisor',
        launch: { meshCore: undefined, roomSessionPlace: undefined },
        activity: undefined,
      })
    );
    expect(err).toBeInstanceOf(AccountNotAllowedError);
    expect((err as AccountNotAllowedError).accountId).toBe('client');
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
  });

  it('carries over to an eligible target (control)', async () => {
    await limitedSession('src-1');
    const source = readStoredLimit('src-1')!;
    await expect(
      carryOverSession({
        source,
        targetAccountId: 'spare',
        by: 'advisor',
        launch: { meshCore: undefined, roomSessionPlace: undefined },
        activity: undefined,
      })
    ).resolves.toBe('new-1');
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(1);
  });
});
