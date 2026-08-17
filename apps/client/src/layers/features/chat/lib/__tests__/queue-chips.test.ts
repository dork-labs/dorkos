import { describe, it, expect } from 'vitest';
import type { MessageDeliveryOutcome } from '@dorkos/shared/schemas';
import { queueDowngradeNotice } from '../queue-chips';

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
    expect(notice).toBe("Queued. This agent can't take a message mid-task.");
    // Never leaks the machinery.
    expect(notice).not.toMatch(/steer|stage|disposition|degrad|unsupported/i);
  });

  it('owns up to a cut-in that could not happen (DOR-1268)', () => {
    // The case `session-idle` used to swallow: a turn WAS running, it could not
    // be joined, and the message really did go to the back of the line. Staying
    // quiet about that was the lie.
    const notice = queueDowngradeNotice(downgraded('not-steerable'));
    expect(notice).toBe("Couldn't cut in. Queued as your next message.");
    expect(notice).not.toMatch(/steer|stage|disposition|degrad|session|runtime/i);
    // And it is NOT the silent one, which is the whole point.
    expect(notice).not.toBeNull();
  });

  it('explains a turn that closed first', () => {
    expect(queueDowngradeNotice(downgraded('no-open-turn'))).toBe(
      'Queued. The task had already finished.'
    );
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
      'no-open-turn',
      'pending-interaction',
    ];
    for (const reason of reasons) {
      expect(queueDowngradeNotice(downgraded(reason))).not.toContain('—');
    }
  });
});
