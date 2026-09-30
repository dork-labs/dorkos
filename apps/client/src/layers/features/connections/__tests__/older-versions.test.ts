import { describe, expect, it } from 'vitest';
import { olderVersionIds } from '../lib/older-versions';

const row = (operationRevisionId: string, operationSlug: string, toolkitVersion: string) => ({
  operationRevisionId,
  operationSlug,
  toolkitVersion,
});

describe('olderVersionIds', () => {
  it('marks only the older rows of an action listed twice', () => {
    expect(
      olderVersionIds([
        row('send-v10', 'gmail.send', '10'),
        row('send-v2', 'gmail.send', '2'),
        row('list-v1', 'gmail.list', '1'),
      ])
    ).toEqual(new Set(['send-v2']));
  });

  it('orders dated versions and marks nothing when every action appears once', () => {
    expect(
      olderVersionIds([row('a', 'gmail.send', '2026-08-01'), row('b', 'gmail.send', '2026-09-01')])
    ).toEqual(new Set(['a']));
    expect(olderVersionIds([row('a', 'gmail.send', '1'), row('b', 'gmail.list', '1')]).size).toBe(
      0
    );
  });

  it('never flags rows that share both the action and the version', () => {
    expect(olderVersionIds([row('a', 'gmail.send', '2'), row('b', 'gmail.send', '2')]).size).toBe(
      0
    );
  });
});
