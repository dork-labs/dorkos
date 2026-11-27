import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDocLinkMethods } from '../doc-link-methods';
import { answer, firstRequest } from './request-stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createDocLinkMethods', () => {
  const methods = createDocLinkMethods('/api');

  it('resolves a link from a doc, `from` last in the query', async () => {
    const fetchMock = answer({ doc: null, complete: true });
    await methods.resolveDocLink('/w s', 'Plan & notes', 'a/b.md');
    expect(firstRequest(fetchMock)).toEqual({
      url: '/api/documents/resolve?cwd=%2Fw+s&target=Plan+%26+notes&from=a%2Fb.md',
      method: 'GET',
      body: undefined,
    });
  });

  it('leaves `from` out when there is none', async () => {
    const fetchMock = answer({ doc: null, complete: true });
    await methods.resolveDocLink('/w', 'Plan', null);
    expect(firstRequest(fetchMock).url).toBe('/api/documents/resolve?cwd=%2Fw&target=Plan');
  });
});
