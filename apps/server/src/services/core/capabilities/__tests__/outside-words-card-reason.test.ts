/**
 * A card a turn's outside words raised says why (DOR-3969), and never over a reason the card already
 * names: a paid run's `spend` (which the spending port reads as the person's yes to that run) and
 * the Wi-Fi reason stay what they were. The registry applies this to every connected-app card it
 * raises; `read-marks-turn.test.ts` pins that end to end.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import type { ApprovalServiceAction } from '@dorkos/shared/approval-schemas';
import { withOutsideWordsReason } from '../marked-turn-holds.js';

const ACTION: ApprovalServiceAction = {
  serviceId: 'gmail',
  serviceName: 'Gmail',
  accountLabel: 'Work (work@example.com)',
  actionName: 'Send email',
  details: [{ label: 'To', value: 'ann@example.com' }],
};

/** The reason a card carries after a marked turn's ask. */
const reasonOf = (action: ApprovalServiceAction) =>
  withOutsideWordsReason(action, true)?.keptCardBecause;

describe("the card's reason in a marked turn", () => {
  it('says the turn read outside words when the card names no other reason', () => {
    expect(reasonOf(ACTION)).toBe('outside-words');
  });

  it("keeps a paid run's spend reason", () => {
    expect(reasonOf({ ...ACTION, keptCardBecause: 'spend' })).toBe('spend');
  });

  it('keeps the Wi-Fi reason', () => {
    expect(reasonOf({ ...ACTION, keptCardBecause: 'wifi-open' })).toBe('wifi-open');
  });

  it('adds nothing when the ask was not for outside words', () => {
    expect(withOutsideWordsReason(ACTION, undefined)?.keptCardBecause).toBeUndefined();
  });
});
