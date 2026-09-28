/**
 * What a person can do when a session's account runs out, and how the account
 * advisor changes it (spec `claude-account-fleet` D9, §X "One writer for a
 * flow run").
 *
 * Real `session_limits` and `session_metadata` tables and the real runtime
 * registry; a fake runtime, a fake usage store, and the launch service
 * replaced by a spy (its own tests cover starting a session). What is pinned
 * here is the decision: which plan, which state, which session starts, and who
 * gets asked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { Db } from '@dorkos/db';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import type { AccountAdvisor } from '@dorkos/extension-api/server';
import type { HistoryMessage } from '@dorkos/shared/types';
import { SEED_CONTEXT_MAX_LENGTH, type SessionLimit } from '@dorkos/shared/schemas';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../flow-run-link.js', () => ({ flowRunsFor: vi.fn(async () => new Map()) }));
vi.mock('../../launch/launch-session.js', () => ({
  dispatchSessionMessage: vi.fn(),
  isSessionLaunchRefusal: (r: object) => 'refused' in r,
}));

import { dispatchSessionMessage } from '../../launch/launch-session.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import {
  ADVISOR_TIMEOUT_MS,
  __resetAccountAdvisorForTests,
  registerAccountAdvisor,
} from '../../../core/usage/account-advisor.js';
import { setAccountUsageStore } from '../../../core/usage/current-usage-store.js';
import type { AccountUsageStore } from '../../../core/usage/account-usage-store.js';
import type { RuntimeAccount } from '../../../core/usage/runtime-accounts.js';
import { recordContinuation } from '../../../core/usage/session-continuation.js';
import { disposeProjector, getOrCreateProjector } from '../../session-state-projector.js';
import { SessionLimitStore, setSessionLimitStore } from '../session-limit-store.js';
import {
  CLAIMED_HANDOFF_SETTLE_MS,
  planNewLimit,
  refreshLimitState,
  settleAutoPlansAtBoot,
  startLimitPlanning,
} from '../limit-plans.js';
import {
  ContinueError,
  FLOW_UNREACHABLE_MESSAGE,
  MODEL_CONTINUE_PROMPT,
  WAIT_ONLY_MESSAGE,
  cancelAutoContinue,
  continueOptions,
  continueSession,
  installContinueService,
  waitForReset,
  type ContinueLaunchDeps,
} from '../continue-service.js';
import { CARRY_OVER_PROMPT } from '../carry-over.js';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const SINCE = '2026-09-27T11:59:00.000Z';
const RESETS = '2026-09-27T17:00:00.000Z';

let db: Db;
let store: SessionLimitStore;
let runtime: FakeAgentRuntime;
let stopPlanning: () => void;
let uninstall: () => void;
const usedProjectors = new Set<string>();
let dispatchSeq = 0;

// --- The fake usage store ----------------------------------------------------

interface AccountFixture {
  id: string;
  state?: AccountUsage['state'];
  weekly?: number;
  resetsAt?: string | null;
  windows?: AccountUsage['windows'];
}

let accounts: AccountFixture[] = [];

function usageOf(f: AccountFixture): AccountUsage {
  const windows: AccountUsage['windows'] =
    f.windows ??
    (f.weekly === undefined
      ? []
      : [
          {
            key: 'seven_day',
            label: 'Weekly',
            usedPct: f.weekly,
            resetsAt: null,
            status: null,
            expired: false,
            observedAt: '2026-09-27T00:00:00.000Z',
            source: 'sdk_event',
          },
        ]);
  const state = f.state ?? (windows.length > 0 ? 'ok' : 'unknown');
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
    windows,
    state,
    limit: state === 'limited' ? { window: 'seven_day', resetsAt: f.resetsAt ?? null } : null,
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

const usageListeners = new Set<(u: AccountUsage) => void>();

function installUsageStore(fixtures: AccountFixture[]): void {
  accounts = fixtures;
  const fake = {
    listAccounts: () => accounts.map(runtimeAccount),
    usageOfAccount: (a: RuntimeAccount) => usageOf(accounts.find((f) => f.id === a.id)!),
    peek: (_runtime: string, ids: readonly string[]) =>
      accounts.filter((f) => ids.includes(f.id)).map(usageOf),
    usageAtPath: () => null,
    onChange: (listener: (u: AccountUsage) => void) => {
      usageListeners.add(listener);
      return () => usageListeners.delete(listener);
    },
  };
  setAccountUsageStore(fake as unknown as AccountUsageStore);
}

// --- Helpers ------------------------------------------------------------------

const deps: ContinueLaunchDeps = {
  meshCore: undefined,
  roomSessionPlace: undefined,
  clientId: 'client-1',
  checkModel: vi.fn(async () => null),
};

/**
 * A session bound under `origin` (or never bound through the launch write,
 * for `null`), holding a limit on account `main`, planned.
 */
