/**
 * Waiting for an account's reset, confirming it with a reading, and resuming
 * the session by itself (spec `claude-account-fleet` D9 "Wait, then resume by
 * itself").
 *
 * Real `session_limits` and `session_metadata` tables and the real runtime
 * registry; a fake usage store whose readings each test sets, a fake probe,
 * and the launch service replaced by a spy. Fake timers drive every clock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { Db } from '@dorkos/db';
import { ACCOUNT_RESUME_PROMPT, type AccountUsage } from '@dorkos/shared/account-usage';
import type { AccountAdvisor } from '@dorkos/extension-api/server';
import type { LimitPlan } from '@dorkos/shared/schemas';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../flow-run-link.js', () => ({ flowRunsFor: vi.fn(async () => new Map()) }));
vi.mock('../../launch/launch-session.js', () => ({
  dispatchSessionMessage: vi.fn(),
  isSessionLaunchRefusal: (r: object) => 'refused' in r,
  isAgentLaunchCapFull: vi.fn(() => false),
}));
vi.mock('../../../notifications/emitters/session-lifecycle.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../notifications/emitters/session-lifecycle.js')
  >()),
  notifyAutoMoveFailed: vi.fn(),
}));

import { dispatchSessionMessage, isAgentLaunchCapFull } from '../../launch/launch-session.js';
import { notificationEntry } from '../../../notifications/notification-registry.js';
import { NotificationStore } from '../../../notifications/notification-store.js';
import {
  NotificationService,
  setNotificationService,
} from '../../../notifications/notification-service.js';
import { eventFanOut } from '../../../core/event-fan-out.js';
import { resetAgentPathLookup, setAgentPathLookup } from '../../../mesh/agent-path-lookup.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import {
  __resetAccountAdvisorForTests,
  registerAccountAdvisor,
} from '../../../core/usage/account-advisor.js';
import { setAccountUsageStore } from '../../../core/usage/current-usage-store.js';
import type { AccountUsageStore } from '../../../core/usage/account-usage-store.js';
import type { RuntimeAccount } from '../../../core/usage/runtime-accounts.js';
import { disposeProjector, getOrCreateProjector } from '../../session-state-projector.js';
import { SessionLimitStore, setSessionLimitStore } from '../session-limit-store.js';
import { planNewLimit, startLimitPlanning, writePlan } from '../limit-plans.js';
import { continueSession, installContinueService, waitForReset } from '../continue-service.js';
import {
  RESET_MAX_RECHECKS,
  RESET_RECHECK_MS,
  RESUME_CAP_RETRY_MS,
  UNPROBED_RESET_GRACE_MS,
  confirmsReset,
  installResumeService,
  resumeConfirmedWait,
  type ResetProbe,
} from '../resume-service.js';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const SINCE = '2026-09-27T11:59:00.000Z';
const RESETS = '2026-09-27T17:00:00.000Z';
const NEXT_RESET = '2026-09-27T22:00:00.000Z';
const TO_RESET = Date.parse(RESETS) - NOW.getTime();

type Window = AccountUsage['windows'][number];

let db: Db;
let notifications: NotificationService;
let store: SessionLimitStore;
let stopPlanning: () => void;
let uninstallContinue: () => void;
let uninstallResume: (() => void) | undefined;
let probe: ReturnType<typeof vi.fn<ResetProbe>>;
const usedProjectors = new Set<string>();

// --- The fake usage store: one `seven_day` reading per account ---------------

/** The newest reading per account id (`@path` for an unregistered folder). */
const readings = new Map<string, Window>();
const registered = ['main', 'spare'];
const usageListeners = new Set<(u: AccountUsage) => void>();

function reading(overrides: Partial<Window> = {}): Window {
  return {
    key: 'seven_day',
    label: 'Weekly',
    usedPct: 100,
    resetsAt: RESETS,
    status: 'rejected',
    expired: false,
    observedAt: SINCE,
    source: 'sdk_event',
    ...overrides,
  };
}

