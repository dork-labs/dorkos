import { describe, it, expect } from 'vitest';
import { mayApprove, toIdList } from '../approver-allowlist.js';

/**
 * DOR-609. Closing the runtime permission gate (DOR-604) turns a zero-click
 * shell command into a one-click one; this list is what makes the click mean
 * something. Every case below is stated as "who may authorize", not "who acted".
 */
describe('mayApprove — empty means nobody', () => {
  it('refuses everyone when no allowlist is configured', () => {
    expect(mayApprove(undefined, 'U123')).toBe(false);
    expect(mayApprove([], 'U123')).toBe(false);
  });

  it('refuses a user who is not named, including the one who asked', () => {
    expect(mayApprove(['U_OPERATOR'], 'U_ATTACKER')).toBe(false);
  });

  it('allows a user who is named', () => {
    expect(mayApprove(['U_OPERATOR'], 'U_OPERATOR')).toBe(true);
  });

  it('refuses an unidentified caller even against a populated list', () => {
    expect(mayApprove(['U_OPERATOR'], undefined)).toBe(false);
    expect(mayApprove(['U_OPERATOR'], '')).toBe(false);
  });

  it('refuses when the allowlist is a shape it cannot read', () => {
    expect(mayApprove('not-a-list-and-not-newlines' as unknown, 'U123')).toBe(false);
    expect(mayApprove(42 as unknown, 'U123')).toBe(false);
    expect(mayApprove(null, 'U123')).toBe(false);
  });

  it('reads the newline-per-id shape the setup textarea produces', () => {
    expect(mayApprove('U_ONE\nU_TWO\n', 'U_TWO')).toBe(true);
    expect(mayApprove('U_ONE\nU_TWO\n', 'U_THREE')).toBe(false);
  });
});

describe('toIdList', () => {
  it('trims and drops blank lines from the textarea shape', () => {
    expect(toIdList('  U_ONE  \n\n U_TWO \n')).toEqual(['U_ONE', 'U_TWO']);
  });

  it('keeps only string entries from an array', () => {
    expect(toIdList(['U_ONE', 42, null, 'U_TWO', ''])).toEqual(['U_ONE', 'U_TWO']);
  });

  it('returns an empty list for anything else', () => {
    expect(toIdList(undefined)).toEqual([]);
    expect(toIdList({})).toEqual([]);
  });
});
