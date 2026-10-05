import { describe, it, expect } from 'vitest';
import type {
  MessageDeliveryOutcome,
  QueuedMessage,
  QueuedWaitingOn,
} from '@dorkos/shared/schemas';
import { describeWaitingOn, queueDowngradeNotice, selectWaitingQueue } from '../queue-chips';

/** A delivery outcome that was downgraded for `reason`. */
function downgraded(reason: MessageDeliveryOutcome['degradedBecause']): MessageDeliveryOutcome {
  return { messageId: 'm-1', requested: 'steer', applied: 'queue', degradedBecause: reason };
}

describe('queueDowngradeNotice — say what happened, once, in plain words (AC4)', () => {
  it('says nothing when the message got exactly what it asked for', () => {
    const clean: MessageDeliveryOutcome = {
      messageId: 'm-1',
      requested: 'queue',
      applied: 'queue',
    };
    expect(queueDowngradeNotice(clean)).toBeNull();
    expect(queueDowngradeNotice(undefined)).toBeNull();
  });

  it('says NOTHING for session-idle — "it ran immediately" is not a loss', () => {
    // The one downgrade the UI must stay quiet about.
    expect(queueDowngradeNotice(downgraded('session-idle'))).toBeNull();
  });

  it('explains an unsupported steer in plain words, no code or field name', () => {
    const notice = queueDowngradeNotice(downgraded('unsupported'));
    expect(notice).toBe('Queued. This agent can’t take a message mid-task.');
    // Never leaks the machinery.
    expect(notice).not.toMatch(/steer|stage|disposition|degrad|unsupported/i);
  });

  it('owns up to a cut-in that could not happen (DOR-1268)', () => {
    // The case `session-idle` used to swallow: a turn WAS running, it could not
    // be joined, and the message really did go to the back of the line. Staying
    // quiet about that was the lie.
    const notice = queueDowngradeNotice(downgraded('not-steerable'));
    expect(notice).toBe('Couldn’t cut in. It’s waiting in line.');
    expect(notice).not.toMatch(/steer|stage|disposition|degrad|session|runtime/i);
    // And it is NOT the silent one, which is the whole point.
    expect(notice).not.toBeNull();
    // It claims no POSITION. A steer sent behind two waiting messages lands
    // third, so "your next message" would be a fresh small lie.
    expect(notice).not.toMatch(/next message|first|front/i);
  });

  it('says NOTHING for not-stageable — the transcript already said it (DOR-1307)', () => {
    // A stage that folded joins no queue, so there is no row for a chip to sit
    // on, and the person has already been told in the place they are looking:
    // `StagedContextNote` renders "Added context for the next reply" above their
    // own words. A second sentence here would either duplicate that or imply a
    // failure, and nothing failed — the words land on the next reply either way.
    expect(queueDowngradeNotice(downgraded('not-stageable'))).toBeNull();
  });

  it('says the task is still running and where the words went, claiming no ending (DOR-1315)', () => {
    // The reported failure: a steer sent 5s into a visibly running turn came back
    // downgraded, and the chip read "Queued. The task had already finished." The
    // task had NOT finished — something else was running it — and the server never
    // checked whether it had. The chip now says only what the server verified.
    const notice = queueDowngradeNotice(downgraded('turn-owned-elsewhere'));
    expect(notice).toBe('Couldn’t cut in: something else is running it. It’s waiting in line.');
    // No claim about the task being over, in any wording. This is the assertion
    // the old copy failed.
    expect(notice).not.toMatch(/finish|done|over|ended|complete/i);
    expect(notice).not.toMatch(/window|tab|browser/i);
    // And it is not the silent one: the words really did go to the back of the
    // line, so staying quiet would be the DOR-1268 lie again.
    expect(notice).not.toBeNull();
  });

  it('explains a turn parked on the person', () => {
    expect(queueDowngradeNotice(downgraded('pending-interaction'))).toBe(
      'Queued. The agent needs your answer first.'
    );
  });

  it('uses no em dashes (house style) in any notice it can produce', () => {
    const reasons: NonNullable<MessageDeliveryOutcome['degradedBecause']>[] = [
      'unsupported',
      'not-steerable',
      'turn-owned-elsewhere',
      'pending-interaction',
    ];
    for (const reason of reasons) {
      expect(queueDowngradeNotice(downgraded(reason))).not.toContain('—');
    }
  });
});

