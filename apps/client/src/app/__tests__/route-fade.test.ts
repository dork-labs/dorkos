import { describe, expect, it } from 'vitest';
import { routedPageKey, shouldFadeRoute } from '../route-fade';

describe('shouldFadeRoute', () => {
  it('fades when the reader has not asked for less motion', () => {
    expect(shouldFadeRoute(false)).toBe(true);
  });

  it('is a hard off under reduced motion', () => {
    expect(shouldFadeRoute(true)).toBe(false);
  });
});

describe('routedPageKey', () => {
  it('is the deepest match’s path — the page the outlet draws', () => {
    expect(routedPageKey([{ pathname: '/' }, { pathname: '/' }, { pathname: '/activity' }])).toBe(
      '/activity'
    );
  });

  it('keeps a filled-in path, so two extension pages are two keys', () => {
    expect(routedPageKey([{ pathname: '/' }, { pathname: '/x/linear/issues' }])).toBe(
      '/x/linear/issues'
    );
  });

  it('is empty before anything has matched', () => {
    expect(routedPageKey([])).toBe('');
  });
});
