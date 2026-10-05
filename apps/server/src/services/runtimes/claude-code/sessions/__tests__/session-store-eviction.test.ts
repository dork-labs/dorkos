/**
 * A session waiting on a person is not idle (spec `ask-parks-on-timeout` §8).
 *
 * `checkSessionHealth` retires a session RECORD after thirty minutes of
 * `lastActivity` silence, and `lastActivity` is stamped at creation and at each
 * turn — never while a prompt waits. So without an exemption the real ceiling on
 * any wait is thirty minutes from turn start, and a prompt that says it waits
 * four hours would be lying: the record holding the tool call the person is
 * coming back to answer would already be gone.
 *
 * The exemption is bounded by the park ceiling measured from when the prompt was
 * raised, so a STRANDED entry cannot make a record immortal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { SessionStore, isWaitingOnPerson } from '../session-store.js';
import { SessionLockManager } from '../../../../session/session-lock.js';
import { SESSIONS } from '../../../../../config/constants.js';
import type { PendingInteraction } from '../../messaging/interaction-wait.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ forkSession: vi.fn() }));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const SESSION_ID = 'session-under-eviction';
const THIRTY_ONE_MINUTES = 31 * 60 * 1000;

/** A store holding one session that raised a prompt `agedMs` ago. */
function storeHoldingPrompt(agedMs: number): SessionStore {
  const store = new SessionStore();
  store.ensureSession(SESSION_ID, { permissionMode: 'default' });
  const session = store.findSession(SESSION_ID)!;
  session.pendingInteractions.set('tool-1', {
    type: 'approval',
    toolCallId: 'tool-1',
    startedAt: Date.now() - agedMs,
    snapshot: { toolName: 'Bash', input: '{}', hasSuggestions: false },
    resolve: vi.fn(),
    reject: vi.fn(),
    timeout: setTimeout(() => {}, 60_000),
  } as unknown as PendingInteraction);
  return store;
}

describe('checkSessionHealth exempts a session waiting on a person', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a session that is holding a prompt, thirty-one minutes after its last turn', () => {
    const store = storeHoldingPrompt(THIRTY_ONE_MINUTES);
    vi.setSystemTime(Date.now() + THIRTY_ONE_MINUTES);

    expect(store.checkSessionHealth(new SessionLockManager())).toEqual([]);
    expect(store.findSession(SESSION_ID)).toBeDefined();
  });

  it('evicts a session whose prompt has waited past the park ceiling', () => {
    // The exemption's bound: the agent has given up by now, and a stranded
    // entry that never produced a refusal must not keep the record forever.
    const store = storeHoldingPrompt(SESSIONS.INTERACTION_PARK_CEILING_MS + 60_000);
    vi.setSystemTime(Date.now() + THIRTY_ONE_MINUTES);

    expect(store.checkSessionHealth(new SessionLockManager())).toEqual([SESSION_ID]);
    expect(store.findSession(SESSION_ID)).toBeUndefined();
  });

  it('needs no shorter bound for an unattended session, which holds nothing', () => {
    // A scheduled run's asks are refused before a pending entry is ever made
    // (spec `unattended-session-permission-prompts`), so there is no stranded
    // entry to age out early and the flag changes nothing here. The bound that
    // used to read it is gone; this pins that its absence is the right answer
    // rather than an oversight.
    const store = storeHoldingPrompt(11 * 60_000);
    const session = store.findSession(SESSION_ID)!;
    const now = Date.now();

    expect(isWaitingOnPerson(session, now)).toBe(true);
    session.unattended = true;
    expect(isWaitingOnPerson(session, now)).toBe(true);

    // What DOES answer false is an empty map — the state such a session is
    // actually in, because nothing was ever pended.
    session.pendingInteractions.clear();
    expect(isWaitingOnPerson(session, now)).toBe(false);
  });

  // DOR-2717. A night asleep moves the wall clock, not the awake one: a prompt
  // raised before the laptop slept is still being waited on when it wakes.
  it('measures the park ceiling in awake time when the prompt has an awake stamp', () => {
    const store = storeHoldingPrompt(SESSIONS.INTERACTION_PARK_CEILING_MS + 60 * 60_000);
    const session = store.findSession(SESSION_ID)!;
    const pending = session.pendingInteractions.get('tool-1')!;
    pending.startedAwake = performance.now();

    expect(isWaitingOnPerson(session, Date.now())).toBe(true);

    pending.startedAwake = performance.now() - SESSIONS.INTERACTION_PARK_CEILING_MS - 1;
    expect(isWaitingOnPerson(session, Date.now())).toBe(false);
  });

  it('still evicts an idle session with nothing pending at thirty-one minutes', () => {
    // The exemption did not widen into a general reprieve.
    const store = new SessionStore();
    store.ensureSession(SESSION_ID, { permissionMode: 'default' });
    vi.setSystemTime(Date.now() + THIRTY_ONE_MINUTES);

    expect(store.checkSessionHealth(new SessionLockManager())).toEqual([SESSION_ID]);
    expect(store.findSession(SESSION_ID)).toBeUndefined();
  });
});

