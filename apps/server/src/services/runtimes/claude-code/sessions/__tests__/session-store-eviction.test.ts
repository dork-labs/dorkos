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

  it('gives an UNATTENDED session only the wait it can actually use', () => {
    // A scheduled run's prompt is refused at the countdown and never parks, so a
    // four-hour reprieve for a stranded entry is time the session could never
    // have spent waiting (spec `ask-parks-on-timeout` §7).
    const store = storeHoldingPrompt(11 * 60_000);
    const session = store.findSession(SESSION_ID)!;
    const now = Date.now();

    expect(isWaitingOnPerson(session, now)).toBe(true);
    session.unattended = true;
    expect(isWaitingOnPerson(session, now)).toBe(false);
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