/** A reading that proves the window moved on: a later reset, and room. */
const MOVED_ON = reading({
  usedPct: 2,
  status: 'allowed',
  resetsAt: NEXT_RESET,
  observedAt: '2026-09-27T17:00:30.000Z',
});

function usageOf(key: string, accountId: string | null): AccountUsage {
  const window = readings.get(key);
  return {
    runtime: 'claude-code',
    accountId,
    path: `/accounts/${accountId ?? 'loose'}`,
    label: accountId ? accountId.toUpperCase() : null,
    color: '#123456',
    subscriptionType: null,
    plan: null,
    credits: null,
    spend: null,
    windows: window ? [window] : [],
    state: window?.status === 'rejected' ? 'limited' : 'ok',
    limit:
      window?.status === 'rejected' ? { window: 'seven_day', resetsAt: window.resetsAt } : null,
    updatedAt: null,
  };
}

function runtimeAccount(id: string): RuntimeAccount {
  return {
    runtime: 'claude-code',
    id,
    path: `/accounts/${id}`,
    canonicalPath: `/accounts/${id}`,
    label: id.toUpperCase(),
    color: '#123456',
    storedColor: null,
    routable: true,
    implicit: false,
    isDefault: false,
    ledgerId: id,
  };
}

function installUsageStore(): void {
  const fake = {
    listAccounts: () => registered.map(runtimeAccount),
    usageOfAccount: (a: RuntimeAccount) => usageOf(a.id, a.id),
    peek: (_runtime: string, ids: readonly string[]) =>
      registered.filter((id) => ids.includes(id)).map((id) => usageOf(id, id)),
    usageAtPath: (_runtime: string, dir: string) =>
      readings.has(`@${dir}`) ? usageOf(`@${dir}`, null) : null,
    onChange: (listener: (u: AccountUsage) => void) => {
      usageListeners.add(listener);
      return () => usageListeners.delete(listener);
    },
  };
  setAccountUsageStore(fake as unknown as AccountUsageStore);
}

/** A new reading lands in the store, and the store says so. */
function recordReading(key: string, window: Window): void {
  readings.set(key, window);
  for (const listener of usageListeners) listener(usageOf(key, key.startsWith('@') ? null : key));
}

// --- Helpers -------------------------------------------------------------------

/** A session bound under `origin`, holding a planned limit. */
async function limitedSession(
  id: string,
  opts: {
    origin?: string;
    accountId?: string | null;
    resetsAt?: string | null;
    runtime?: string;
  } = {}
): Promise<void> {
  await runtimeRegistry.persistSessionRuntime(id, opts.runtime ?? 'claude-code', {
    kind: opts.origin ?? 'interactive',
  } as never);
  const accountId = opts.accountId === undefined ? 'main' : opts.accountId;
  store.upsert({
    sessionId: id,
    limit: {
      accountId,
      window: 'seven_day',
      resetsAt: opts.resetsAt === undefined ? RESETS : opts.resetsAt,
      since: SINCE,
      plan: { mode: 'ask' },
      scope: 'account',
      state: 'limited',
    },
    scope: 'account',
    accountPath: accountId ? `/accounts/${accountId}` : '/accounts/loose',
    cwd: '/work/project',
  });
  await planNewLimit(id, SINCE);
}

/** A session waiting for its reset, as a person's "wait" leaves it. */
async function waitingSession(
  id: string,
  opts: { origin?: string; accountId?: string | null; autoResume?: boolean } = {}
): Promise<void> {
  await limitedSession(id, opts);
  await waitForReset(id, { autoResume: opts.autoResume ?? true });
}

function plan(id: string): LimitPlan | undefined {
  return store.get(id)?.limit.plan;
}