/**
 * T5 (spec `warm-process-lifecycle` D1). Eviction is the harsher of the two
 * sweeps — it tears the process down unconditionally — and until this landed it
 * asked about person-waits and nothing else. A helper agent still working
 * thirty minutes after the last turn was simply thrown away (DOR-2065).
 *
 * The ceiling that bounds this exemption lives on the pump, which owns the busy
 * spell, and is pinned in `session-pump-quietness.test.ts`. What the store owes
 * is that it asks at all, and that a "no" is still a "no".
 */
describe('checkSessionHealth exempts a session whose agent is still working', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A store holding one session whose last turn was thirty-one minutes ago. */
  function agedStore(): SessionStore {
    const store = new SessionStore();
    store.ensureSession(SESSION_ID, { permissionMode: 'default' });
    vi.setSystemTime(Date.now() + THIRTY_ONE_MINUTES);
    return store;
  }

  it('keeps a session whose process is holding background work', () => {
    const store = agedStore();
    const holding = vi.fn().mockReturnValue(true);

    expect(store.checkSessionHealth(new SessionLockManager(), holding)).toEqual([]);
    expect(store.findSession(SESSION_ID)).toBeDefined();
    expect(holding).toHaveBeenCalledWith(SESSION_ID);
  });

  it('evicts it once the process is holding nothing — the ceiling having passed, or the work done', () => {
    const store = agedStore();

    expect(store.checkSessionHealth(new SessionLockManager(), () => false)).toEqual([SESSION_ID]);
    expect(store.findSession(SESSION_ID)).toBeUndefined();
  });

  it('evicts a session no runtime can answer for', () => {
    // Every other runtime, and a claude-code session with no warm process at
    // all, passes no probe — and must evict exactly as it did before.
    const store = agedStore();

    expect(store.checkSessionHealth(new SessionLockManager())).toEqual([SESSION_ID]);
    expect(store.findSession(SESSION_ID)).toBeUndefined();
  });
});

/**
 * DOR-2681. `lastActivity` is stamped when a turn STARTS, so a turn still
 * running thirty minutes later read as idle and was evicted out from under
 * itself: the warm process was torn down, the turn sat dark, and the stall
 * watchdog ended it ten minutes later with nothing left to interrupt. Both
 * stalls in that report were this sweep.
 */
describe('checkSessionHealth exempts a session whose turn is still running', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A store holding one session whose turn started `agedMs` ago and is still running. */
  function storeRunningTurn(agedMs: number): SessionStore {
    const store = new SessionStore();
    store.ensureSession(SESSION_ID, { permissionMode: 'default' });
    store.findSession(SESSION_ID)!.activeQuery = {} as Query;
    vi.setSystemTime(Date.now() + agedMs);
    return store;
  }

  it('keeps a session whose turn started thirty-one minutes ago and has not finished', () => {
    const store = storeRunningTurn(THIRTY_ONE_MINUTES);

    expect(store.checkSessionHealth(new SessionLockManager(), () => false)).toEqual([]);
    expect(store.findSession(SESSION_ID)).toBeDefined();
  });

  it('evicts it once the turn has run past the background-work ceiling', () => {
    // The bound: a turn whose `finally` never ran must not keep the record
    // forever. The stall watchdog ends a turn that has gone dark long before.
    const store = storeRunningTurn(SESSIONS.BACKGROUND_WORK_PARK_CEILING_MS + 60_000);

    expect(store.checkSessionHealth(new SessionLockManager(), () => false)).toEqual([SESSION_ID]);
  });
});
