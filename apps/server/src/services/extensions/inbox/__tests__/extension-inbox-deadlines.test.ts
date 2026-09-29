/**
 * A question's deadline runs in core (spec `flow-multiproject` §7.1,
 * invariant 13): at `decideBy` the extension is asked to apply its pick, a
 * `keepOpen` is honoured, a failure retries twice and then leaves the row with
 * the person, and nothing fires for an extension that cannot answer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { extensionDecisions } from '@dorkos/db';
import { createInboxFixture, flush, type InboxFixture } from './inbox-fixture.js';

const ONE_MINUTE = 60_000;
const RAISED_AT = new Date('2026-09-29T09:00:00.000Z');
let fx: InboxFixture;

/** A question with the agent's pick and a deadline `inMinutes` after now. */
function question(inMinutes: number | null, overrides: Record<string, unknown> = {}) {
  return {
    key: 'old-api',
    title: 'Should the old API keep working?',
    why: 'Removing it breaks two scripts. If you don’t answer by then, it stays (the safer choice).',
    project: '/repos/dorkos',
    actions: {
      kind: 'choice' as const,
      choices: [
        { id: 'keep', label: 'Keep it' },
        { id: 'remove', label: 'Remove it' },
      ],
      defaultChoice: 'keep',
      ...(inMinutes === null
        ? {}
        : { decideBy: new Date(Date.now() + inMinutes * ONE_MINUTE).toISOString() }),
      allowReply: true,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: RAISED_AT });
  fx = createInboxFixture();
  fx.inbox.markRunning('flow', 'Flow');
});

afterEach(() => {
  fx.inbox.stop();
  fx.close();
  vi.useRealTimers();
});

