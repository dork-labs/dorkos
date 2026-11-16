import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';

vi.mock('electron', () => import('../../__tests__/electron-mock'));

import {
  guardGuestNavigation,
  guestNavigationAllowed,
  historyEntryAllowed,
  isAppAddress,
  readGuestHistory,
  stepGuestHistory,
  type HistoryContents,
} from '../page-history';

const APP = 'http://localhost:4242/';
const RULES = { rendererUrl: APP };
const hash = (url: string) => createHash('sha256').update(url).digest('hex');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isAppAddress', () => {
  it.each([
    ['http://localhost:4242/session', true],
    ['http://127.0.0.1:4242/', true],
    ['http://[::1]:4242/', true],
    ['http://dorkos.localhost:4242/', true],
    ['http://0.0.0.0:4242/', true],
    ['http://[::ffff:127.0.0.1]:4242/', true],
    // Another port on this machine is somebody's dev server, not DorkOS.
    ['http://localhost:5173/', false],
    ['https://localhost/', false],
    ['https://northwind.example/', false],
    ['not a url', false],
  ])('%s → %s', (url, expected) => {
    expect(isAppAddress(url, RULES)).toBe(expected);
  });

  it('counts every address on the server’s own list', () => {
    const rules = {
      rendererUrl: APP,
      refused: ['http://192.168.1.10:4242', 'dorkos-any-port://tunnel.example', 'not a url'],
    };
    expect(isAppAddress('http://192.168.1.10:4242/session', rules)).toBe(true);
    expect(isAppAddress('https://tunnel.example:8443/', rules)).toBe(true);
    expect(isAppAddress('http://TUNNEL.example/', rules)).toBe(true);
    // Another port on that machine is not DorkOS.
    expect(isAppAddress('http://192.168.1.10:3000/', rules)).toBe(false);
    expect(isAppAddress('https://northwind.example/', rules)).toBe(false);
  });

  it('counts the dev server too', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5174');
    expect(isAppAddress('http://127.0.0.1:5174/', RULES)).toBe(true);
  });
});

describe('guestNavigationAllowed and historyEntryAllowed', () => {
  it.each([
    ['https://northwind.example/', true, true],
    ['http://localhost:4242/', false, false],
    ['file:///etc/hosts', false, false],
    ['javascript:alert(1)', false, false],
    ['chrome://settings', false, false],
    // Only a history step may land on every tab's empty first page.
    ['about:blank', false, true],
  ])('%s → navigation %s, history %s', (url, navigation, history) => {
    expect(guestNavigationAllowed(url, RULES)).toBe(navigation);
    expect(historyEntryAllowed(url, RULES)).toBe(history);
  });
});

/** A guest page's navigation events, with a way to fire one. */
function guardedPage() {
  const events = new EventEmitter();
  const contents = { on: events.on.bind(events) } as unknown as Pick<WebContents, 'on'>;
  const fire = (name: 'will-navigate' | 'will-redirect', url: string) => {
    const event = { url, preventDefault: vi.fn() };
    events.emit(name, event);
    return event.preventDefault;
  };
  return { contents, fire };
}

describe('guardGuestNavigation', () => {
  it('refuses a redirect to this app, a file or another scheme, and counts it', () => {
    const { contents, fire } = guardedPage();
    const refused = vi.fn();
    guardGuestNavigation(contents, () => RULES, refused);
    expect(fire('will-redirect', 'http://127.0.0.1:4242/session')).toHaveBeenCalledOnce();
    expect(fire('will-redirect', 'file:///etc/hosts')).toHaveBeenCalledOnce();
    expect(fire('will-navigate', 'http://localhost:4242/')).toHaveBeenCalledOnce();
    expect(fire('will-navigate', 'javascript:alert(1)')).toHaveBeenCalledOnce();
    expect(refused).toHaveBeenCalledTimes(4);
  });

  it('lets a website through', () => {
    const { contents, fire } = guardedPage();
    const refused = vi.fn();
    guardGuestNavigation(contents, () => RULES, refused);
    expect(fire('will-redirect', 'https://accounts.example/next')).not.toHaveBeenCalled();
    expect(fire('will-navigate', 'http://localhost:5173/')).not.toHaveBeenCalled();
    expect(refused).not.toHaveBeenCalled();
  });

  it('reads the app’s address live, so a server on a new port stays refused', () => {
    const { contents, fire } = guardedPage();
    let renderer = APP;
    guardGuestNavigation(contents, () => ({ rendererUrl: renderer }));
    renderer = 'http://localhost:4300/';
    expect(fire('will-redirect', 'http://localhost:4300/')).toHaveBeenCalledOnce();
  });
});

