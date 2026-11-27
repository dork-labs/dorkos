import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSearchMethods } from '../search-methods';
import { answer, firstRequest } from './request-stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createSearchMethods', () => {
  const methods = createSearchMethods('/api');

  it('sends q, limit and source in that order', async () => {
    const fetchMock = answer({ results: [] });
    await methods.search({ q: 'a b&c', limit: 5, source: 'rooms' });
    expect(firstRequest(fetchMock)).toEqual({
      url: '/api/search?q=a+b%26c&limit=5&source=rooms',
      method: 'GET',
      body: undefined,
    });
  });

  it('leaves out what was not given, never the word `undefined`', async () => {
    const fetchMock = answer({ results: [] });
    await methods.search({ q: 'x' });
    expect(firstRequest(fetchMock).url).toBe('/api/search?q=x');
  });
});
