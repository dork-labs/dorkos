import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { browserKeys } from '../index';
describe('browser owner and original-generation query keys', () => {
  it('does not reuse one person’s cached metadata for another person', () => {
    const cache = new QueryClient();
    cache.setQueryData(browserKeys.profiles('alice'), [{ profileId: 'private-profile' }]);
    expect(cache.getQueryData(browserKeys.profiles('bob'))).toBeUndefined();
    expect(cache.getQueryData(browserKeys.profiles('alice'))).toEqual([
      { profileId: 'private-profile' },
    ]);
  });
  it('does not treat a replacement browser generation as the original', () => {
    const cache = new QueryClient();
    cache.setQueryData(browserKeys.instance('alice', 'same-browser', 1), { status: 'uncertain' });
    expect(cache.getQueryData(browserKeys.instance('alice', 'same-browser', 2))).toBeUndefined();
    expect(browserKeys.instance('bob', 'same-browser', 1)).not.toEqual(
      browserKeys.instance('alice', 'same-browser', 1)
    );
  });
});