function resumes(): { sessionId: string; origin: unknown }[] {
  return vi
    .mocked(dispatchSessionMessage)
    .mock.calls.map(([opts]) => ({ sessionId: opts.sessionId, origin: opts.origin }));
}

/** The `account.reset` rows the notifications table holds. */
function resetNotices() {
  return notifications
    .list({ limit: 50, unread: false })
    .notifications.filter((r) => r.kind === 'account.reset');
}

function startResume(withProbe = true): void {
  uninstallResume = installResumeService({
    launchDeps: () => ({ meshCore: undefined, roomSessionPlace: undefined }),
    ...(withProbe ? { probe } : {}),
  });
}

function restart(withProbe = true): void {
  uninstallResume?.();
  stopPlanning();
  uninstallContinue();
  stopPlanning = startLimitPlanning({ now: () => new Date() });
  uninstallContinue = installContinueService({});
  startResume(withProbe);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(NOW);
  db = createTestDb();
  store = new SessionLimitStore(db, () => new Date());
  setSessionLimitStore(store);
  notifications = new NotificationService(new NotificationStore(db));
  setNotificationService(notifications);
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  setAgentPathLookup({ getByPath: () => undefined });
  runtimeRegistry.setDb(db);
  runtimeRegistry.register(new FakeAgentRuntime('claude-code') as never);
  runtimeRegistry.register(new FakeAgentRuntime('codex') as never);
  __resetAccountAdvisorForTests();
  readings.clear();
  readings.set('main', reading());
  readings.set('spare', reading({ usedPct: 40, status: 'allowed', resetsAt: null }));
  installUsageStore();
  probe = vi.fn<ResetProbe>(async () => undefined);
  vi.mocked(isAgentLaunchCapFull).mockReturnValue(false);
  vi.mocked(dispatchSessionMessage).mockReset();
  vi.mocked(dispatchSessionMessage).mockImplementation(
    async (opts) =>
      ({
        accepted: true,
        canonicalId: opts.sessionId,
        outcome: { kind: 'started', messageId: 'm' },
        queued: false,
        queuePosition: 0,
      }) as never
  );
  stopPlanning = startLimitPlanning({ now: () => new Date() });
  uninstallContinue = installContinueService({});
  startResume();
});

afterEach(() => {
  uninstallResume?.();
  uninstallResume = undefined;
  stopPlanning();
  uninstallContinue();
  for (const id of usedProjectors) disposeProjector(id);
  usedProjectors.clear();
  usageListeners.clear();
  setSessionLimitStore(undefined);
  setAccountUsageStore(undefined);
  setNotificationService(null);
  resetAgentPathLookup();
  vi.restoreAllMocks();
  __resetAccountAdvisorForTests();
  vi.useRealTimers();
});

// === The confirmation rule ====================================================

describe('confirmsReset', () => {
  const episode = { resetsAt: RESETS, since: SINCE };

  it('confirms a reading whose reset is later than the episode’s', () => {
    expect(confirmsReset(MOVED_ON, episode)).toBe(true);
  });

  it('never confirms a reading the store only inferred from the clock', () => {
    expect(confirmsReset(reading({ usedPct: 0, status: 'allowed', expired: true }), episode)).toBe(
      false
    );
  });

  it('never confirms an expired reading when the episode’s reset was unknown', () => {
    const expired = reading({
      usedPct: 0,
      status: 'allowed',
      expired: true,
      observedAt: '2026-09-27T12:30:00.000Z',
    });
    expect(confirmsReset(expired, { resetsAt: null, since: SINCE })).toBe(false);
  });

  it('never confirms a 99% reading, even in a new window', () => {
    expect(confirmsReset({ ...MOVED_ON, usedPct: 99 }, episode)).toBe(false);
    expect(
      confirmsReset(
        reading({ usedPct: 99, status: null, resetsAt: null, observedAt: NEXT_RESET }),
        episode
      )
    ).toBe(false);
  });

  it('confirms a reading with no reset time only when observed after the reset', () => {
    const noReset = reading({ usedPct: 5, status: null, resetsAt: null });
    expect(confirmsReset({ ...noReset, observedAt: '2026-09-27T16:59:00.000Z' }, episode)).toBe(
      false
    );
    expect(confirmsReset({ ...noReset, observedAt: '2026-09-27T17:01:00.000Z' }, episode)).toBe(
      true
    );
  });

  it('never confirms a rejected reading', () => {
    expect(confirmsReset({ ...MOVED_ON, status: 'rejected' }, episode)).toBe(false);
  });
});