async function limitedSession(
  id: string,
  opts: {
    origin?: string | null;
    window?: string;
    scope?: SessionLimit['scope'];
    accountId?: string | null;
    live?: boolean;
    runtime?: string;
  } = {}
): Promise<void> {
  const origin = opts.origin === undefined ? 'interactive' : opts.origin;
  if (origin !== null) {
    await runtimeRegistry.persistSessionRuntime(id, opts.runtime ?? 'claude-code', {
      kind: origin,
    } as never);
  }
  const window = opts.window ?? 'seven_day';
  store.upsert({
    sessionId: id,
    limit: {
      accountId: opts.accountId === undefined ? 'main' : opts.accountId,
      window,
      resetsAt: RESETS,
      since: SINCE,
      plan: { mode: 'ask' },
      scope: opts.scope ?? 'account',
      state: 'limited',
    },
    scope: opts.scope ?? 'account',
    accountPath: '/accounts/main',
    cwd: '/work/project',
  });
  if (opts.live) {
    usedProjectors.add(id);
    getOrCreateProjector(id, '/work/project');
  }
  await planNewLimit(id, SINCE);
}

function plan(id: string) {
  return store.get(id)?.limit.plan;
}

function state(id: string) {
  return store.get(id)?.limit.state;
}

async function refusal(promise: Promise<unknown>): Promise<ContinueError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ContinueError) return err;
    if (err && typeof err === 'object' && 'status' in err) return err as ContinueError;
    throw err;
  }
  throw new Error('expected a refusal');
}

