/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  APP_ROUTE_PATHS,
  classifyLink,
  openExternalLink,
  openLink,
  registerLinkNavigator,
  supportsNewTab,
  type LinkNavigation,
} from '../link-navigation';
import { setPlatformAdapter } from '../platform';

const ORIGIN = 'http://localhost:4242';
const FROM = `${ORIGIN}/agents?view=topology`;

const webPlatform = { isEmbedded: false, openFile: async () => {} };
const embeddedPlatform = { isEmbedded: true, openFile: async () => {} };

describe('classifyLink', () => {
  it('treats a relative path on an app route as internal', () => {
    expect(classifyLink('/session?session=abc', FROM)).toEqual({
      kind: 'internal',
      url: `${ORIGIN}/session?session=abc`,
      path: '/session?session=abc',
    });
  });

  it('treats an absolute same-origin app route as internal', () => {
    expect(classifyLink(`${ORIGIN}/tasks`, FROM)).toEqual({
      kind: 'internal',
      url: `${ORIGIN}/tasks`,
      path: '/tasks',
    });
  });

  it('keeps a nested app route internal', () => {
    const link = classifyLink('/marketplace/sources', FROM);
    expect(link).toMatchObject({ kind: 'internal', path: '/marketplace/sources' });
  });

  it('ignores a trailing slash when matching a route', () => {
    expect(classifyLink('/session/', FROM)).toMatchObject({
      kind: 'internal',
      path: '/session',
    });
  });

  it('treats a hash-only href as internal to the current route', () => {
    expect(classifyLink('#section', FROM)).toMatchObject({
      kind: 'internal',
      path: '/agents?view=topology#section',
    });
  });

  it('merges a query-only href into the current search', () => {
    // The dialog deep links are written this way (`?settings=open`): they are a
    // modifier on wherever you already are, so the route's own params survive.
    expect(classifyLink('?settings=open', FROM)).toMatchObject({
      kind: 'internal',
      path: '/agents?view=topology&settings=open',
    });
  });

  it('lets a query-only href override a param it names', () => {
    expect(classifyLink('?view=list', FROM)).toMatchObject({
      kind: 'internal',
      path: '/agents?view=list',
    });
  });

  it('replaces the search when the href carries a path', () => {
    expect(classifyLink('/agents?view=list', FROM)).toMatchObject({
      kind: 'internal',
      path: '/agents?view=list',
    });
  });

  it('treats another origin as external', () => {
    expect(classifyLink('https://dorkos.ai/docs', FROM)).toEqual({
      kind: 'external',
      url: 'https://dorkos.ai/docs',
    });
  });

  it('treats a protocol-relative href as external, not as a path', () => {
    expect(classifyLink('//evil.com/steal', FROM)).toEqual({
      kind: 'external',
      url: 'http://evil.com/steal',
    });
  });

  it('treats mailto: as external', () => {
    expect(classifyLink('mailto:hi@dorkos.ai', FROM)).toEqual({
      kind: 'external',
      url: 'mailto:hi@dorkos.ai',
    });
  });

  it('treats a custom scheme as external', () => {
    expect(classifyLink('dorkos://session/abc', FROM)).toMatchObject({ kind: 'external' });
  });

  it('treats a same-origin path the router does not serve as external', () => {
    // `/dev` mounts outside the router and `/api/...` is the server's; both are
    // same-origin, neither is an app route.
    expect(classifyLink('/dev', FROM)).toEqual({ kind: 'external', url: `${ORIGIN}/dev` });
    expect(classifyLink('/api/uploads/shot.png', FROM)).toMatchObject({ kind: 'external' });
  });

  it('blocks script-bearing schemes', () => {
    expect(classifyLink('javascript:alert(1)', FROM)).toEqual({
      kind: 'blocked',
      reason: 'unsafe-scheme',
    });
    expect(classifyLink('data:text/html,<script>alert(1)</script>', FROM)).toEqual({
      kind: 'blocked',
      reason: 'unsafe-scheme',
    });
    expect(classifyLink('  JavaScript:alert(1)', FROM)).toEqual({
      kind: 'blocked',
      reason: 'unsafe-scheme',
    });
  });

  it('blocks malformed input instead of throwing', () => {
    expect(classifyLink('http://', FROM)).toEqual({ kind: 'blocked', reason: 'unparsable' });
    expect(classifyLink('https://[', FROM)).toEqual({ kind: 'blocked', reason: 'unparsable' });
    expect(classifyLink('', FROM)).toEqual({ kind: 'blocked', reason: 'unparsable' });
    expect(classifyLink('   ', FROM)).toEqual({ kind: 'blocked', reason: 'unparsable' });
  });

  it('blocks a malformed base instead of throwing', () => {
    expect(classifyLink('/session', 'not-a-url')).toEqual({
      kind: 'blocked',
      reason: 'unparsable',
    });
  });

  it('defaults its base to the current page', () => {
    // jsdom serves the tests from localhost, whose root path is an app route.
    expect(classifyLink('/tasks')).toMatchObject({ kind: 'internal', path: '/tasks' });
  });

  it('classifies every declared app route as internal', () => {
    for (const route of APP_ROUTE_PATHS) {
      expect(classifyLink(route, FROM), route).toMatchObject({ kind: 'internal' });
    }
  });
});