// === The timer and confirmation ===============================================

describe('waiting for the reset', () => {
  it('checks at resumeAt, not before, and resumes the same session once, unattended', async () => {
    await waitingSession('s-1');
    expect(store.get('s-1')?.limit.state).toBe('waiting-reset');
    recordReading('main', MOVED_ON);
    await vi.advanceTimersByTimeAsync(TO_RESET - 1_000);
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(1);
    const [opts] = vi.mocked(dispatchSessionMessage).mock.calls[0];
    expect(opts).toMatchObject({
      sessionId: 's-1',
      origin: { kind: 'account-resume' },
      request: { content: ACCOUNT_RESUME_PROMPT, cwd: '/work/project' },
      unattended: true,
      countsTowardLaunchCap: true,
    });
    expect(plan('s-1')).toMatchObject({ mode: 'waiting', resetConfirmedAt: RESETS });
    expect(store.get('s-1')?.limit.state).toBe('reset-ready');
    expect(runtimeRegistry.getLastAutoResumeFor('s-1')).toBe(RESETS);
    await vi.advanceTimersByTimeAsync(RESET_RECHECK_MS * 10);
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(1);
  });

  it('leaves the row to the resumed turn, which records one resumed-reset in the history', async () => {
    await waitingSession('s-1');
    readings.set('main', MOVED_ON);
    await vi.advanceTimersByTimeAsync(TO_RESET);
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(1);
    // Confirming and sending never clear the row: the resumed turn does.
    expect(store.get('s-1')?.limit.plan).toMatchObject({ resetConfirmedAt: RESETS });
    expect(store.history('s-1')).toEqual([]);
    usedProjectors.add('s-1');
    getOrCreateProjector('s-1', '/work/project').ingest({
      type: 'turn_start',
      userMessage: ACCOUNT_RESUME_PROMPT,
    } as never);
    expect(store.get('s-1')).toBeUndefined();
    const history = store.history('s-1');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ since: SINCE, resolution: 'resumed-reset' });
  });

  it('does not trust the clock: a reading from before the reset leaves it waiting', async () => {
    await waitingSession('s-1');
    // The store reads the old window as expired once its time passes: the clock's guess.
    readings.set('main', reading({ usedPct: 0, status: 'allowed', expired: true }));
    await vi.advanceTimersByTimeAsync(TO_RESET);
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
    expect(store.get('s-1')?.limit.state).toBe('waiting-reset');
  });

  it('does not confirm on a 99% reading', async () => {
    await waitingSession('s-1');
    readings.set('main', { ...MOVED_ON, usedPct: 99 });
    await vi.advanceTimersByTimeAsync(TO_RESET);
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
    expect(plan('s-1')).not.toHaveProperty('resetConfirmedAt');
  });

  it('confirms by a probe when the store cannot', async () => {
    await waitingSession('s-1');
    probe.mockImplementation(async () => {
      readings.set('main', MOVED_ON);
    });
    await vi.advanceTimersByTimeAsync(TO_RESET);
    expect(probe).toHaveBeenCalledWith('main', { resumeAt: RESETS });
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(1);
  });

  it('re-checks an unconfirmed account every 10 minutes, 6 times, then stops unconfirmed', async () => {
    await waitingSession('s-1');
    await vi.advanceTimersByTimeAsync(TO_RESET);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RESET_RECHECK_MS * RESET_MAX_RECHECKS);
    expect(probe).toHaveBeenCalledTimes(1 + RESET_MAX_RECHECKS);
    expect(plan('s-1')).toMatchObject({ mode: 'waiting', unconfirmed: true });
    expect(store.get('s-1')?.limit.state).toBe('reset-ready');
    await vi.advanceTimersByTimeAsync(RESET_RECHECK_MS * 5);
    expect(probe).toHaveBeenCalledTimes(1 + RESET_MAX_RECHECKS);
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
    expect(resetNotices()).toHaveLength(0);
  });

  it('confirms on a re-check when a newer reading arrives in between', async () => {
    await waitingSession('s-1');
    await vi.advanceTimersByTimeAsync(TO_RESET);
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
    readings.set('main', MOVED_ON);
    await vi.advanceTimersByTimeAsync(RESET_RECHECK_MS);
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(1);
  });

  it('clamps an advisor’s past resumeAt to a minute from now', async () => {
    const past = '2026-09-27T10:00:00.000Z';
    registerAccountAdvisor('flow', {
      rank: vi.fn(async () => ({ accounts: [], recommendedId: null })),
      onLimited: async () => ({ mode: 'wait', resumeAt: past }),
    } as unknown as AccountAdvisor);
    await limitedSession('s-1', { resetsAt: '2026-09-27T11:00:00.000Z' });
    expect(plan('s-1')).toMatchObject({ mode: 'waiting', resumeAt: past, autoResume: true });
    readings.set('main', MOVED_ON);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(1);
  });

  it('never fires before the reset, even when the advisor’s resumeAt is earlier', async () => {
    registerAccountAdvisor('flow', {
      rank: vi.fn(async () => ({ accounts: [], recommendedId: null })),
      onLimited: async () => ({ mode: 'wait', resumeAt: '2026-09-27T13:00:00.000Z' }),
    } as unknown as AccountAdvisor);
    await limitedSession('s-1');
    readings.set('main', MOVED_ON);
    await vi.advanceTimersByTimeAsync(TO_RESET - 1_000);
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(1);
  });
});

