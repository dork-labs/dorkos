import { describe, expect, it } from 'vitest';
import { requestCodeForHash } from '../request-code.js';
import { hashApprovalInput } from '../../../approvals/approval-input-hash.js';

describe('request codes', () => {
  it('is stable for the same full hash', () => {
    const hash = hashApprovalInput({ text: 'Read notes.' });
    expect(requestCodeForHash(hash)).toBe(requestCodeForHash(hash));
  });
  it('uses twelve read-aloud characters in three groups', () => {
    for (let i = 0; i < 100; i++) {
      expect(requestCodeForHash(hashApprovalInput({ i }))).toMatch(
        /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}(?:-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}){2}$/
      );
    }
  });
  it('changes when the text changes', () => {
    expect(requestCodeForHash(hashApprovalInput({ text: 'Read notes.' }))).not.toBe(
      requestCodeForHash(hashApprovalInput({ text: 'Read other.' }))
    );
  });
  it('uses the end of the full hash too', () => {
    expect(requestCodeForHash('a'.repeat(64))).not.toBe(requestCodeForHash('a'.repeat(63) + 'b'));
  });
});