/** A guest's history and the events a step settles on. */
function guestHistory(urls: string[], index: number, onGo?: (at: number) => string | void) {
  const events = new EventEmitter();
  const state = { urls: [...urls], index };
  const goToIndex = vi.fn((at: number) => {
    const settled = onGo?.(at) ?? 'did-navigate';
    if (settled === 'did-navigate') state.index = at;
    // A load that never settles fires nothing.
    if (settled !== 'hang') queueMicrotask(() => events.emit(settled));
  });
  const stop = vi.fn();
  const contents = {
    stop,
    navigationHistory: {
      getAllEntries: () => state.urls.map((url) => ({ url, title: '' })),
      getActiveIndex: () => state.index,
      getEntryAtIndex: (at: number) =>
        at >= 0 && at < state.urls.length ? { url: state.urls[at]!, title: '' } : null,
      goToIndex,
    },
    once: events.once.bind(events),
    removeListener: events.removeListener.bind(events),
  } as unknown as HistoryContents;
  return { contents, state, goToIndex, stop };
}

describe('readGuestHistory', () => {
  it('reads every entry and the open one', () => {
    const { contents } = guestHistory(['about:blank', 'https://a.example/'], 1);
    expect(readGuestHistory(contents)).toEqual({
      index: 1,
      entries: [{ url: 'about:blank' }, { url: 'https://a.example/' }],
    });
  });
});

describe('stepGuestHistory', () => {
  const step = (contents: HistoryContents, index: number, url: string, refusals = () => 0) =>
    stepGuestHistory(contents, index, hash(url), RULES, refusals);

  it('moves to the entry the server named', async () => {
    const { contents, state } = guestHistory(['https://a.example/', 'https://b.example/'], 1);
    expect(await step(contents, 0, 'https://a.example/')).toBe('moved');
    expect(state.index).toBe(0);
  });

  it('refuses an entry that changed since the server read it', async () => {
    const { contents, goToIndex } = guestHistory(['https://a.example/', 'https://b.example/'], 1);
    expect(await step(contents, 0, 'https://other.example/')).toBe('changed');
    expect(await step(contents, 7, 'https://a.example/')).toBe('changed');
    expect(goToIndex).not.toHaveBeenCalled();
  });

  it('refuses, by its own rule, an entry the server let through', async () => {
    const { contents, goToIndex } = guestHistory(
      ['http://localhost:4242/', 'https://b.example/'],
      1
    );
    expect(await step(contents, 0, 'http://localhost:4242/')).toBe('refused');
    expect(goToIndex).not.toHaveBeenCalled();
  });

  it('says refused when the real guard refused a redirect on the way', async () => {
    // An allowed entry whose load now redirects to this app. The fake page raises
    // `will-redirect` as Chromium does; the real guard decides.
    const page = new EventEmitter();
    let refusals = 0;
    guardGuestNavigation(
      page as unknown as Pick<WebContents, 'on'>,
      () => RULES,
      () => {
        refusals += 1;
      }
    );
    const { contents, state } = guestHistory(
      ['https://a.example/', 'https://b.example/'],
      1,
      () => {
        const event = { url: 'http://127.0.0.1:4242/session', preventDefault: vi.fn() };
        page.emit('will-redirect', event);
        return event.preventDefault.mock.calls.length > 0 ? 'did-fail-load' : 'did-navigate';
      }
    );
    expect(await step(contents, 0, 'https://a.example/', () => refusals)).toBe('refused');
    expect(state.index).toBe(1);
  });

  it('stops a step that outlasts its time, so it cannot land after the answer', async () => {
    vi.useFakeTimers();
    try {
      const { contents, stop } = guestHistory(
        ['https://a.example/', 'https://b.example/'],
        1,
        () => 'hang'
      );
      const moving = step(contents, 0, 'https://a.example/');
      await vi.advanceTimersByTimeAsync(15_000);
      await moving;
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
