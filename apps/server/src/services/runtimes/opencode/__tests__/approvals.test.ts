import { describe, it, expect, vi, afterEach } from 'vitest';
import { PendingApprovalStore } from '../approvals.js';
import { SESSIONS } from '../../../../config/constants.js';

/**
 * Who answered — the one thing OpenCode's own events cannot say.
 *
 * DorkOS auto-denies a permission nobody answered by sending the sidecar the
 * same `reject` a person's Deny sends, so the `permission.replied` echo comes
 * back identical either way. This store is the only place that still knows the
 * difference, and the difference is what separates a receipt that says "expired"
 * from one that says a question was withdrawn.
 */
describe('PendingApprovalStore expiry marking', () => {
  const ENTRY = { ocSessionId: 'oc-1', cwd: '/repo' };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks a permission its own timer denied, and answers once', () => {
    vi.useFakeTimers();
    const store = new PendingApprovalStore();
    const onTimeout = vi.fn();
    store.register('s1', 'per_1', ENTRY, onTimeout);

    expect(store.consumeExpired('s1', 'per_1')).toBe(false);
    // The countdown ends and the card PARKS: the agent is waiting, and nothing
    // has been answered on the person's behalf yet (spec `ask-parks-on-timeout`).
    vi.advanceTimersByTime(SESSIONS.INTERACTION_TIMEOUT_MS + 60_000);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(SESSIONS.INTERACTION_PARK_CEILING_MS);

    expect(onTimeout).toHaveBeenCalledOnce();
    expect(store.consumeExpired('s1', 'per_1')).toBe(true);
    // Consumed by the echo that clears the card — a second echo is not a second
    // expiry.
    expect(store.consumeExpired('s1', 'per_1')).toBe(false);
  });

  it('never marks a permission a person answered', () => {
    vi.useFakeTimers();
    const store = new PendingApprovalStore();
    store.register('s1', 'per_1', ENTRY, vi.fn());

    store.take('s1', 'per_1'); // the person answered
    vi.advanceTimersByTime(SESSIONS.INTERACTION_PARK_CEILING_MS + 1);

    expect(store.consumeExpired('s1', 'per_1')).toBe(false);
  });

  it('forgets an expiry when the same permission is asked again', () => {
    // A re-published permission is a live question again. Carrying the old mark
    // would stamp `timeout` on the echo of the person's real answer and file
    // their decision as "nobody was there".
    vi.useFakeTimers();
    const store = new PendingApprovalStore();
    store.register('s1', 'per_1', ENTRY, vi.fn());
    vi.advanceTimersByTime(SESSIONS.INTERACTION_PARK_CEILING_MS + 1);

    store.register('s1', 'per_1', ENTRY, vi.fn()); // upstream re-publish
    store.take('s1', 'per_1'); // and this time a person answers

    expect(store.consumeExpired('s1', 'per_1')).toBe(false);
  });

  it('drops an unclaimed expiry with the session', () => {
    // An echo that has not arrived by turn teardown is never going to.
    vi.useFakeTimers();
    const store = new PendingApprovalStore();
    store.register('s1', 'per_1', ENTRY, vi.fn());
    vi.advanceTimersByTime(SESSIONS.INTERACTION_PARK_CEILING_MS + 1);

    store.clearSession('s1');

    expect(store.consumeExpired('s1', 'per_1')).toBe(false);
  });
});
