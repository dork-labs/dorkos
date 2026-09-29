import { describe, expect, it } from 'vitest';
import {
  EXTENSION_PAGE_PATH_PATTERN,
  extensionPageHref,
  hasPageParams,
  matchExtensionPage,
  parseExtensionPagePath,
} from '../extension-page-path';
import { classifyLink, internalRoutePath } from '../link-navigation';

const FROM = 'http://localhost:4242/session';

describe('parseExtensionPagePath', () => {
  it('reads the extension and subpath off a page address', () => {
    expect(parseExtensionPagePath('/x/flow')).toEqual({ extensionId: 'flow', subpath: '' });
    expect(parseExtensionPagePath('/x/flow/')).toEqual({ extensionId: 'flow', subpath: '' });
    expect(parseExtensionPagePath('/x/flow/p/dorkos')).toEqual({
      extensionId: 'flow',
      subpath: 'p/dorkos',
    });
  });

  it('answers null for any other route, and for an id no extension could have', () => {
    expect(parseExtensionPagePath('/session')).toBeNull();
    expect(parseExtensionPagePath('/x')).toBeNull();
    expect(parseExtensionPagePath('/x/')).toBeNull();
    expect(parseExtensionPagePath('/x/Flow')).toBeNull();
    expect(parseExtensionPagePath('/x/-flow')).toBeNull();
    expect(parseExtensionPagePath('/xx/flow')).toBeNull();
  });
});

describe('registerPage path rule', () => {
  it.each(['', 'settings', 'p/:name', 'p/:name/runs', 'a-b/c1'])('accepts %j', (path) => {
    expect(EXTENSION_PAGE_PATH_PATTERN.test(path)).toBe(true);
  });

  it.each(['/', '/settings', 'p/', 'P/x', 'p/:Name', 'p/:', 'a//b', 'a b', '../x'])(
    'refuses %j',
    (path) => {
      expect(EXTENSION_PAGE_PATH_PATTERN.test(path)).toBe(false);
    }
  );

  it('tells a param path from a literal one', () => {
    expect(hasPageParams('p/:name')).toBe(true);
    expect(hasPageParams('settings')).toBe(false);
    expect(hasPageParams('')).toBe(false);
  });

  it('builds the address of a page with no params', () => {
    expect(extensionPageHref('flow', '')).toBe('/x/flow');
    expect(extensionPageHref('flow', 'settings')).toBe('/x/flow/settings');
  });
});

describe('matchExtensionPage', () => {
  const pages = [
    { path: '' },
    { path: 'p/:name' },
    { path: 'p/new' },
    { path: ':section/:item' },
    { path: 'runs/:id' },
  ];

  it('matches the home to the empty subpath only', () => {
    expect(matchExtensionPage(pages, '')?.page.path).toBe('');
    expect(matchExtensionPage([{ path: '' }], 'extra')).toBeNull();
  });

  it('fills params, decoded', () => {
    expect(matchExtensionPage(pages, 'p/my%20repo')).toEqual({
      page: { path: 'p/:name' },
      params: { name: 'my repo' },
    });
  });

  it('prefers literal segments before params', () => {
    expect(matchExtensionPage(pages, 'p/new')?.page.path).toBe('p/new');
    // `runs/:id` has a literal first segment, so it beats `:section/:item`.
    expect(matchExtensionPage(pages, 'runs/7')?.page.path).toBe('runs/:id');
    expect(matchExtensionPage(pages, 'other/7')).toEqual({
      page: { path: ':section/:item' },
      params: { section: 'other', item: '7' },
    });
  });

  it('answers null when no page has that shape', () => {
    expect(matchExtensionPage(pages, 'a/b/c')).toBeNull();
    expect(matchExtensionPage([], '')).toBeNull();
  });
});

describe('the link seam and extension pages (spec flow-multiproject §6.5, D4)', () => {
  it('treats an extension page as an in-app route, query included', () => {
    expect(classifyLink('/x/hello/p/one?x=1', FROM)).toEqual({
      kind: 'internal',
      url: 'http://localhost:4242/x/hello/p/one?x=1',
      path: '/x/hello/p/one?x=1',
    });
    expect(internalRoutePath('/x/flow')).toBe('/x/flow');
  });

  it('refuses what is not an in-app page', () => {
    expect(internalRoutePath('https://evil.example/x/flow')).toBeNull();
    expect(internalRoutePath('//evil.example/x/flow')).toBeNull();
    expect(internalRoutePath('javascript:alert(1)')).toBeNull();
    expect(internalRoutePath('/x/Not_An_Id')).toBeNull();
  });
});