describe('a message held for background work (DOR-2065)', () => {
  const held = (over: Partial<QueuedWaitingOn> = {}): QueuedWaitingOn => ({
    reason: 'background-work',
    holding: { agents: 2, shells: 0, other: 0 },
    pins: ['cwd'],
    targetFolderName: 'dorkos-cloud',
    since: 1,
    releaseAt: 2,
    ...over,
  });
  const row = (id: string, waitingOn?: QueuedWaitingOn): QueuedMessage => ({
    id,
    content: id,
    disposition: 'queue',
    enqueuedAt: 1,
    enqueuedBy: 'me',
    ...(waitingOn ? { waitingOn } : {}),
  });

  it('says what it waits on and what sending it changes', () => {
    expect(describeWaitingOn(held())).toEqual({
      line: 'Held for 2 helpers. Sending it moves to dorkos-cloud.',
      switchHint: 'Switching now stops 2 helpers.',
    });
    expect(
      describeWaitingOn(
        held({ holding: { agents: 1, shells: 2, other: 1 }, pins: ['systemPromptAppend'] })
      ).line
    ).toBe(
      'Held for 1 helper, 2 commands and 1 background job. Sending it loads new instructions.'
    );
    expect(describeWaitingOn(held({ pins: ['agentIdentity'] })).line).toBe(
      'Held for 2 helpers. Sending it switches agents.'
    );
    expect(describeWaitingOn(held({ pins: ['effort'] })).line).toBe(
      'Held for 2 helpers. Sending it applies new settings.'
    );
  });

  it('never calls a Monitor a task, the name of the Tasks product', () => {
    const { line } = describeWaitingOn(held({ holding: { agents: 0, shells: 0, other: 2 } }));
    expect(line).toBe('Held for 2 background jobs. Sending it moves to dorkos-cloud.');
    expect(line).not.toMatch(/task/i);
  });

  it('says what it is when nothing is running in the background', () => {
    const none = { agents: 0, shells: 0, other: 0 };
    expect(describeWaitingOn(held({ holding: none, because: 'delivery-owed' })).line).toBe(
      'Held for a helper’s report. Sending it moves to dorkos-cloud.'
    );
    expect(describeWaitingOn(held({ holding: none, because: 'waiting-on-person' })).line).toBe(
      'Held for your answer. Sending it moves to dorkos-cloud.'
    );
    const timer = describeWaitingOn(held({ holding: none, because: 'timer-pending' }));
    expect(timer.line).toBe('Held for a reminder the agent set. Sending it moves to dorkos-cloud.');
    expect(timer.switchHint).toBe('Switching now cancels the reminder.');
    const busy = describeWaitingOn(held({ holding: none, because: 'turn-open' }));
    expect(busy.line).toBe('Held until the agent is free. Sending it moves to dorkos-cloud.');
    expect(busy.line).not.toMatch(/background/);
    expect(busy.switchHint).toBe('Switching now stops what the agent is doing.');
  });

  it('keeps every line within the app’s word limit', () => {
    for (const pins of [['cwd'], ['agentIdentity'], ['systemPromptAppend'], ['effort']]) {
      const worst = describeWaitingOn(held({ holding: { agents: 12, shells: 3, other: 2 }, pins }));
      expect(worst.line.split(/\s+/).length, pins[0]).toBeLessThanOrEqual(15);
    }
  });

  it('shows a held head even with no turn running', () => {
    const queue = [row('a', held()), row('b')];
    expect(selectWaitingQueue(queue, 'idle')).toEqual(queue);
    expect(selectWaitingQueue([row('a'), row('b')], 'idle')).toEqual([row('b')]);
  });
});
