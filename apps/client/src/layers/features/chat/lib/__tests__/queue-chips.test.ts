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
    expect(notice).toBe("Couldn't cut in. It's waiting in line.");
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
    expect(notice).toBe(
      "Couldn't cut in. Something else is running this task, so it's waiting in line."
    );
    // No claim about the task being over, in any wording. This is the assertion
    // the old copy failed.
    expect(notice).not.toMatch(/finish|done|over|ended|complete/i);
    // And no claim about WHO holds it. The lock holder is a client id: a room
    // (`ROOMS.CLIENT_ID`), an MCP sign-in resume, or the Obsidian transport all
    // hold turns with no window anywhere, so "another window" would be a fresh
    // unchecked assertion in the sentence written to remove one.
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
