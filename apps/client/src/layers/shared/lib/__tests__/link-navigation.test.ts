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

  it('treats mailto: as dispatchable — a browser hands it to the OS from any page', () => {
    // Deliberately reports success even though the desktop shell denies it
    // today: the line this allowlist draws is what the *browser* will refuse,
    // not what one shell currently declines.
    expect(classifyLink('mailto:hi@dorkos.ai', FROM)).toEqual({
      kind: 'external',
      url: 'mailto:hi@dorkos.ai',
    });
  });

  it('blocks a file: target from the http cockpit — opening one is a guaranteed no-op', () => {
    // Browsers block file: from an http: page and the desktop shell forwards
    // only http(s), so reporting success here would be a lie. An MCP server
    // naming `file:///…/authorize.html` must not produce a confirm button.
    expect(classifyLink('file:///Users/kai/notes.md', FROM)).toEqual({
      kind: 'blocked',
      reason: 'unsupported-scheme',
    });
  });

  it('allows a file: target from a file: page — the only surface where it works', () => {
    expect(
      classifyLink('file:///Users/kai/notes.md', 'file:///Applications/DorkOS/index.html')
    ).toMatchObject({ kind: 'external' });
  });

  it('blocks a scheme nothing in the app opens', () => {
    // Allowlist, not denylist: an unknown scheme is refused rather than
    // forwarded, because untrusted surfaces choose these strings.
    expect(classifyLink('dorkos://session/abc', FROM)).toEqual({
      kind: 'blocked',
      reason: 'unsupported-scheme',
    });
    expect(classifyLink('blob:http://localhost:4242/9f2c', FROM)).toEqual({
      kind: 'blocked',
      reason: 'unsupported-scheme',
    });
    expect(classifyLink('filesystem:http://localhost:4242/temporary/x', FROM)).toEqual({
      kind: 'blocked',
      reason: 'unsupported-scheme',
    });
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
      reason: 'unsupported-scheme',
    });
    expect(classifyLink('data:text/html,<script>alert(1)</script>', FROM)).toEqual({
      kind: 'blocked',
      reason: 'unsupported-scheme',
    });
    expect(classifyLink('  JavaScript:alert(1)', FROM)).toEqual({
      kind: 'blocked',
      reason: 'unsupported-scheme',
    });
    expect(classifyLink('vbscript:msgbox(1)', FROM)).toEqual({
      kind: 'blocked',
      reason: 'unsupported-scheme',
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

  it('keeps working from a file:// base (the electron-vite preview renderer)', () => {
    // `loadFile` puts the renderer on file://, where a relative in-app link
    // inherits `file:`. Dropping it from the allowlist would block every
    // internal link in that mode, so this pins it.
    const from = 'file:///Applications/DorkOS.app/renderer/index.html';
    expect(classifyLink('/tasks', from)).toMatchObject({ kind: 'internal', path: '/tasks' });
    expect(classifyLink('https://dorkos.ai', from)).toMatchObject({ kind: 'external' });
  });

  it('degrades safely from an app:// base (the Obsidian embed)', () => {
    // Obsidian's own page origin. Absolute links still classify normally; a
    // relative one inherits `app:`, which nothing in the app opens, so it is
    // refused rather than turned into an `app://obsidian.md/...` navigation.
    // The embed has no router either way, so no reachable behavior is lost.
    const from = 'app://obsidian.md/index.html';
    expect(classifyLink('https://dorkos.ai/docs', from)).toEqual({
      kind: 'external',
      url: 'https://dorkos.ai/docs',
    });
    expect(classifyLink('/agents', from)).toEqual({
      kind: 'blocked',
      reason: 'unsupported-scheme',
    });
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

    it('opens an internal target with exactly two arguments — never noopener', () => {
      // The desktop shell's window-open handler has to be able to tell our own
      // cockpit from someone else's site; a `noopener` third argument here
      // would forfeit that. Asserting the whole call pins the arity.
      openLink('/tasks', { newTab: true });
      expect(openSpy).toHaveBeenCalledWith(expect.any(String), '_blank');
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

    it('reports whether the link was actually dispatched', () => {
      expect(openLink('/tasks')).toBe(true);
      expect(openLink('/tasks', { newTab: true })).toBe(true);
      expect(openLink('https://dorkos.ai')).toBe(true);
      expect(openLink('myapp://authorize')).toBe(false);
      expect(openLink('javascript:alert(1)')).toBe(false);
      unregister();
      // Internal with nowhere to route it is a no-op, and must say so.
      expect(openLink('/tasks')).toBe(false);
    });
  });

  describe('openExternalLink', () => {
    it('leaves the app even for one of our own routes', () => {
      // The LinkSafetyModal's contract is "this leaves what you are looking
      // at". A gen-UI widget, MCP App, or elicitation payload naming `/agents`
      // must not navigate the session out from under the reader.
      openExternalLink('/session');
      expect(openSpy).toHaveBeenCalledWith(
        `${window.location.origin}/session`,
        '_blank',
        'noopener,noreferrer'
      );
      expect(navigated).toEqual([]);
    });

    it('still opens with no router registered', () => {
      // The Obsidian embed mounts no router (App.tsx). Confirmed-link opens
      // must not fall into the internal warn-and-do-nothing branch there.
      unregister();
      openExternalLink('https://dorkos.ai/docs');
      expect(openSpy).toHaveBeenCalledWith(
        'https://dorkos.ai/docs',
        '_blank',
        'noopener,noreferrer'
      );
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('still opens in the embed, router or not', () => {
      setPlatformAdapter(embeddedPlatform);
      unregister();
      openExternalLink('https://dorkos.ai/docs');
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(navigated).toEqual([]);
    });

    it('refuses a script-bearing scheme', () => {
      openExternalLink('javascript:alert(1)');
      expect(openSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
    });

    it('reports whether the link was actually dispatched', () => {
      // Callers that tell the user something happened must gate on this.
      // A refusal is otherwise silent, and silence reads as success.
      expect(openExternalLink('https://dorkos.ai/docs')).toBe(true);
      expect(openExternalLink('/session')).toBe(true);
      expect(openExternalLink('myapp://authorize')).toBe(false);
      expect(openExternalLink('javascript:alert(1)')).toBe(false);
      expect(openExternalLink('http://')).toBe(false);
      // A file: target from the http cockpit cannot open, so it must not claim to.
      expect(openExternalLink('file:///Users/kai/authorize.html')).toBe(false);
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
