import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  PAGE_BADGE_SENTENCE_MAX,
  PAGE_BADGE_STATUSES,
  pageBadgeProblem,
  copyPageBadge,
  type ExtensionAPI,
  type ExtensionPageBadge,
  type PageBadgeStatus,
} from '../index.js';

describe('pageBadgeProblem', () => {
  it.each<[string, unknown]>([
    ['an empty badge', {}],
    ['a status alone', { status: 'needs-you' }],
    ['a count of zero', { count: 0 }],
    ['every field', { status: 'working', count: 3, sentence: 'Sorting 3 ideas' }],
    ['a sentence of exactly the limit', { sentence: 'x'.repeat(PAGE_BADGE_SENTENCE_MAX) }],
  ])('accepts %s', (_name, badge) => {
    expect(pageBadgeProblem(badge)).toBeNull();
  });

  it('accepts every status the host draws', () => {
    for (const status of PAGE_BADGE_STATUSES) expect(pageBadgeProblem({ status })).toBeNull();
  });

  it.each<[string, unknown, RegExp]>([
    ['a string', 'needs-you', /object/],
    ['an array', [], /object/],
    ['an unknown status', { status: 'urgent' }, /status must be one of/],
    ['a negative count', { count: -1 }, /whole number/],
    ['a fractional count', { count: 1.5 }, /whole number/],
    ['a count that is not a number', { count: '3' }, /whole number/],
    ['a sentence that is not a string', { sentence: 3 }, /string/],
    ['a sentence over the limit', { sentence: 'x'.repeat(81) }, /at most 80/],
  ])('refuses %s, saying why', (_name, badge, why) => {
    expect(pageBadgeProblem(badge)).toMatch(why);
  });
});

describe('copyPageBadge', () => {
  it('trims the sentence and drops what is empty', () => {
    expect(copyPageBadge({ status: 'new', sentence: '  3 new  ' })).toEqual({
      status: 'new',
      sentence: '3 new',
    });
    expect(copyPageBadge({ count: 0, sentence: '   ' })).toEqual({ count: 0 });
  });

  it('hands back a new object', () => {
    const badge = { count: 1 };
    expect(copyPageBadge(badge)).not.toBe(badge);
  });
});

describe('the setPageBadge type', () => {
  it('takes a page path and a badge or null', () => {
    expectTypeOf<ExtensionAPI['setPageBadge']>().toEqualTypeOf<
      (path: string, badge: ExtensionPageBadge | null) => void
    >();
  });

  it('offers exactly the statuses the tab strip draws', () => {
    expectTypeOf<PageBadgeStatus>().toEqualTypeOf<
      'needs-you' | 'failed' | 'paused' | 'working' | 'new'
    >();
  });
});