// === An account that cannot be probed =========================================

describe('an unregistered root', () => {
  it('confirms from a store reading that arrives after the time', async () => {
    await waitingSession('s-1', { accountId: null });
    await vi.advanceTimersByTimeAsync(TO_RESET);
    expect(probe).not.toHaveBeenCalled();
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    recordReading('@/accounts/loose', MOVED_ON);
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(1);
  });

  it('becomes an unconfirmed reset-ready 15 minutes after resumeAt, with no resume', async () => {
    await waitingSession('s-1', { accountId: null });
    await vi.advanceTimersByTimeAsync(TO_RESET + UNPROBED_RESET_GRACE_MS - 1_000);
    expect(plan('s-1')).not.toHaveProperty('unconfirmed');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(plan('s-1')).toMatchObject({ unconfirmed: true });
    expect(store.get('s-1')?.limit.state).toBe('reset-ready');
    // A reading after giving up changes nothing: no resume is promised unconfirmed.
    recordReading('@/accounts/loose', MOVED_ON);
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
  });

  it('treats a registered account as store-only when no probe is wired', async () => {
    uninstallResume?.();
    startResume(false);
    await waitingSession('s-1');
    await vi.advanceTimersByTimeAsync(TO_RESET + UNPROBED_RESET_GRACE_MS);
    expect(plan('s-1')).toMatchObject({ unconfirmed: true });
  });
});

// === Resuming ==================================================================

