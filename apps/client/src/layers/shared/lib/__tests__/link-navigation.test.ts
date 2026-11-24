/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toast } from 'sonner';
import {
  APP_ROUTE_PATHS,
  classifyLink,
  declaredScheme,
  internalRoutePath,
  isWebUrl,
  plainAppAddress,
  openExternalLink,
  openExternalWindowLater,
  openLink,
  redactForLog,
  registerLinkNavigator,
  registerTabOpener,
  type LinkNavigation,
} from '../link-navigation';

import { enterDesktopShell, leaveDesktopShell } from '@/test-helpers/desktop-shell';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const ORIGIN = 'http://localhost:4242';
const FROM = `${ORIGIN}/team?view=topology`;

describe('declaredScheme', () => {
  it('reads the scheme an href declares for itself', () => {
    expect(declaredScheme('irc://irc.example.com/dorkos')).toBe('irc:');
    expect(declaredScheme('  JavaScript:alert(1)')).toBe('javascript:');
    expect(declaredScheme('mailto:hi@dorkos.ai')).toBe('mailto:');
  });
});

describe('isWebUrl', () => {
  it('accepts absolute http(s) and nothing else', () => {
    expect(isWebUrl('https://dorkos.ai/docs')).toBe(true);
    expect(isWebUrl('http://localhost:4242')).toBe(true);
    // Dispatchable through the seam, still not something to hand a modified
    // click or the desktop shell.
    expect(isWebUrl('mailto:hi@dorkos.ai')).toBe(false);
    expect(isWebUrl('tel:+15551234567')).toBe(false);
    expect(isWebUrl('/team')).toBe(false);
    expect(isWebUrl('//evil.com/steal')).toBe(false);
    expect(isWebUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('classifyLink', () => {
  it('treats a relative path on an app route as internal', () => {
    expect(classifyLink('/session?session=abc', FROM)).toEqual({
      kind: 'internal',
      url: `${ORIGIN}/session?session=abc`,
      path: '/session?session=abc',
    });
  });

  it('treats a hash-only href as internal to the current route', () => {
    expect(classifyLink('#section', FROM)).toMatchObject({
      kind: 'internal',
      path: '/team?view=topology#section',
    });
  });

  it('merges a query-only href into the current search', () => {
    // The dialog deep links are written this way (`?settings=open`): they are a
    // modifier on wherever you already are, so the route's own params survive.
    expect(classifyLink('?settings=open', FROM)).toMatchObject({
      kind: 'internal',
      path: '/team?view=topology&settings=open',
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
    // Deliberately reports success even though the desktop shell denies it today: the line this
    // allowlist draws is what the *browser* will refuse, not what one shell currently declines.
    expect(classifyLink('mailto:hi@dorkos.ai', FROM)).toEqual({
      kind: 'external',
      url: 'mailto:hi@dorkos.ai',
    });
  });

  it('still refuses the chat-only schemes the markdown sanitizer permits', () => {
    // `irc:`, `ircs:` and `xmpp:` are the whole of what Streamdown's sanitizer allows and this
    // list does not.
    for (const href of ['irc://irc.example.com/dorkos', 'ircs://irc.example.com', 'xmpp:a@b.com']) {
      expect(classifyLink(href, FROM), href).toEqual({
        kind: 'blocked',
        reason: 'unsupported-scheme',
      });
    }
  });

  it('blocks a file: target from the http cockpit — opening one is a guaranteed no-op', () => {
    // Browsers block file: from an http: page and the desktop shell forwards only http(s), so
    // reporting success here would be a lie.
    expect(classifyLink('file:///Users/kai/notes.md', FROM)).toEqual({
      kind: 'blocked',
      reason: 'unsupported-scheme',
    });
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

  it('classifies every declared app route as internal', () => {
    for (const route of APP_ROUTE_PATHS) {
      expect(classifyLink(route, FROM), route).toMatchObject({ kind: 'internal' });
    }
  });
});

describe('internalRoutePath', () => {
  // The gate for a path this app did not author: the server's activity `linkPath`, an extension's
  // `navigate(path)` argument (DOR-924).
  it('returns the router path for a route the app serves', () => {
    expect(internalRoutePath('/tasks')).toBe('/tasks');
    expect(internalRoutePath('/agents')).toBe('/agents');
    expect(internalRoutePath('/')).toBe('/');
  });

  it('refuses a path naming no route, rather than inventing one', () => {
    // The router has nowhere to go with these, and `openLink` would answer
    // them by opening a browser tab — the wrong answer for a supplied path.
    expect(internalRoutePath('/session/abc')).toBeNull();
    expect(internalRoutePath('/nope')).toBeNull();
    expect(internalRoutePath('')).toBeNull();
  });

  it('refuses another origin, however it is spelled', () => {
    expect(internalRoutePath('https://evil.example/tasks')).toBeNull();
    // Protocol-relative: a browser resolves this to another host, not a path.
    expect(internalRoutePath('//evil.example/tasks')).toBeNull();
  });

  it('refuses every scheme the seam refuses', () => {
    expect(internalRoutePath('javascript:alert(1)')).toBeNull();
    expect(internalRoutePath('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(internalRoutePath('vbscript:msgbox(1)')).toBeNull();
  });
});

describe('link dispatch', () => {
  let navigated: LinkNavigation[];
  let unregister: () => void;
  let openSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let tabCleanups: (() => void)[];

  /** Register a strip and collect what it opens. */
  function captureTabOpens(): string[] {
    const opened: string[] = [];
    tabCleanups.push(registerTabOpener((href) => opened.push(href)));
    return opened;
  }

  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
    navigated = [];
    tabCleanups = [];
    unregister = registerLinkNavigator((navigation) => navigated.push(navigation));
    openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    unregister();
    tabCleanups.forEach((clear) => clear());
    openSpy.mockRestore();
    warnSpy.mockRestore();
    leaveDesktopShell();
  });

  describe('openLink', () => {
    it('routes an internal link instead of loading a document', () => {
      openLink('/tasks');
      expect(navigated).toEqual([{ href: '/tasks', replace: undefined }]);
      expect(openSpy).not.toHaveBeenCalled();
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

    it('refuses a script-bearing scheme', () => {
      openLink('javascript:alert(1)');
      expect(openSpy).not.toHaveBeenCalled();
      expect(navigated).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('opens an internal target with exactly two arguments — never noopener', () => {
      // The desktop shell's window-open handler has to be able to tell our own cockpit from
      // someone else's site; a `noopener` third argument here would forfeit that.
      enterDesktopShell();
      openLink('/tasks', { target: 'window' });
      expect(openSpy).toHaveBeenCalledWith(expect.any(String), '_blank');
    });

    it('opens an internal link in an in-window tab in the desktop app', () => {
      enterDesktopShell();
      const opened = captureTabOpens();
      openLink('/session?dir=%2Ftmp', { target: 'tab' });
      expect(opened).toEqual(['/session?dir=%2Ftmp']);
      // A tab is not a window and not an in-place navigation.
      expect(openSpy).not.toHaveBeenCalled();
      expect(navigated).toEqual([]);
    });
  });

  describe('openExternalLink', () => {
    it('leaves the app even for one of our own routes', () => {
      // The LinkSafetyModal's contract is "this leaves what you are looking at".
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

    it('uses the desktop shell bridge, which is the only thing that can leave our own origin', () => {
      // `window.open` at `http://localhost:<port>` is claimed by the shell's window-open handler
      // and becomes a second cockpit window — right for "open in a new tab", and a broken promise
      // for everything here.
      const openExternal = vi.fn().mockResolvedValue(undefined);
      window.electronAPI = { openExternal } as unknown as ElectronAPI;
      try {
        expect(openExternalLink(window.location.origin)).toBe(true);
        expect(openExternal).toHaveBeenCalledWith(`${window.location.origin}/`);
        expect(openSpy).not.toHaveBeenCalled();
      } finally {
        delete window.electronAPI;
      }
    });

    it('refuses the same schemes whether or not the shell bridge is there', () => {
      const openExternal = vi.fn().mockResolvedValue(undefined);
      window.electronAPI = { openExternal } as unknown as ElectronAPI;
      try {
        expect(openExternalLink('javascript:alert(1)')).toBe(false);
        expect(openExternal).not.toHaveBeenCalled();
      } finally {
        delete window.electronAPI;
      }
    });

    it('refuses on the desktop what the shell would drop, rather than reporting success (DOR-547)', () => {
      // The ticket's own symptom, one process later.
      const openExternal = vi.fn().mockResolvedValue(true);
      window.electronAPI = { openExternal } as unknown as ElectronAPI;
      try {
        expect(openExternalLink('mailto:hi@dorkos.ai')).toBe(false);
        expect(openExternal).not.toHaveBeenCalled();
        // Whose policy refused it is part of the sentence.
        expect(toast.error).toHaveBeenCalledWith('The desktop app can’t open mailto: links', {
          id: 'dorkos-link-refused',
          description: 'They open from DorkOS in a browser.',
        });
      } finally {
        delete window.electronAPI;
      }
    });
  });

  describe('a refusal says so (DOR-547)', () => {
    it('names the scheme it will not open', () => {
      // The seam owns the policy, so it owns the sentence.
      openExternalLink('irc://irc.example.com/dorkos');

      expect(toast.error).toHaveBeenCalledWith('DorkOS doesn’t open irc: links', {
        id: 'dorkos-link-refused',
        description: 'Only web, email and phone links open.',
      });
    });

    it('refuses every hostile spelling by name, on one message shape', () => {
      // The adversarial probe set, kept permanently. Each of these reaches the
      // seam from something an agent or a remote server authored.
      const probes: [href: string, title: string][] = [
        ['javascript:alert(1)', 'DorkOS doesn’t open javascript: links'],
        ['  JavaScript:alert(1)', 'DorkOS doesn’t open javascript: links'],
        ['JaVaScRiPt:alert(1)', 'DorkOS doesn’t open javascript: links'],
        ['java\tscript:alert(1)', 'DorkOS doesn’t open javascript: links'],
        ['data:text/html,<script>alert(1)</script>', 'DorkOS doesn’t open data: links'],
        ['vbscript:msgbox(1)', 'DorkOS doesn’t open vbscript: links'],
        ['file:///etc/passwd', 'DorkOS doesn’t open file: links'],
        ['blob:http://localhost:4242/9f2c', 'DorkOS doesn’t open blob: links'],
        ['filesystem:http://localhost:4242/temporary/x', 'DorkOS doesn’t open filesystem: links'],
        ['dorkos://session/abc', 'DorkOS doesn’t open dorkos: links'],
        ['myapp://authorize', 'DorkOS doesn’t open myapp: links'],
        ['irc://irc.example.com/dorkos', 'DorkOS doesn’t open irc: links'],
        ['ircs://irc.example.com', 'DorkOS doesn’t open ircs: links'],
        ['xmpp:someone@example.com', 'DorkOS doesn’t open xmpp: links'],
        ['http://', 'DorkOS couldn’t open that link'],
      ];

      for (const [href, title] of probes) {
        vi.mocked(toast.error).mockClear();
        expect(openExternalLink(href), href).toBe(false);
        expect(openSpy, href).not.toHaveBeenCalled();
        expect(toast.error, href).toHaveBeenCalledWith(title, expect.anything());
      }
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

describe('openExternalWindowLater', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete window.electronAPI;
  });

  // Purpose: a window opened after a round trip is a blocked pop-up in Safari; this opens it in
  // the press, without `noopener`, so a block is visible.
  it('opens a blank window at once, severs its opener, and sends it on later', () => {
    const replace = vi.fn();
    const fake = { opener: {} as unknown, location: { replace }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(fake as unknown as Window);
    const pending = openExternalWindowLater();
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(fake.opener).toBeNull();
    expect(pending!.go('https://community.example.invalid/claim/secret')).toBe(true);
    expect(replace).toHaveBeenCalledWith('https://community.example.invalid/claim/secret');
  });

  it('closes the window rather than send it to a link it would refuse', () => {
    const fake = { opener: null, location: { replace: vi.fn() }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(fake as unknown as Window);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pending = openExternalWindowLater();
    expect(pending!.go('javascript:alert(1)')).toBe(false);
    expect(fake.close).toHaveBeenCalled();
    expect(fake.location.replace).not.toHaveBeenCalled();
  });
});

describe('redactForLog', () => {
  // Purpose: a refused link can carry a one-time credential in its path or
  // query; a console line must never repeat it.
  it('keeps the scheme and host only', () => {
    expect(redactForLog('https://c.example/claim/ct_secret?x=1#t')).toBe('https://c.example/…');
    expect(redactForLog('https://c.example')).toBe('https://c.example');
    expect(redactForLog('mailto:someone@example.com')).toBe('mailto:…');
    expect(redactForLog('not a link')).toBe('[unparsable link]');
  });
});

describe('plainAppAddress — which agent-written links open without asking (DOR-2824)', () => {
  it('passes a chat link, relative or absolute at our own origin', () => {
    expect(plainAppAddress('/session?session=abc', FROM)).toBe('/session?session=abc');
    expect(plainAppAddress(`${ORIGIN}/session?session=abc`, FROM)).toBe('/session?session=abc');
    expect(plainAppAddress('/team', FROM)).toBe('/team');
  });

  it('passes a /r/ link, which only names a thing (DOR-5046)', () => {
    const chat = '/r/dork:chat:7c1e4b2a-9f3d-4e8b-a6c5-a1b2c3d4e5f6';
    expect(plainAppAddress(chat, FROM)).toBe(chat);
    expect(plainAppAddress(`${ORIGIN}/r/dork:agent:01KJXYKJYW4N8QGQ5W4GB6YM9J`, FROM)).toBe(
      '/r/dork:agent:01KJXYKJYW4N8QGQ5W4GB6YM9J'
    );
  });

  it.each([
    ['a search param', '/r/dork:chat:abc?send=1'],
    ['a prompt', '/r/dork:chat:abc?prompt=hi'],
    ['another origin', 'https://evil.example/r/dork:chat:abc'],
    ['no reference', '/r/not-a-ref'],
  ])('refuses a /r/ link with %s', (_label, href) => {
    expect(plainAppAddress(href, FROM)).toBeNull();
  });

  it.each([
    ['an API path', '/api/sessions'],
    ['a path that normalises onto the API', '/session/../api/sessions'],
    ['an encoded traversal', '/session/%2e%2e/api/sessions'],
    ['a protocol-relative host', '//evil.example/session?session=abc'],
    ['a backslash host', '/\\evil.example/session'],
    ['another origin', 'https://evil.example/session?session=abc'],
    ['another port on our host', 'http://localhost:6666/session?session=abc'],
    ['an extension page', '/x/some-extension/page'],
    ['a dev path the router never sees', '/dev/playground'],
    ['a launch that sends as the person', '/session?agentId=a&prompt=hi&send=1'],
    ['a launch with only a prompt', '/session?agentId=a&prompt=hi'],
    ['a launch with an encoded key', '/session?agentId=a&%70rompt=hi&%73end=1'],
    ['a seeded launch', '/session?seed=dorkbot-help'],
    ['a query-only launch merged onto this page', '?prompt=hi&send=1'],
    ['a refused scheme', 'javascript:alert(1)'],
  ])('refuses %s', (_label, href) => {
    expect(plainAppAddress(href, FROM)).toBeNull();
  });

  it.each([
    ['a chosen folder', '/session?session=abc&dir=/etc'],
    ['a new chat for an agent', '/session?agentId=a'],
    ['a prepared launch', '/session?launchRef=r1'],
    ['a draft', '/session?session=abc&draft=1'],
    ['a runtime pick', '/session?session=abc&runtime=codex'],
    ['a settings dialog', '/session?session=abc&settings=open'],
    ['a param no route knows yet', '/team?doSomething=1'],
    ['a different case of a known key', '/session?Session=abc'],
  ])('refuses a link carrying %s', (_label, href) => {
    expect(plainAppAddress(href, FROM)).toBeNull();
  });
});
