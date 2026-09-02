/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toast } from 'sonner';
import {
  APP_ROUTE_PATHS,
  classifyLink,
  declaredScheme,
  isWebUrl,
  openExternalLink,
  openLink,
  registerLinkNavigator,
  registerTabOpener,
  supportsNewTab,
  supportsSeparateWindow,
  type LinkNavigation,
} from '../link-navigation';
import { setPlatformAdapter } from '../platform';
import { enterDesktopShell, leaveDesktopShell } from '@/test-helpers/desktop-shell';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const ORIGIN = 'http://localhost:4242';
const FROM = `${ORIGIN}/team?view=topology`;

const webPlatform = { isEmbedded: false, openFile: async () => {} };
const embeddedPlatform = { isEmbedded: true, openFile: async () => {} };

describe('declaredScheme', () => {
  it('reads the scheme an href declares for itself', () => {
    expect(declaredScheme('irc://irc.example.com/dorkos')).toBe('irc:');
    expect(declaredScheme('  JavaScript:alert(1)')).toBe('javascript:');
    expect(declaredScheme('mailto:hi@dorkos.ai')).toBe('mailto:');
  });

  it('never resolves against the page — a relative href declares no scheme', () => {
    // The whole point of the no-base parse, and it is only observable here:
    // dispatch reads `window.location`, which vitest pins per file, so a
    // version of this that passed a base still satisfied every other test in
    // the suite. In the Obsidian embed the page is `app://obsidian.md/…`, so a
    // resolving version would answer `app:` for all four of these and the
    // refusal would name a scheme the reader never saw.
    expect(declaredScheme('/team')).toBeNull();
    expect(declaredScheme('#section')).toBeNull();
    expect(declaredScheme('?settings=open')).toBeNull();
    expect(declaredScheme('//evil.com/steal')).toBeNull();
  });

  it('declines to repeat back a scheme too long to be a scheme', () => {
    // A refused href is agent- or attacker-authored and `new URL` will parse a
    // scheme of any length out of one. The caller falls back to its generic
    // sentence rather than rendering a heading that never ends.
    expect(declaredScheme(`${'a'.repeat(302)}:payload`)).toBeNull();
    expect(declaredScheme(`${'a'.repeat(23)}:payload`)).toBe(`${'a'.repeat(23)}:`);
  });

  it('answers null for anything that is not a URL at all', () => {
    expect(declaredScheme('')).toBeNull();
    expect(declaredScheme('   ')).toBeNull();
    expect(declaredScheme('https://[')).toBeNull();
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

  it('lets a query-only href override a param it names', () => {
    expect(classifyLink('?view=list', FROM)).toMatchObject({
      kind: 'internal',
      path: '/team?view=list',
    });
  });

  it('replaces the search when the href carries a path', () => {
    expect(classifyLink('/team?view=list', FROM)).toMatchObject({
      kind: 'internal',
      path: '/team?view=list',
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

  it('treats tel: as dispatchable — the same case as mailto:, and the reason chat phone links still work', () => {
    // Added with DOR-547, when markdown links joined this policy. A browser
    // hands `tel:` to the OS dialer from any page, so an agent writing a phone
    // number as a link produces one that goes somewhere on the web and phone
    // surfaces — which it did before this list governed markdown, and must
    // still do after.
    expect(classifyLink('tel:+15551234567', FROM)).toEqual({
      kind: 'external',
      url: 'tel:+15551234567',
    });
  });

  it('still refuses the chat-only schemes the markdown sanitizer permits', () => {
    // `irc:`, `ircs:` and `xmpp:` are the whole of what Streamdown's sanitizer
    // allows and this list does not. Before DOR-547 they dispatched from chat
    // markdown and nowhere else; now they are refused everywhere, out loud.
    for (const href of ['irc://irc.example.com/dorkos', 'ircs://irc.example.com', 'xmpp:a@b.com']) {
      expect(classifyLink(href, FROM), href).toEqual({
        kind: 'blocked',
        reason: 'unsupported-scheme',
      });
    }
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
    expect(classifyLink('/team', from)).toEqual({
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
  let tabCleanups: (() => void)[];

  /**
   * Register a strip and collect what it opens. Torn down in `afterEach` rather
   * than at the end of the test body, so a failing assertion cannot leak an
   * opener into the next case and turn a cascade into what looks like a second
   * detection.
   */
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
    setPlatformAdapter(webPlatform);
  });

  afterEach(() => {
    unregister();
    tabCleanups.forEach((clear) => clear());
    openSpy.mockRestore();
    warnSpy.mockRestore();
    setPlatformAdapter(webPlatform);
    leaveDesktopShell();
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
      enterDesktopShell();
      openLink('/session?dir=%2Ftmp', { target: 'window' });
      expect(openSpy).toHaveBeenCalledWith(
        `${window.location.origin}/session?dir=%2Ftmp`,
        '_blank'
      );
      expect(navigated).toEqual([]);
    });

    it('degrades a window request in a browser to a browser tab, never to here', () => {
      // A browser has no second window worth offering, so the palette never
      // asks for one there — but the seam must answer honestly for anything
      // that does. A tab is not the window that was asked for; navigating in
      // place would take away the view the person still has.
      openLink('/session?dir=%2Ftmp', { target: 'window' });
      expect(openSpy).toHaveBeenCalledWith(
        `${window.location.origin}/session?dir=%2Ftmp`,
        '_blank'
      );
      expect(navigated).toEqual([]);
    });

    it('keeps a window request out of the strip, even with one registered', () => {
      // "Put this on my other monitor" is not "give me another tab". A desktop
      // window request must reach the shell's own-origin handler even with a
      // strip registered, or the tab/window split is a lie told in the UI.
      enterDesktopShell();
      const opened = captureTabOpens();
      openLink('/tasks', { target: 'window' });
      expect(opened).toEqual([]);
      expect(openSpy).toHaveBeenCalledWith(`${window.location.origin}/tasks`, '_blank');
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
      openLink('/dev', { target: 'window' });
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
      enterDesktopShell();
      openLink('/tasks', { target: 'window' });
      expect(openSpy).toHaveBeenCalledWith(expect.any(String), '_blank');
    });

    it('navigates in place instead of opening a window in the embed', () => {
      setPlatformAdapter(embeddedPlatform);
      openLink('/tasks', { target: 'window' });
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

    it('opens an internal link in an in-window tab in the desktop app', () => {
      enterDesktopShell();
      const opened = captureTabOpens();
      openLink('/session?dir=%2Ftmp', { target: 'tab' });
      expect(opened).toEqual(['/session?dir=%2Ftmp']);
      // A tab is not a window and not an in-place navigation.
      expect(openSpy).not.toHaveBeenCalled();
      expect(navigated).toEqual([]);
    });

    it('opens a real browser tab in the browser, where no strip is registered', () => {
      // The browser owns tabs there, so the app entry registers no opener
      // (DOR-568) and this must reach `window.open` rather than quietly
      // navigating in place and losing the view you asked to keep.
      openLink('/session?dir=%2Ftmp', { target: 'tab' });
      expect(openSpy).toHaveBeenCalledWith(
        `${window.location.origin}/session?dir=%2Ftmp`,
        '_blank'
      );
      expect(navigated).toEqual([]);
    });

    it('opens a browser tab in the browser even with a strip registered', () => {
      // The surface decides, not who registered an adapter. `main.tsx` only
      // registers an opener on the desktop, but that gate reads as redundant
      // beside `registerLinkNavigator` — and if it were the only thing enforcing
      // the surface, deleting it would turn every "Open in New Tab" in the
      // browser into an in-place navigation into a strip nothing renders, with
      // the whole suite still green.
      const opened = captureTabOpens();
      openLink('/session?dir=%2Ftmp', { target: 'tab' });
      expect(opened).toEqual([]);
      expect(openSpy).toHaveBeenCalledWith(
        `${window.location.origin}/session?dir=%2Ftmp`,
        '_blank'
      );
      expect(navigated).toEqual([]);
    });

    it('hands a desktop tab request to the shell when no strip is registered yet', () => {
      // Nothing renders a strip until the app entry registers one. Until then a
      // same-origin `window.open` reaches the shell's `setWindowOpenHandler`
      // (`apps/desktop/src/main/window-manager.ts`), which recognises its own
      // origin and builds a second cockpit window. Not the tab that was asked
      // for, but a second view, and never an in-place navigation.
      enterDesktopShell();
      openLink('/session?dir=%2Ftmp', { target: 'tab' });
      expect(openSpy).toHaveBeenCalledWith(
        `${window.location.origin}/session?dir=%2Ftmp`,
        '_blank'
      );
      expect(navigated).toEqual([]);
    });

    it('sends an external link to the browser even when a tab is asked for', () => {
      const opened = captureTabOpens();
      openLink('https://dorkos.ai/docs', { target: 'tab' });
      expect(opened).toEqual([]);
      expect(openSpy).toHaveBeenCalledWith(
        'https://dorkos.ai/docs',
        '_blank',
        'noopener,noreferrer'
      );
    });

    it('falls back to navigating in place in the embed, the one pane with nowhere else to go', () => {
      // The Obsidian embed mounts no strip and has no browser tabs to borrow.
      // A tab request must still go somewhere rather than silently vanish.
      setPlatformAdapter(embeddedPlatform);
      openLink('/tasks', { target: 'tab' });
      expect(openSpy).not.toHaveBeenCalled();
      expect(navigated).toEqual([{ href: '/tasks', replace: undefined }]);
    });

    it('reports whether the link was actually dispatched', () => {
      expect(openLink('/tasks')).toBe(true);
      expect(openLink('/tasks', { target: 'window' })).toBe(true);
      expect(openLink('/tasks', { target: 'tab' })).toBe(true);
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
      // at". A gen-UI widget, MCP App, or elicitation payload naming `/team`
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

    it('uses the desktop shell bridge, which is the only thing that can leave our own origin', () => {
      // `window.open` at `http://localhost:<port>` is claimed by the shell's
      // window-open handler and becomes a second cockpit window — right for
      // "open in a new tab", and a broken promise for everything here. Settings
      // → Server's "open in your browser" is exactly that URL.
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

    it('falls back to window.open when a host exposes a bridge without this method', () => {
      // The bridge is feature-detected per method, like every other
      // `electronAPI` consumer. A host with an older or partial preload would
      // otherwise throw out of the seam instead of opening anything.
      window.electronAPI = { platform: 'darwin' } as unknown as ElectronAPI;
      try {
        expect(openExternalLink('https://dorkos.ai/docs')).toBe(true);
        expect(openSpy).toHaveBeenCalledWith(
          'https://dorkos.ai/docs',
          '_blank',
          'noopener,noreferrer'
        );
      } finally {
        delete window.electronAPI;
      }
    });

    it('reports a bridge failure somewhere findable rather than as an unhandled rejection', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      window.electronAPI = {
        openExternal: vi.fn().mockRejectedValue(new Error('shell refused')),
      } as unknown as ElectronAPI;
      try {
        // Already returned `true` by the time the promise settles, so the only
        // honest thing left is to leave a trace a bug report can find.
        expect(openExternalLink('https://dorkos.ai/docs')).toBe(true);
        await Promise.resolve();
        await Promise.resolve();
        expect(errorSpy).toHaveBeenCalled();
      } finally {
        delete window.electronAPI;
        errorSpy.mockRestore();
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
      // The ticket's own symptom, one process later. `mailto:`/`tel:` clear
      // this module's allowlist and are then dropped by the shell's
      // http(s)-only `isWebLink` — silently, before this. Refused here instead,
      // synchronously, so the return value the caller gates on is honest.
      const openExternal = vi.fn().mockResolvedValue(true);
      window.electronAPI = { openExternal } as unknown as ElectronAPI;
      try {
        expect(openExternalLink('mailto:hi@dorkos.ai')).toBe(false);
        expect(openExternal).not.toHaveBeenCalled();
        expect(toast.error).toHaveBeenCalledWith("DorkOS doesn't open mailto: links", {
          id: 'dorkos-link-refused',
          description: 'The desktop app opens web links only.',
        });
      } finally {
        delete window.electronAPI;
      }
    });

    it('still opens mailto: and tel: where a browser would carry them', () => {
      // No bridge in scope: the web app and the phone surface, where both
      // genuinely reach an OS handler. The desktop refusal above must not
      // become a refusal everywhere.
      expect(openExternalLink('mailto:hi@dorkos.ai')).toBe(true);
      expect(openExternalLink('tel:+15551234567')).toBe(true);
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('reports a shell decline the client-side mirror let through', async () => {
      // Belt to the braces above: the two predicates can disagree (a `HTTP://`
      // spelling passes `isWebUrl` and fails the shell's `startsWith`), and a
      // decline must never be indistinguishable from a success.
      const openExternal = vi.fn().mockResolvedValue(false);
      window.electronAPI = { openExternal } as unknown as ElectronAPI;
      try {
        openExternalLink('HTTP://dorkos.ai/docs');
        await Promise.resolve();
        await Promise.resolve();
        expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("doesn't open"), {
          id: 'dorkos-link-refused',
          description: 'The desktop app opens web links only.',
        });
      } finally {
        delete window.electronAPI;
      }
    });

    it('stays silent when an older preload answers nothing at all', async () => {
      // `undefined` is "this build predates the boolean", not "declined".
      // Accusing the shell of refusing a link it opened would be its own lie.
      const openExternal = vi.fn().mockResolvedValue(undefined);
      window.electronAPI = { openExternal } as unknown as ElectronAPI;
      try {
        expect(openExternalLink('https://dorkos.ai/docs')).toBe(true);
        await Promise.resolve();
        await Promise.resolve();
        expect(toast.error).not.toHaveBeenCalled();
      } finally {
        delete window.electronAPI;
      }
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

  describe('a refusal says so (DOR-547)', () => {
    it('names the scheme it will not open', () => {
      // The seam owns the policy, so it owns the sentence. Before this, a
      // refused click was a console warning and nothing the person could see —
      // identical, from their side, to a link that was simply broken.
      openExternalLink('irc://irc.example.com/dorkos');

      expect(toast.error).toHaveBeenCalledWith("DorkOS doesn't open irc: links", {
        id: 'dorkos-link-refused',
        description: 'Only web, email and phone links open from here.',
      });
    });

    it('says something different when the address is broken rather than refused', () => {
      openExternalLink('http://');

      expect(toast.error).toHaveBeenCalledWith("DorkOS couldn't open that link", {
        id: 'dorkos-link-refused',
        description: 'That address is incomplete, so there is nowhere to send you.',
      });
    });

    it('names the scheme the href itself declares, never one it inherited', () => {
      // These tests run from an `http:` page, where a relative href inherits a
      // dispatchable scheme and is never refused. The case this pins matters in
      // the Obsidian embed, whose page is `app://obsidian.md/…`: there a
      // relative href resolves to `app:` and IS refused, and naming that scheme
      // would report a word the reader never saw in the link they clicked.
      // Reachable here only through `classifyLink`, which takes its base as an
      // argument — dispatch reads `window.location`, which jsdom pins per file.
      expect(classifyLink('/team', 'app://obsidian.md/index.html')).toEqual({
        kind: 'blocked',
        reason: 'unsupported-scheme',
      });
      // The href in that case declares no scheme of its own, so the message
      // falls back to the same sentence a broken address gets. An explicit one
      // is named.
      openExternalLink('app://obsidian.md/team');
      expect(toast.error).toHaveBeenCalledWith("DorkOS doesn't open app: links", expect.anything());
    });

    it('reuses one toast slot, so a second refused click replaces the first message', () => {
      openExternalLink('irc://irc.example.com/dorkos');
      openExternalLink('xmpp:someone@example.com');

      expect(toast.error).toHaveBeenCalledTimes(2);
      const ids = vi.mocked(toast.error).mock.calls.map(([, options]) => options?.id);
      expect(new Set(ids).size).toBe(1);
    });

    it('stays quiet when there is no refusal to report', () => {
      openExternalLink('https://dorkos.ai/docs');
      openLink('/tasks');
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('drops the scheme from the message when it is too long to be one', () => {
      openExternalLink(`${'a'.repeat(302)}://payload`);

      expect(toast.error).toHaveBeenCalledWith("DorkOS couldn't open that link", expect.anything());
    });

    it('refuses every hostile spelling by name, on one message shape', () => {
      // The adversarial probe set, kept permanently. Each of these reaches the
      // seam from something an agent or a remote server authored.
      const probes: [href: string, title: string][] = [
        ['javascript:alert(1)', "DorkOS doesn't open javascript: links"],
        ['  JavaScript:alert(1)', "DorkOS doesn't open javascript: links"],
        ['JaVaScRiPt:alert(1)', "DorkOS doesn't open javascript: links"],
        ['java\tscript:alert(1)', "DorkOS doesn't open javascript: links"],
        ['data:text/html,<script>alert(1)</script>', "DorkOS doesn't open data: links"],
        ['vbscript:msgbox(1)', "DorkOS doesn't open vbscript: links"],
        ['file:///etc/passwd', "DorkOS doesn't open file: links"],
        ['blob:http://localhost:4242/9f2c', "DorkOS doesn't open blob: links"],
        ['filesystem:http://localhost:4242/temporary/x', "DorkOS doesn't open filesystem: links"],
        ['dorkos://session/abc', "DorkOS doesn't open dorkos: links"],
        ['myapp://authorize', "DorkOS doesn't open myapp: links"],
        ['irc://irc.example.com/dorkos', "DorkOS doesn't open irc: links"],
        ['ircs://irc.example.com', "DorkOS doesn't open ircs: links"],
        ['xmpp:someone@example.com', "DorkOS doesn't open xmpp: links"],
        ['http://', "DorkOS couldn't open that link"],
      ];

      for (const [href, title] of probes) {
        vi.mocked(toast.error).mockClear();
        expect(openExternalLink(href), href).toBe(false);
        expect(openSpy, href).not.toHaveBeenCalled();
        expect(toast.error, href).toHaveBeenCalledWith(title, expect.anything());
      }
    });

    it('stays quiet for a missing router, which is a wiring bug and not a refusal', () => {
      // The embed mounts no router on purpose. Telling its reader "DorkOS
      // couldn't open that link" every time would be reporting our own
      // architecture at them.
      unregister();
      expect(openLink('/tasks')).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    });
  });

  describe('supportsNewTab', () => {
    it('is true in the browser and false in the embed', () => {
      expect(supportsNewTab()).toBe(true);
      setPlatformAdapter(embeddedPlatform);
      expect(supportsNewTab()).toBe(false);
    });

    it('stays true in the desktop app — a tab is a tab, whoever owns it', () => {
      enterDesktopShell();
      expect(supportsNewTab()).toBe(true);
    });
  });

  describe('supportsSeparateWindow', () => {
    it('is true in the desktop app and false in the browser', () => {
      // A browser's "new window" is the tab "Open in New Tab" already offers,
      // so the second row is not offered there (DOR-568).
      expect(supportsSeparateWindow()).toBe(false);
      enterDesktopShell();
      expect(supportsSeparateWindow()).toBe(true);
    });

    it('is false in the embed even with a bridge in scope', () => {
      // Both halves are load-bearing statements, not one guarding the other.
      enterDesktopShell();
      setPlatformAdapter(embeddedPlatform);
      expect(supportsSeparateWindow()).toBe(false);
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
