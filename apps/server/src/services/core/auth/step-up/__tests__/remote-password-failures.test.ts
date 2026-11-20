import { beforeEach, describe, expect, it } from 'vitest';
import { OWNER_PASSWORD_FAILURE_WINDOW_MS } from '../../owner-password.js';
import {
  clearRemotePasswordFailures,
  noteRemotePasswordFailure,
  resetRemotePasswordFailuresForTests,
} from '../remote-password-failures.js';

beforeEach(resetRemotePasswordFailuresForTests);

describe('remote wrong-password notices', () => {
  it('notifies once after five actual failures from the same device', () => {
    expect(Array.from({ length: 6 }, () => noteRemotePasswordFailure('phone', 100))).toEqual([
      false,
      false,
      false,
      false,
      true,
      false,
    ]);
  });

  it('does not combine different devices or failures outside the window', () => {
    for (let attempt = 0; attempt < 4; attempt++) noteRemotePasswordFailure('phone', 100);
    expect(noteRemotePasswordFailure('tablet', 100)).toBe(false);
    expect(noteRemotePasswordFailure('phone', 100 + OWNER_PASSWORD_FAILURE_WINDOW_MS)).toBe(false);
  });

  it('a correct password starts that device afresh', () => {
    for (let attempt = 0; attempt < 4; attempt++) noteRemotePasswordFailure('phone', 100);
    clearRemotePasswordFailures('phone');
    expect(noteRemotePasswordFailure('phone', 100)).toBe(false);
  });
});