function advise(advisor: Partial<AccountAdvisor>, owner = 'flow'): () => void {
  return registerAccountAdvisor(owner, {
    rank: vi.fn(async () => ({
      accounts: accounts
        .filter((a) => a.id !== 'main')
        .map((a) => ({ id: a.id, eligible: a.state !== 'limited', reason: 'fine' })),
      recommendedId: null,
    })),
    ...advisor,
  } as AccountAdvisor);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(NOW);
  db = createTestDb();
  store = new SessionLimitStore(db, () => new Date());
  setSessionLimitStore(store);
  runtimeRegistry.setDb(db);
  runtime = new FakeAgentRuntime('claude-code');
  runtimeRegistry.register(runtime as never);
  __resetAccountAdvisorForTests();
  installUsageStore([
    { id: 'main', state: 'limited', weekly: 100, resetsAt: RESETS },
    { id: 'spare', weekly: 40 },
    { id: 'busy', weekly: 90 },
  ]);
  dispatchSeq = 0;
  vi.mocked(dispatchSessionMessage).mockReset();
  vi.mocked(dispatchSessionMessage).mockImplementation(
    async (opts) =>
      ({
        accepted: true,
        canonicalId: opts.sessionId.startsWith('src') ? opts.sessionId : `new-${++dispatchSeq}`,
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
  for (const id of usedProjectors) disposeProjector(id);
  usedProjectors.clear();
  setSessionLimitStore(undefined);
  setAccountUsageStore(undefined);
  __resetAccountAdvisorForTests();
  vi.useRealTimers();
});

// === Without an advisor ======================================================

describe('without an advisor', () => {
  it('gives a limit the plan ask and the state limited', async () => {
    await limitedSession('src-1');
    expect(plan('src-1')).toEqual({ mode: 'ask' });
    expect(state('src-1')).toBe('limited');
  });

  it('ranks by weekly headroom with the account that ran out left out', async () => {
    await limitedSession('src-1');
    const options = await continueOptions('src-1');
    expect(options.plan).toEqual({ mode: 'ask' });
    expect(options.advised).toBe(false);
    expect(options.ranking.accounts.map((a) => [a.runtime, a.id, a.eligible])).toEqual([
      ['claude-code', 'spare', true],
      ['claude-code', 'busy', true],
    ]);
    expect(options.ranking.recommendedId).toBe('spare');
  });

  it('continues on the chosen account: a new session in the same folder, seeded, with the source settings', async () => {
    await runtimeRegistry.saveSessionSettings('src-1', {
      model: 'opus',
      effort: 'high',
      permissionMode: 'acceptEdits',
    });
    const history: HistoryMessage[] = [
      { id: 'u1', role: 'user', content: 'Fix the login bug' },
      {
        id: 'a1',
        role: 'assistant',
        content: 'Editing the handler.',
        toolCalls: [
          {
            toolCallId: 't1',
            toolName: 'Edit',
            input: JSON.stringify({ file_path: '/work/project/src/login.ts' }),
            result: 'SECRET TOOL OUTPUT',
            status: 'complete',
          },
        ],
      },
    ];
    runtime.getMessageHistory.mockResolvedValue(history);
    await limitedSession('src-1');

    const answer = await continueSession('src-1', { account: 'spare' }, deps);

    expect(answer).toEqual({ sessionId: 'new-1' });
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(dispatchSessionMessage).mock.calls[0]![0];
    expect(call.origin).toEqual({ kind: 'account-handoff' });
    expect(call.request).toMatchObject({
      content: CARRY_OVER_PROMPT,
      cwd: '/work/project',
      runtime: 'claude-code',
      account: 'spare',
    });
    const seed = call.request.seedContext!;
    expect(seed).toContain('Previous session: src-1, on MAIN.');
    expect(seed).toContain('/work/project/src/login.ts');
    expect(seed).toContain('Fix the login bug');
    expect(seed).not.toContain('SECRET TOOL OUTPUT');
    expect(seed).toContain(`/accounts/main/projects/`);
    // The new session's row was written with the source's settings before the send.
    expect(await runtimeRegistry.getSessionSettings(call.sessionId)).toMatchObject({
      model: 'opus',
      effort: 'high',
      permissionMode: 'acceptEdits',
    });
    expect(plan('src-1')).toEqual({ mode: 'continued', sessionId: 'new-1', accountId: 'spare' });
    expect(state('src-1')).toBe('moved');
    // No turn was ever sent to the source session, on any runtime path.
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('still points the old session at the new one when a plan write lands during the launch', async () => {
    await limitedSession('src-1');
    vi.mocked(dispatchSessionMessage).mockImplementationOnce(async () => {
      const row = store.get('src-1')!;
      store.update('src-1', row.limit.since, {
        plan: { mode: 'waiting', resumeAt: null, autoResume: false },
      });
      return {
        accepted: true,
        canonicalId: 'new-1',
        outcome: { kind: 'started', messageId: 'm' },
        queued: false,
        queuePosition: 0,
      } as never;
    });
    expect(await continueSession('src-1', { account: 'spare' }, deps)).toEqual({
      sessionId: 'new-1',
    });
    expect(plan('src-1')).toEqual({ mode: 'continued', sessionId: 'new-1', accountId: 'spare' });
  });

  it('answers a second continue with the session the first one started', async () => {
    await limitedSession('src-1');
    const first = await continueSession('src-1', { account: 'spare' }, deps);
    const second = await continueSession('src-1', { account: 'busy' }, deps);
    expect(second).toEqual(first);
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(1);
  });

  it('starts exactly one session for two concurrent continues', async () => {
    await limitedSession('src-1');
    const [a, b] = await Promise.all([
      continueSession('src-1', { account: 'spare' }, deps),
      continueSession('src-1', { account: 'spare' }, deps),
    ]);
    expect(a).toEqual(b);
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(1);
  });

  it('answers a continue after a restart with the new session the row points at', async () => {
    await limitedSession('src-1');
    await continueSession('src-1', { account: 'spare' }, deps);
    // A new process: nothing in memory, the row is all there is.
    stopPlanning();
    uninstall();
    stopPlanning = startLimitPlanning({ now: () => new Date() });
    uninstall = installContinueService({});
    expect(await continueSession('src-1', { account: 'busy' }, deps)).toEqual({
      sessionId: 'new-1',
    });
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(1);
  });

  it('waits: the plan becomes waiting with no automatic resume, and nothing else happens', async () => {
    await limitedSession('src-1');
    const result = await waitForReset('src-1', {});
    expect(result).toEqual({ mode: 'waiting', resumeAt: RESETS, autoResume: false });
    expect(state('src-1')).toBe('waiting-reset');
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
  });

  it('refuses a continue while the session is working', async () => {
    await limitedSession('src-1', { live: true });
    getOrCreateProjector('src-1').ingest({ type: 'turn_start' } as never);
    // `turn_start` clears the limit row; put it back to model a limit reported mid-turn.
    await limitedSession('src-1', { live: true });
    const err = await refusal(continueSession('src-1', { account: 'spare' }, deps));
    expect(err.status).toBe(409);
    expect(err.code).toBe('SESSION_BUSY');
  });

  it('refuses an account that is not registered', async () => {
    await limitedSession('src-1');
    const err = await refusal(continueSession('src-1', { account: 'nobody' }, deps));
    expect(err.status).toBe(400);
    expect(err.code).toBe('UNKNOWN_ACCOUNT');
  });

  it('refuses the account that ran out', async () => {
    await limitedSession('src-1');
    const err = await refusal(continueSession('src-1', { account: 'main' }, deps));
    expect(err.status).toBe(400);
    expect(err.code).toBe('SAME_ACCOUNT');
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
  });

  it('checks the chosen model before carrying the work over', async () => {
    await limitedSession('src-1');
    const err = await refusal(
      continueSession(
        'src-1',
        { account: 'spare', model: 'gpt-9' },
        { ...deps, checkModel: async () => 'That model is not offered.' }
      )
    );
    expect(err.status).toBe(400);
    expect(err.code).toBe('UNSUPPORTED_MODEL');
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
    expect(plan('src-1')).toEqual({ mode: 'ask' });
  });

  it('refuses a body with neither an account nor a model', async () => {
    await limitedSession('src-1');
    expect((await refusal(continueSession('src-1', {}, deps))).status).toBe(400);
  });

  it('answers 409 on continue, wait and cancel for a session with no limit', async () => {
    for (const call of [
      continueSession('src-none', { account: 'spare' }, deps),
      waitForReset('src-none', {}),
      cancelAutoContinue('src-none'),
    ]) {
      const err = await refusal(call);
      expect(err.status).toBe(409);
      expect(err.code).toBe('NO_LIMIT');
    }
  });

  it('refuses to cancel when no handoff is pending', async () => {
    await limitedSession('src-1');
    expect((await refusal(cancelAutoContinue('src-1'))).code).toBe('NOT_HANDING_OFF');
  });
});

// === Where the session started ==============================================

describe('which sessions may carry over', () => {
  it.each(['interactive', 'agent-launch', 'account-handoff'])('%s carries over', async (kind) => {
    await limitedSession('src-1', { origin: kind });
    expect(plan('src-1')).toEqual({ mode: 'ask' });
    expect(await continueSession('src-1', { account: 'spare' }, deps)).toEqual({
      sessionId: 'new-1',
    });
  });

  it.each([
    'room',
    'schedule',
    'relay-binding',
    'agent-dm',
    'connector-event',
    'test-harness',
    null,
  ])('%s can only wait: ask with carryOver false, no onLimited, 409 on continue', async (kind) => {
    const onLimited = vi.fn(async () => ({ mode: 'wait' as const }));
    advise({ onLimited });
    const origin = kind === 'room' ? null : kind;
    if (kind === 'room') {
      await runtimeRegistry.persistSessionRuntime('src-1', 'claude-code', {
        kind: 'room',
        externalAuthor: false,
      });
    }
    await limitedSession('src-1', { origin });
    expect(plan('src-1')).toEqual({ mode: 'ask', carryOver: false });
    expect(state('src-1')).toBe('wait-only');
    expect(onLimited).not.toHaveBeenCalled();
    const err = await refusal(continueSession('src-1', { account: 'spare' }, deps));
    expect(err.status).toBe(409);
    expect(err.message).toBe(WAIT_ONLY_MESSAGE);
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
  });

  it('keeps carryOver false on the waiting plan, and refuses an automatic resume', async () => {
    await limitedSession('src-1', { origin: 'schedule' });
    expect((await refusal(waitForReset('src-1', { autoResume: true }))).status).toBe(400);
    expect(await waitForReset('src-1', {})).toEqual({
      mode: 'waiting',
      resumeAt: RESETS,
      autoResume: false,
      carryOver: false,
    });
  });
});

// === Only Claude Code sessions continue =====================================

describe('a session on another runtime', () => {
  it('a Codex model bucket gets no Sonnet fallback, only waits, and refuses a continue', async () => {
    await limitedSession('src-codex', {
      runtime: 'codex',
      window: 'model:gpt-5-codex',
      scope: 'model',
    });
    expect(plan('src-codex')).toEqual({ mode: 'ask', carryOver: false });
    expect(store.get('src-codex')?.limit.modelFallback).toBeUndefined();
    expect(state('src-codex')).toBe('wait-only');
    for (const body of [{ model: 'sonnet' }, { account: 'spare' }]) {
      const err = await refusal(continueSession('src-codex', body, deps));
      expect(err.status).toBe(400);
      expect(err.code).toBe('RUNTIME_NOT_OFFERED');
    }
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
    expect(runtime.updateSession).not.toHaveBeenCalled();
    // Waiting still works.
    expect((await waitForReset('src-codex', {})).mode).toBe('waiting');
  });

  it('an OpenCode account limit only waits and never ranks or asks about Claude accounts', async () => {
    const rank = vi.fn(async () => ({ accounts: [], recommendedId: null }));
    const claims = vi.fn(async () => true);
    const onLimited = vi.fn(async () => ({ mode: 'wait' as const }));
    advise({ rank, claims, onLimited });
    await limitedSession('src-oc', { runtime: 'opencode', accountId: 'default' });
    expect(plan('src-oc')).toEqual({ mode: 'ask', carryOver: false });
    expect(state('src-oc')).toBe('wait-only');
    expect(store.get('src-oc')?.claimedBy).toBeNull();
    expect(await continueOptions('src-oc')).toEqual({
      plan: { mode: 'ask', carryOver: false },
      ranking: { accounts: [], recommendedId: null },
      advised: false,
    });
    expect(rank).not.toHaveBeenCalled();
    expect(claims).not.toHaveBeenCalled();
    expect(onLimited).not.toHaveBeenCalled();
  });
});

// === States ==================================================================

describe('states', () => {
  it('is wait-only with no other account', async () => {
    installUsageStore([{ id: 'main', state: 'limited' }]);
    await limitedSession('src-1');
    expect(state('src-1')).toBe('wait-only');
  });

  it('is all-accounts-out naming the earliest reset when every other account is out', async () => {
    installUsageStore([
      { id: 'main', state: 'limited', resetsAt: RESETS },
      { id: 'spare', state: 'limited', resetsAt: '2026-09-27T14:00:00.000Z' },
      { id: 'busy', state: 'limited', resetsAt: '2026-09-28T09:00:00.000Z' },
    ]);
    await limitedSession('src-1');
    expect(state('src-1')).toBe('all-accounts-out');
    expect(store.get('src-1')?.limit.allOut).toEqual({
      accountId: 'spare',
      resetsAt: '2026-09-27T14:00:00.000Z',
    });
  });

  it('moves to limited when another account gets room, on a usage change', async () => {
    installUsageStore([
      { id: 'main', state: 'limited' },
      { id: 'spare', state: 'limited', resetsAt: '2026-09-27T14:00:00.000Z' },
    ]);
    await limitedSession('src-1');
    expect(state('src-1')).toBe('all-accounts-out');
    accounts[1] = { id: 'spare', weekly: 10 };
    for (const listener of usageListeners) listener(usageOf(accounts[1]));
    await vi.waitFor(() => expect(state('src-1')).toBe('limited'));
    expect(store.get('src-1')?.limit.allOut).toBeUndefined();
  });

  it('is model-limited with the default fallback when only Opus ran out', async () => {
    installUsageStore([
      { id: 'main', weekly: 60 },
      { id: 'spare', weekly: 40 },
    ]);
    await limitedSession('src-1', { window: 'seven_day_opus', scope: 'model' });
    expect(state('src-1')).toBe('model-limited');
    expect(store.get('src-1')?.limit.modelFallback).toBe('sonnet');
  });

  it('offers the advisor’s fallback model', async () => {
    installUsageStore([{ id: 'main', weekly: 60 }]);
    advise({ modelFallback: async () => ({ model: 'haiku' }) });
    await limitedSession('src-1', { window: 'seven_day_opus', scope: 'model' });
    expect(store.get('src-1')?.limit.modelFallback).toBe('haiku');
    expect(state('src-1')).toBe('model-limited');
  });

  it('continue { model } switches the same session’s model and sends one turn', async () => {
    installUsageStore([{ id: 'main', weekly: 60 }]);
    await limitedSession('src-1', { window: 'seven_day_opus', scope: 'model', origin: 'room' });
    expect(await continueSession('src-1', { model: 'sonnet' }, deps)).toEqual({
      sessionId: 'src-1',
    });
    expect(runtime.updateSession).toHaveBeenCalledWith('src-1', { model: 'sonnet' });
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(dispatchSessionMessage).mock.calls[0]![0];
    expect(call.sessionId).toBe('src-1');
    expect(call.origin).toEqual({ kind: 'interactive' });
    expect(call.request.content).toBe(MODEL_CONTINUE_PROMPT);
  });

  it('refuses a model the runtime does not offer', async () => {
    installUsageStore([{ id: 'main', weekly: 60 }]);
    await limitedSession('src-1', { window: 'seven_day_opus', scope: 'model' });
    const err = await refusal(
      continueSession(
        'src-1',
        { model: 'gpt-9' },
        { ...deps, checkModel: async () => 'That model is not offered.' }
      )
    );
    expect(err.status).toBe(400);
    expect(runtime.updateSession).not.toHaveBeenCalled();
  });
});

// === With an advisor =========================================================

describe('with an advisor', () => {
  it('serves its ranking, badges and reasons, and says it was advised', async () => {
    advise({
      rank: async () => ({
        accounts: [
          { id: 'busy', eligible: true, reason: 'Kept for this project', badge: 'recommended' },
        ],
        recommendedId: 'busy',
      }),
    });
    await limitedSession('src-1');
    const options = await continueOptions('src-1');
    expect(options.advised).toBe(true);
    expect(options.ranking.accounts).toEqual([
      expect.objectContaining({
        runtime: 'claude-code',
        id: 'busy',
        reason: 'Kept for this project',
        badge: 'recommended',
      }),
    ]);
  });

  it('seeds the new session from the advisor’s carry-over', async () => {
    advise({
      carryOver: async () => ({ seedContext: 'From HANDOFF.md', prompt: 'Pick up DOR-1' }),
    });
    await limitedSession('src-1');
    await continueSession('src-1', { account: 'spare' }, deps);
    const call = vi.mocked(dispatchSessionMessage).mock.calls[0]![0];
    expect(call.request.seedContext).toBe('From HANDOFF.md');
    expect(call.request.content).toBe('Pick up DOR-1');
  });

  it('falls back to the default summary for an oversized seed', async () => {
    advise({ carryOver: async () => ({ seedContext: 'x'.repeat(SEED_CONTEXT_MAX_LENGTH + 1) }) });
    await limitedSession('src-1');
    await continueSession('src-1', { account: 'spare' }, deps);
    const call = vi.mocked(dispatchSessionMessage).mock.calls[0]![0];
    expect(call.request.seedContext).toContain('Previous session: src-1');
    expect(call.request.content).toBe(CARRY_OVER_PROMPT);
  });

  it('falls back to the defaults when the advisor throws', async () => {
    advise({
      onLimited: async () => {
        throw new Error('boom');
      },
    });
    await limitedSession('src-1');
    expect(plan('src-1')).toEqual({ mode: 'ask' });
  });

  it('turns an onLimited wait into a waiting plan that promises no resume core cannot run yet', async () => {
    advise({ onLimited: async () => ({ mode: 'wait' }) });
    await limitedSession('src-1');
    expect(plan('src-1')).toEqual({ mode: 'waiting', resumeAt: RESETS, autoResume: false });
    // Until task 5.2's resume engine lands, a person's wait promises none either.
    expect(await waitForReset('src-1', { autoResume: true })).toMatchObject({ autoResume: false });
  });

  it('never lets a state refresh that read before a carry-over undo it', async () => {
    let gate: Promise<void> | undefined;
    let release: () => void = () => undefined;
    advise({
      rank: async () => {
        if (gate) {
          const held = gate;
          gate = undefined;
          await held;
        }
        return {
          accounts: accounts
            .filter((a) => a.id !== 'main')
            .map((a) => ({ id: a.id, eligible: a.state !== 'limited', reason: 'fine' })),
          recommendedId: null,
        };
      },
    });
    await limitedSession('src-1');
    expect(state('src-1')).toBe('limited');
    // Every other account runs out, so a refresh would change the state...
    accounts = accounts.map((a) => ({ ...a, state: 'limited' as const }));
    gate = new Promise<void>((resolve) => (release = resolve));
    const refresh = refreshLimitState('src-1');
    // ...and while it waits on the ranking, the person carries the work over.
    const first = await continueSession('src-1', { account: 'spare' }, deps);
    release();
    await refresh;
    expect(plan('src-1')).toEqual({ mode: 'continued', sessionId: 'new-1', accountId: 'spare' });
    expect(state('src-1')).toBe('moved');
    expect(await continueSession('src-1', { account: 'busy' }, deps)).toEqual(first);
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(1);
  });
});

// === One writer for a flow run ===============================================

describe('a session the advisor claims', () => {
  it('stores the claim when the limit is set', async () => {
    advise({ claims: async () => true });
    await limitedSession('src-1');
    expect(store.get('src-1')?.claimedBy).toBe('flow');
  });

  it('hands a continue to advisor.move: 202 {}, plan auto from now, no core session', async () => {
    const move = vi.fn(async () => undefined);
    advise({ claims: async () => true, move });
    await limitedSession('src-1');
    expect(await continueSession('src-1', { account: 'spare' }, deps)).toEqual({});
    expect(move).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'src-1' }), {
      runtime: 'claude-code',
      accountId: 'spare',
    });
    expect(plan('src-1')).toEqual({ mode: 'auto', target: 'spare', fireAt: NOW.toISOString() });
    expect(state('src-1')).toBe('handing-off');
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
  });

  it('asks the advisor to move once for a double click', async () => {
    const move = vi.fn(async () => undefined);
    advise({ claims: async () => true, move });
    await limitedSession('src-1');
    const [a, b] = await Promise.all([
      continueSession('src-1', { account: 'spare' }, deps),
      continueSession('src-1', { account: 'spare' }, deps),
    ]);
    expect(await continueSession('src-1', { account: 'spare' }, deps)).toEqual({});
    expect([a, b]).toEqual([{}, {}]);
    expect(move).toHaveBeenCalledTimes(1);
  });

  it('refuses a model on a claimed session, since the advisor moves it', async () => {
    const move = vi.fn(async () => undefined);
    advise({ claims: async () => true, move });
    await limitedSession('src-1');
    const err = await refusal(
      continueSession('src-1', { account: 'spare', model: 'sonnet' }, deps)
    );
    expect(err.status).toBe(400);
    expect(move).not.toHaveBeenCalled();
  });

  it('puts an unreported handoff from a person’s continue back to ask after 10 minutes', async () => {
    advise({ claims: async () => true, move: async () => undefined });
    await limitedSession('src-1');
    await continueSession('src-1', { account: 'spare' }, deps);
    await vi.advanceTimersByTimeAsync(CLAIMED_HANDOFF_SETTLE_MS - 1_000);
    expect(plan('src-1')?.mode).toBe('auto');
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(plan('src-1')).toEqual({ mode: 'ask' }));
  });

  it('shows an onLimited auto plan and settles it after 10 minutes past fireAt', async () => {
    advise({
      claims: async () => true,
      onLimited: async () => ({ mode: 'auto', target: 'spare', delaySeconds: 60 }),
    });
    await limitedSession('src-1');
    expect(plan('src-1')).toEqual({
      mode: 'auto',
      target: 'spare',
      fireAt: new Date(NOW.getTime() + 60_000).toISOString(),
    });
    await vi.advanceTimersByTimeAsync(60_000 + CLAIMED_HANDOFF_SETTLE_MS + 1_000);
    await vi.waitFor(() => expect(plan('src-1')).toEqual({ mode: 'ask' }));
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
  });

  it('shows an onLimited wait on a claimed session and arms nothing of its own', async () => {
    advise({ claims: async () => true, onLimited: async () => ({ mode: 'wait' }) });
    await limitedSession('src-1');
    expect(plan('src-1')).toMatchObject({ mode: 'waiting', autoResume: true });
    expect(store.get('src-1')?.claimedBy).toBe('flow');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['ask', 'auto', 'waiting'] as const)(
    'records markContinued over a %s plan',
    async (mode) => {
      advise({
        claims: async () => true,
        move: async () => undefined,
        wait: async () => undefined,
      });
      await limitedSession('src-1');
      if (mode === 'auto') await continueSession('src-1', { account: 'spare' }, deps);
      if (mode === 'waiting') await waitForReset('src-1', {});
      await recordContinuation('flow', 'src-1', {
        sessionId: 'flow-new',
        runtime: 'claude-code',
        accountId: 'spare',
      });
      expect(plan('src-1')).toEqual({
        mode: 'continued',
        sessionId: 'flow-new',
        accountId: 'spare',
      });
      expect(state('src-1')).toBe('moved');
    }
  );

  it('refuses markContinued over a plan that already continued', async () => {
    advise({ claims: async () => true });
    await limitedSession('src-1');
    const to = { sessionId: 'flow-new', runtime: 'claude-code', accountId: 'spare' };
    await recordContinuation('flow', 'src-1', to);
    await expect(recordContinuation('flow', 'src-1', to)).rejects.toThrow(/already continued/);
  });

  it('refuses markContinued from an extension that did not claim the session', async () => {
    await limitedSession('src-1');
    await expect(
      recordContinuation('flow', 'src-1', {
        sessionId: 'x',
        runtime: 'claude-code',
        accountId: 'spare',
      })
    ).rejects.toThrow(/not claimed/);
  });

  it('treats markContinued for a session whose row is gone as a no-op', async () => {
    await expect(
      recordContinuation('flow', 'src-gone', {
        sessionId: 'x',
        runtime: 'claude-code',
        accountId: 'spare',
      })
    ).resolves.toBeUndefined();
  });

  it('reads a claimed auto as ask after a restart, and still accepts a later markContinued', async () => {
    advise({ claims: async () => true, move: async () => undefined });
    await limitedSession('src-1');
    await continueSession('src-1', { account: 'spare' }, deps);
    settleAutoPlansAtBoot();
    expect(plan('src-1')).toEqual({ mode: 'ask' });
    await recordContinuation('flow', 'src-1', {
      sessionId: 'flow-new',
      runtime: 'claude-code',
      accountId: 'spare',
    });
    expect(plan('src-1')?.mode).toBe('continued');
  });

  it('cancels through advisor.cancelAuto, and success returns the plan to ask', async () => {
    const cancelAuto = vi.fn(async () => undefined);
    advise({ claims: async () => true, move: async () => undefined, cancelAuto });
    await limitedSession('src-1');
    await continueSession('src-1', { account: 'spare' }, deps);
    expect(await cancelAutoContinue('src-1')).toEqual({ mode: 'ask' });
    expect(cancelAuto).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits through advisor.wait and arms no timer of its own', async () => {
    const wait = vi.fn(async () => undefined);
    advise({ claims: async () => true, wait });
    await limitedSession('src-1');
    await waitForReset('src-1', { autoResume: true });
    expect(wait).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'src-1' }),
      RESETS,
      true
    );
    expect(plan('src-1')).toMatchObject({ mode: 'waiting', autoResume: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['move', () => continueSession('src-1', { account: 'spare' }, deps)],
    ['wait', () => waitForReset('src-1', {})],
  ] as const)('refuses with 503 and changes nothing when %s throws', async (method, act) => {
    advise({
      claims: async () => true,
      [method]: async () => {
        throw new Error('flow is down');
      },
    });
    await limitedSession('src-1');
    const err = await refusal(act());
    expect(err.status).toBe(503);
    expect(err.message).toBe(FLOW_UNREACHABLE_MESSAGE);
    expect(plan('src-1')).toEqual({ mode: 'ask' });
  });

  it('refuses with 503 when move takes longer than the bound', async () => {
    advise({ claims: async () => true, move: () => new Promise<void>(() => undefined) });
    await limitedSession('src-1');
    const pending = refusal(continueSession('src-1', { account: 'spare' }, deps));
    await vi.advanceTimersByTimeAsync(ADVISOR_TIMEOUT_MS + 10);
    expect((await pending).status).toBe(503);
    expect(plan('src-1')).toEqual({ mode: 'ask' });
  });

  it('refuses cancel with 503 when cancelAuto throws', async () => {
    advise({
      claims: async () => true,
      move: async () => undefined,
      cancelAuto: async () => {
        throw new Error('down');
      },
    });
    await limitedSession('src-1');
    await continueSession('src-1', { account: 'spare' }, deps);
    expect((await refusal(cancelAutoContinue('src-1'))).status).toBe(503);
    expect(plan('src-1')?.mode).toBe('auto');
  });

  it('refuses every action with 503 while the claiming advisor is absent', async () => {
    const unregister = advise({ claims: async () => true });
    await limitedSession('src-1');
    unregister();
    expect((await refusal(continueSession('src-1', { account: 'spare' }, deps))).status).toBe(503);
    expect((await refusal(waitForReset('src-1', {}))).status).toBe(503);
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
  });

  it('tells the advisor about a wait once, even when the local write loses a race', async () => {
    const wait = vi.fn(async () => {
      // Something else rewrites the plan while the advisor is answering.
      const row = store.get('src-1')!;
      store.update('src-1', row.limit.since, {
        plan: { mode: 'waiting', resumeAt: null, autoResume: false },
      });
    });
    advise({ claims: async () => true, wait });
    await limitedSession('src-1');
    expect(await waitForReset('src-1', { autoResume: true })).toMatchObject({
      mode: 'waiting',
      resumeAt: RESETS,
      autoResume: true,
    });
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it('answers a cancel that raced the 10-minute fallback as done, asking the advisor once', async () => {
    const cancelAuto = vi.fn(async () => {
      // The fallback put the plan back to ask while flow was cancelling.
      const row = store.get('src-1')!;
      store.update('src-1', row.limit.since, { plan: { mode: 'ask' }, state: 'limited' });
    });
    advise({ claims: async () => true, move: async () => undefined, cancelAuto });
    await limitedSession('src-1');
    await continueSession('src-1', { account: 'spare' }, deps);
    expect(await cancelAutoContinue('src-1')).toEqual({ mode: 'ask' });
    expect(cancelAuto).toHaveBeenCalledTimes(1);
  });

  it('asks a newly registered advisor to claim a row nobody claimed', async () => {
    await limitedSession('src-1');
    expect(store.get('src-1')?.claimedBy).toBeNull();
    advise({ claims: async () => true }, 'flow-2');
    await vi.waitFor(() => expect(store.get('src-1')?.claimedBy).toBe('flow-2'));
  });
});