describe('resuming', () => {
  it('leaves the session reset-ready when autoResume is off', async () => {
    await waitingSession('s-1', { autoResume: false });
    readings.set('main', MOVED_ON);
    await vi.advanceTimersByTimeAsync(TO_RESET);
    expect(store.get('s-1')?.limit.state).toBe('reset-ready');
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
    expect(resetNotices()).toHaveLength(1);
  });

  it('never resumes a session whose launch origin may only wait', async () => {
    await limitedSession('s-1', { origin: 'schedule' });
    await waitForReset('s-1', {});
    // Even a stored plan that asks for it (written by a build that allowed it).
    store.update('s-1', SINCE, {
      plan: { mode: 'waiting', resumeAt: RESETS, autoResume: true, carryOver: false },
    });
    readings.set('main', MOVED_ON);
    await vi.advanceTimersByTimeAsync(TO_RESET);
    expect(store.get('s-1')?.limit.state).toBe('reset-ready');
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
  });

  it('gives a Codex wait only the unconfirmed fallback: no Claude reading, probe, notice or resume', async () => {
    await limitedSession('s-codex', { runtime: 'codex' });
    // A person's wait promises no resume core would not run.
    expect(await waitForReset('s-codex', { autoResume: true })).toMatchObject({
      autoResume: false,
    });
    // Even a plan that asks for one gets none.
    await writePlan(store.get('s-codex')!, {
      mode: 'waiting',
      resumeAt: RESETS,
      autoResume: true,
    });
    // A Claude account under the same id has moved on: it must not count.
    readings.set('main', MOVED_ON);
    await vi.advanceTimersByTimeAsync(TO_RESET);
    // Nor a reading that arrives while the wait is past its time.
    recordReading('main', MOVED_ON);
    await vi.advanceTimersByTimeAsync(UNPROBED_RESET_GRACE_MS - 1_000);
    expect(store.get('s-codex')?.limit.state).toBe('waiting-reset');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(plan('s-codex')).toMatchObject({ mode: 'waiting', unconfirmed: true });
    expect(plan('s-codex')).not.toHaveProperty('resetConfirmedAt');
    expect(store.get('s-codex')?.limit.state).toBe('reset-ready');
    expect(probe).not.toHaveBeenCalled();
    expect(resetNotices()).toHaveLength(0);
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
  });

  it('at boot, gives a Codex wait from before this change only the fallback', async () => {
    await limitedSession('s-codex', { runtime: 'codex' });
    // Written by a build that armed any runtime's wait for a resume.
    store.update('s-codex', SINCE, {
      plan: { mode: 'waiting', resumeAt: RESETS, autoResume: true },
      state: 'waiting-reset',
    });
    readings.set('main', MOVED_ON);
    restart();
    await vi.advanceTimersByTimeAsync(TO_RESET + UNPROBED_RESET_GRACE_MS);
    expect(probe).not.toHaveBeenCalled();
    expect(resetNotices()).toHaveLength(0);
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
    expect(plan('s-codex')).toMatchObject({ unconfirmed: true });
  });

  it('never resumes a confirmed Codex wait, at boot or asked directly', async () => {
    await limitedSession('s-codex', { runtime: 'codex' });
    store.update('s-codex', SINCE, {
      plan: { mode: 'waiting', resumeAt: RESETS, autoResume: true, resetConfirmedAt: RESETS },
      state: 'reset-ready',
    });
    await resumeConfirmedWait('s-codex');
    restart();
    await vi.advanceTimersByTimeAsync(RESUME_CAP_RETRY_MS);
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
    expect(runtimeRegistry.getLastAutoResumeFor('s-codex')).toBeNull();
  });

  it('never resumes the same window twice: a resumed turn that runs out again only gets reset-ready', async () => {
    await waitingSession('s-1');
    readings.set('main', MOVED_ON);
    await vi.advanceTimersByTimeAsync(TO_RESET);
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(1);
    // The resumed turn starts (its row goes), then hits the same window's limit.
    store.delete('s-1');
    readings.set('main', reading());
    const since2 = new Date().toISOString();
    store.upsert({
      sessionId: 's-1',
      limit: {
        accountId: 'main',
        window: 'seven_day',
        resetsAt: RESETS,
        since: since2,
        plan: { mode: 'ask' },
        scope: 'account',
        state: 'limited',
      },
      scope: 'account',
      accountPath: '/accounts/main',
      cwd: '/work/project',
    });
    await planNewLimit('s-1', since2);
    await waitForReset('s-1', { autoResume: true });
    readings.set('main', MOVED_ON);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(store.get('s-1')?.limit.state).toBe('reset-ready');
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(1);
  });

  it('retries a minute later when the launch cap is full', async () => {
    await waitingSession('s-1');
    readings.set('main', MOVED_ON);
    vi.mocked(isAgentLaunchCapFull).mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(TO_RESET);
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
    expect(runtimeRegistry.getLastAutoResumeFor('s-1')).toBeNull();
    await vi.advanceTimersByTimeAsync(RESUME_CAP_RETRY_MS);
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
    vi.mocked(isAgentLaunchCapFull).mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(RESUME_CAP_RETRY_MS);
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(1);
  });

  it('retries when the dispatch itself finds the cap full, and forgets the record', async () => {
    await waitingSession('s-1');
    readings.set('main', MOVED_ON);
    vi.mocked(dispatchSessionMessage).mockResolvedValueOnce({
      refused: 'LAUNCH_CAP_FULL',
      message: 'full',
    } as never);
    await vi.advanceTimersByTimeAsync(TO_RESET);
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(1);
    expect(runtimeRegistry.getLastAutoResumeFor('s-1')).toBeNull();
    await vi.advanceTimersByTimeAsync(RESUME_CAP_RETRY_MS);
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(2);
    expect(runtimeRegistry.getLastAutoResumeFor('s-1')).toBe(RESETS);
  });

  it('forgets the record when the resume is not accepted, and resumes once after a restart', async () => {
    await waitingSession('s-1');
    readings.set('main', MOVED_ON);
    vi.mocked(dispatchSessionMessage).mockResolvedValueOnce({ accepted: false } as never);
    await vi.advanceTimersByTimeAsync(TO_RESET);
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(1);
    expect(runtimeRegistry.getLastAutoResumeFor('s-1')).toBeNull();
    restart();
    await vi.advanceTimersByTimeAsync(RESUME_CAP_RETRY_MS);
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(2);
    expect(runtimeRegistry.getLastAutoResumeFor('s-1')).toBe(RESETS);
    restart();
    await vi.advanceTimersByTimeAsync(RESUME_CAP_RETRY_MS);
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(2);
  });

  it('forgets the record when the resume throws, and resumes once after a restart', async () => {
    await waitingSession('s-1');
    readings.set('main', MOVED_ON);
    vi.mocked(dispatchSessionMessage).mockRejectedValueOnce(new Error('boom'));
    await vi.advanceTimersByTimeAsync(TO_RESET);
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(1);
    expect(runtimeRegistry.getLastAutoResumeFor('s-1')).toBeNull();
    restart();
    await vi.advanceTimersByTimeAsync(RESUME_CAP_RETRY_MS);
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(2);
    expect(runtimeRegistry.getLastAutoResumeFor('s-1')).toBe(RESETS);
    restart();
    await vi.advanceTimersByTimeAsync(RESUME_CAP_RETRY_MS);
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(2);
  });

  it('tells once per account reset, naming every waiting session, across a restart', async () => {
    await waitingSession('s-1');
    await waitingSession('s-2');
    await waitingSession('s-3');
    readings.set('main', MOVED_ON);
    await vi.advanceTimersByTimeAsync(TO_RESET);
    expect(
      resumes()
        .map((r) => r.sessionId)
        .sort()
    ).toEqual(['s-1', 's-2', 's-3']);
    expect(resetNotices()).toHaveLength(1);
    expect(resetNotices()[0]).toMatchObject({
      title: 'MAIN is back: 3 paused sessions can continue',
      subject: { type: 'session' },
    });
    // After a restart, a fourth session waiting on the same reset confirms it
    // too: the table's dedupe key keeps it to the one notice.
    vi.setSystemTime(NOW);
    readings.set('main', reading());
    await waitingSession('s-4');
    restart();
    vi.setSystemTime(Date.parse(RESETS) + 60_000);
    readings.set('main', MOVED_ON);
    restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(resumes().map((r) => r.sessionId)).toContain('s-4');
    expect(resetNotices()).toHaveLength(1);
  });

  it('titles the notice for one session and for many', () => {
    const entry = notificationEntry('account.reset');
    const base = {
      sessionId: 's-1',
      accountId: 'main',
      accountLabel: 'Work',
      resetsAt: RESETS,
      resetConfirmedAt: RESETS,
    };
    expect(entry.title({ ...base, pausedCount: 1 })).toBe(
      'Work is back: 1 paused session can continue'
    );
    expect(entry.title({ ...base, pausedCount: 3 })).toBe(
      'Work is back: 3 paused sessions can continue'
    );
    expect(entry.dedupeKey({ ...base, pausedCount: 3 })).toBe(`account-reset:main:${RESETS}`);
  });
});