describe('clamping', () => {
  it.each([
    ['in the past', -30],
    ['2 minutes ahead', 2],
  ])('moves a deadline %s to raise time + 5 minutes', async (_name, minutes) => {
    const raised = await fx.inbox.raise('flow', 'Flow', question(minutes));
    expect(raised.actions).toMatchObject({
      decideBy: new Date(RAISED_AT.getTime() + 5 * ONE_MINUTE).toISOString(),
    });
  });

  it('draws no deadline and arms no timer without decideBy', async () => {
    const handler = vi.fn();
    fx.inbox.setHandler('flow', handler);
    const raised = await fx.inbox.raise('flow', 'Flow', question(null));
    expect(raised.actions).not.toHaveProperty('decideBy');
    // Well past the clamp floor and any retry: a timer would have fired by now.
    await vi.advanceTimersByTimeAsync(2 * 60 * ONE_MINUTE);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('at the deadline', () => {
  it('asks the extension to apply the agent’s pick, and history says the agent decided', async () => {
    const handler = vi.fn().mockResolvedValue({ resolve: 'answered' });
    fx.inbox.setHandler('flow', handler);
    await fx.inbox.raise('flow', 'Flow', question(60));

    await vi.advanceTimersByTimeAsync(59 * ONE_MINUTE);
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ONE_MINUTE);
    await flush();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      action: 'choice',
      choiceId: 'keep',
      decidedBy: 'deadline',
      pendingActionId: null,
    });
    const [row] = fx.history();
    expect(row.body).toBe('Keep it · decided by the agent');
    // Nobody here answered it, so it waits unread.
    expect(row.readAt).toBeNull();
    expect(fx.db.select().from(extensionDecisions).all()[0]).toMatchObject({
      resolvedBy: 'deadline',
      choiceId: 'keep',
      offerJson: null,
    });
  });

  it('honours keepOpen: no retry, no timer, the deadline line goes, and a later agent resolve reads so', async () => {
    const handler = vi.fn().mockResolvedValue({ keepOpen: true });
    fx.inbox.setHandler('flow', handler);
    await fx.inbox.raise('flow', 'Flow', question(10));
    await vi.advanceTimersByTimeAsync(10 * ONE_MINUTE);
    await flush();
    await vi.advanceTimersByTimeAsync(60 * ONE_MINUTE);
    expect(handler).toHaveBeenCalledTimes(1);
    const [open] = fx.inbox.listOpen();
    expect(open.actions).not.toHaveProperty('decideBy');
    expect(open.needsYou).toBe(false);

    await fx.inbox.resolve('flow', 'old-api', {
      outcome: 'answered',
      by: { kind: 'agent', label: 'the reviewer agent' },
    });
    expect(fx.history()[0].body).toBe('the reviewer agent');
  });

  it('treats { settled: true } as valid, not a failure', async () => {
    const handler = vi.fn().mockResolvedValue({ settled: true });
    fx.inbox.setHandler('flow', handler);
    await fx.inbox.raise('flow', 'Flow', question(10));
    await vi.advanceTimersByTimeAsync(20 * ONE_MINUTE);
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);
    const row = fx.db.select().from(extensionDecisions).all()[0];
    expect(row).toMatchObject({ deadlineState: 'settled', deadlineAttempts: 0 });
    expect(row.resolvedAt).toBeNull();
  });

  it('retries a failing handler one and five minutes later, then leaves it with the person, still escalating', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('tracker down'));
    fx.inbox.setHandler('flow', handler);
    await fx.inbox.raise('flow', 'Flow', question(10));

    await vi.advanceTimersByTimeAsync(10 * ONE_MINUTE);
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ONE_MINUTE);
    await flush();
    expect(handler).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5 * ONE_MINUTE);
    await flush();
    expect(handler).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60 * ONE_MINUTE);
    expect(handler).toHaveBeenCalledTimes(3);

    const [open] = fx.inbox.listOpen();
    expect(open.needsYou).toBe(true);
    // The escalation ladder is untouched by the failure: it already pushed.
    expect(fx.sendToAll).toHaveBeenCalledTimes(1);
  });

  it('is cancelled by a person answering first', async () => {
    const handler = vi.fn().mockResolvedValue({ resolve: 'answered' });
    fx.inbox.setHandler('flow', handler);
    await fx.inbox.raise('flow', 'Flow', question(10));
    const [open] = fx.inbox.listOpen();
    await fx.inbox.answer(open.id, { action: 'choice', choiceId: 'remove' }, { kind: 'person' });
    await vi.advanceTimersByTimeAsync(20 * ONE_MINUTE);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].decidedBy).toBe('person');
    expect(fx.history()[0].body).toBe('Remove it · you');
  });

  it('waits, without failing, while no handler is registered', async () => {
    await fx.inbox.raise('flow', 'Flow', question(10));
    await vi.advanceTimersByTimeAsync(30 * ONE_MINUTE);
    expect(fx.db.select().from(extensionDecisions).all()[0]).toMatchObject({
      deadlineAttempts: 0,
      deadlineState: null,
    });
    const handler = vi.fn().mockResolvedValue({ resolve: 'answered' });
    fx.inbox.setHandler('flow', handler);
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('pauses while the extension is disabled and fires once it runs again', async () => {
    const handler = vi.fn().mockResolvedValue({ resolve: 'answered' });
    fx.inbox.setHandler('flow', handler);
    await fx.inbox.raise('flow', 'Flow', question(10));
    fx.inbox.markStopped('flow');
    await vi.advanceTimersByTimeAsync(30 * ONE_MINUTE);
    expect(handler).not.toHaveBeenCalled();
    fx.inbox.markRunning('flow', 'Flow');
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('after a restart', () => {
  it('fires a deadline that passed while the server was down, once, only after activation and onAction', async () => {
    await fx.inbox.raise('flow', 'Flow', question(10));
    fx.inbox.stop();
    await vi.advanceTimersByTimeAsync(60 * ONE_MINUTE);

    const restarted = fx.restart();
    const handler = vi.fn().mockResolvedValue({ resolve: 'answered' });
    // Registered during register(), before the extension is running.
    restarted.setHandler('flow', handler);
    await vi.advanceTimersByTimeAsync(ONE_MINUTE);
    expect(handler).not.toHaveBeenCalled();

    restarted.markRunning('flow', 'Flow');
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * ONE_MINUTE);
    expect(handler).toHaveBeenCalledTimes(1);
    restarted.stop();
  });
});