describe('link dispatch', () => {
  let navigated: LinkNavigation[];
  let unregister: () => void;
  let openSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    navigated = [];
    unregister = registerLinkNavigator((navigation) => navigated.push(navigation));
    openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setPlatformAdapter(webPlatform);
  });

  afterEach(() => {
    unregister();
    openSpy.mockRestore();
    warnSpy.mockRestore();
    setPlatformAdapter(webPlatform);
  });

  describe('openLink', () => {
    it('routes an internal link instead of loading a document', () => {
      openLink('/tasks');
      expect(navigated).toEqual([{ href: '/tasks', replace: undefined }]);
      expect(openSpy).not.toHaveBeenCalled();
    });

    it('passes the replace intent through to the router', () => {
      openLink('/tasks', { replace: true });
      expect(navigated).toEqual([{ href: '/tasks', replace: true }]);
    });

    it('opens an internal link in a second cockpit window on request', () => {
      openLink('/session?dir=%2Ftmp', { newTab: true });
      expect(openSpy).toHaveBeenCalledWith(
        `${window.location.origin}/session?dir=%2Ftmp`,
        '_blank'
      );
      expect(navigated).toEqual([]);
    });

    it('hands an external link to the browser', () => {
      openLink('https://dorkos.ai/docs');
      expect(openSpy).toHaveBeenCalledWith(
        'https://dorkos.ai/docs',
        '_blank',
        'noopener,noreferrer'
      );
      expect(navigated).toEqual([]);
    });

    it('hands a same-origin non-route path to the browser', () => {
      openLink('/dev', { newTab: true });
      expect(openSpy).toHaveBeenCalledWith(
        `${window.location.origin}/dev`,
        '_blank',
        'noopener,noreferrer'
      );
    });

    it('refuses a script-bearing scheme', () => {
      openLink('javascript:alert(1)');
      expect(openSpy).not.toHaveBeenCalled();
      expect(navigated).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('navigates in place instead of opening a window in the embed', () => {
      setPlatformAdapter(embeddedPlatform);
      openLink('/tasks', { newTab: true });
      expect(openSpy).not.toHaveBeenCalled();
      expect(navigated).toEqual([{ href: '/tasks', replace: undefined }]);
    });

    it('warns rather than forcing a document load when no router is registered', () => {
      unregister();
      openLink('/tasks');
      expect(openSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
    });

    it('still reaches the browser for external links with no router registered', () => {
      unregister();
      openLink('https://dorkos.ai');
      expect(openSpy).toHaveBeenCalled();
    });
  });

  describe('openExternalLink', () => {
    it('leaves the app even for one of our own routes', () => {
      openExternalLink('/session');
      expect(openSpy).toHaveBeenCalledWith(
        `${window.location.origin}/session`,
        '_blank',
        'noopener,noreferrer'
      );
      expect(navigated).toEqual([]);
    });

    it('refuses a script-bearing scheme', () => {
      openExternalLink('javascript:alert(1)');
      expect(openSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe('supportsNewTab', () => {
    it('is true in the browser and false in the embed', () => {
      expect(supportsNewTab()).toBe(true);
      setPlatformAdapter(embeddedPlatform);
      expect(supportsNewTab()).toBe(false);
    });
  });

  describe('registerLinkNavigator', () => {
    it('only lets an unregister clear its own adapter', () => {
      const stale = registerLinkNavigator(() => {});
      const latest: LinkNavigation[] = [];
      const clearLatest = registerLinkNavigator((navigation) => latest.push(navigation));

      stale();
      openLink('/tasks');
      expect(latest).toHaveLength(1);

      clearLatest();
    });
  });
});