// === Restarts and clearing =====================================================

describe('restarts', () => {
  it('re-arms a wait after a restart between the wait and its time', async () => {
    await waitingSession('s-1');
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    restart();
    readings.set('main', MOVED_ON);
    await vi.advanceTimersByTimeAsync(TO_RESET - 60 * 60_000);
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(1);
  });

  it('checks at once at boot when the time already passed', async () => {
    await waitingSession('s-1');
    uninstallResume?.();
    uninstallResume = undefined;
    // Down across the reset.
    vi.setSystemTime(Date.parse(RESETS) + 30 * 60_000);
    readings.set('main', MOVED_ON);
    restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatchSessionMessage).toHaveBeenCalledTimes(1);
  });
});

describe('clearing the timer', () => {
  it('a continue on another account clears it', async () => {
    await waitingSession('s-1');
    await continueSession(
      's-1',
      { account: 'spare' },
      {
        meshCore: undefined,
        roomSessionPlace: undefined,
        clientId: 'c',
        checkModel: async () => null,
      }
    );
    vi.mocked(dispatchSessionMessage).mockClear();
    readings.set('main', MOVED_ON);
    await vi.advanceTimersByTimeAsync(TO_RESET);
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
    expect(resetNotices()).toHaveLength(0);
  });

  it('a new turn clears it', async () => {
    await waitingSession('s-1');
    usedProjectors.add('s-1');
    getOrCreateProjector('s-1', '/work/project').ingest({
      type: 'turn_start',
      userMessage: 'hi',
    } as never);
    readings.set('main', MOVED_ON);
    await vi.advanceTimersByTimeAsync(TO_RESET);
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
  });

  it('arms nothing for a claimed session: flow resumes it', async () => {
    registerAccountAdvisor('flow', {
      rank: vi.fn(async () => ({ accounts: [], recommendedId: null })),
      claims: async () => true,
      onLimited: async () => ({ mode: 'wait' }),
    } as unknown as AccountAdvisor);
    await limitedSession('s-1');
    expect(store.get('s-1')?.claimedBy).toBe('flow');
    expect(plan('s-1')).toMatchObject({ mode: 'waiting', autoResume: true });
    readings.set('main', MOVED_ON);
    await vi.advanceTimersByTimeAsync(TO_RESET);
    expect(probe).not.toHaveBeenCalled();
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
    // Nor after a restart: the boot scan skips it by the stored claim.
    __resetAccountAdvisorForTests();
    restart();
    await vi.advanceTimersByTimeAsync(RESET_RECHECK_MS);
    expect(dispatchSessionMessage).not.toHaveBeenCalled();
  });
});
