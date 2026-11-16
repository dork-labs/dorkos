import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { historyAddressAllowed } from '../../errors.js';
import {
  cdpPageHistory,
  embeddedPageHistory,
  historyAvailability,
  historyTargets,
  stepPageHistory,
  type PageHistoryPort,
} from '../page-history.js';

const APP = ['http://localhost:4242', 'http://127.0.0.1:4242'];
const allowed = (url: string) => historyAddressAllowed(url, APP);

describe('historyAddressAllowed', () => {
  it.each([
    ['about:blank', true],
    ['https://northwind.example/fares', true],
    ['http://localhost:5173/', true],
    // This DorkOS app, under any of its names.
    ['http://localhost:4242/session', false],
    ['http://127.0.0.1:4242/', false],
    ['view-source:http://localhost:4242/', false],
    // Anything but a website or the one empty page.
    ['file:///Users/kai/notes.html', false],
    ['javascript:alert(1)', false],
    ['data:text/html,hi', false],
    ['chrome://settings', false],
    ['about:srcdoc', false],
    ['not a url', false],
  ])('%s → %s', (url, expected) => {
    expect(historyAddressAllowed(url, APP)).toBe(expected);
  });
});

describe('historyTargets', () => {
  const history = (index: number, ...urls: string[]) => ({
    index,
    entries: urls.map((url) => ({ url })),
  });

  it('is the next entry each way', () => {
    expect(
      historyTargets(
        history(1, 'https://a.example/', 'https://b.example/', 'https://c.example/'),
        allowed
      )
    ).toEqual({ back: 0, forward: 2 });
  });

  it('has nowhere to go at either end', () => {
    expect(historyTargets(history(0, 'about:blank'), allowed)).toEqual({
      back: null,
      forward: null,
    });
  });

  it('skips a refused entry rather than landing on it', () => {
    const urls = ['https://a.example/', 'http://localhost:4242/', 'https://c.example/'];
    expect(historyTargets(history(2, ...urls), allowed)).toEqual({ back: 0, forward: null });
    expect(historyTargets(history(0, ...urls), allowed)).toEqual({ back: null, forward: 2 });
  });

  it('says no way back when everything behind is refused', () => {
    const urls = ['file:///etc/hosts', 'http://localhost:4242/', 'https://c.example/'];
    expect(historyTargets(history(2, ...urls), allowed).back).toBeNull();
  });
});

/** A fake browser history: entries, the open one, and where a load really ends up. */
function fakeHistory(urls: string[], index: number, redirects: Record<string, string> = {}) {
  const state = { urls: [...urls], index };
  const page = {
    url: () => state.urls[state.index]!,
    goto: vi.fn(async (url: string) => {
      state.urls = [...state.urls.slice(0, state.index + 1), url];
      state.index += 1;
    }),
  } as unknown as Page;
  const go = vi.fn(async (_page: Page, at: number, url: string, rule: (u: string) => boolean) => {
    if (state.urls[at] !== url) throw new Error('history changed');
    const landing = redirects[url] ?? url;
    // A port that refuses a refused load keeps the page where it was.
    if (!rule(landing)) return 'refused' as const;
    state.index = at;
    state.urls[at] = landing;
    return 'moved' as const;
  });
  const load = vi.fn(async (_page: Page, url: string, rule: (u: string) => boolean) => {
    const landing = redirects[url] ?? url;
    if (!rule(landing)) return 'refused' as const;
    state.urls = [...state.urls.slice(0, state.index + 1), landing];
    state.index += 1;
    return 'moved' as const;
  });
  const port: PageHistoryPort = {
    read: vi.fn(async () => ({ index: state.index, entries: state.urls.map((url) => ({ url })) })),
    go,
    load,
  };
  return { page, port, state, go, load };
}

describe('stepPageHistory', () => {
  it('moves one allowed step back and forward', async () => {
    const { page, port, state } = fakeHistory(['https://a.example/', 'https://b.example/'], 1);
    await stepPageHistory(page, port, 'back', allowed);
    expect(state.index).toBe(0);
    await stepPageHistory(page, port, 'forward', allowed);
    expect(state.index).toBe(1);
  });

  it('refuses a step with nowhere to go, and moves nothing', async () => {
    const { page, port, go } = fakeHistory(['about:blank'], 0);
    await expect(stepPageHistory(page, port, 'back', allowed)).rejects.toMatchObject({
      code: 'no_history',
    });
    expect(go).not.toHaveBeenCalled();
  });

  it('never steps onto a refused entry: it goes past it', async () => {
    const { page, port, state, go } = fakeHistory(
      ['https://a.example/', 'http://localhost:4242/session', 'https://c.example/'],
      2
    );
    await stepPageHistory(page, port, 'back', allowed);
    expect(state.index).toBe(0);
    expect(go).toHaveBeenCalledTimes(1);
    expect(go.mock.calls[0]![1]).toBe(0);
  });

  it('refuses an allowed entry that now redirects somewhere refused, and stays put', async () => {
    // Visited when it was fine; its next load redirects to this DorkOS app.
    const { page, port, state } = fakeHistory(['https://a.example/', 'https://b.example/'], 1, {
      'https://a.example/': 'http://localhost:4242/session',
    });
    await expect(stepPageHistory(page, port, 'back', allowed)).rejects.toMatchObject({
      code: 'history_refused',
    });
    expect(state.index).toBe(1);
    expect(page.url()).toBe('https://b.example/');
  });

  it('puts the page back when only the landing check sees the refusal', async () => {
    // A port that let the redirect through: the landing check still refuses it.
    const { page, port, state } = fakeHistory(['https://a.example/', 'https://b.example/'], 1, {
      'https://a.example/': 'http://127.0.0.1:4242/',
    });
    const leaky: PageHistoryPort = { ...port, go: (p, at, url) => port.go(p, at, url, () => true) };
    await expect(stepPageHistory(page, leaky, 'back', allowed)).rejects.toMatchObject({
      code: 'history_refused',
    });
    // Back on the page they were on, loaded fresh through the guard.
    expect(page.url()).toBe('https://b.example/');
    expect(state.urls).toEqual(['http://127.0.0.1:4242/', 'https://b.example/']);
  });

  it('puts the person back when the refused load replaced their own entry', async () => {
    // What Chromium does: the blocked load's error page takes the entry the person was on.
    const { page, port, state, load } = fakeHistory(
      ['https://a.example/', 'https://b.example/'],
      1
    );
    const replacing: PageHistoryPort = {
      ...port,
      go: async () => {
        state.urls[1] = 'http://localhost:4242/session';
        return 'refused';
      },
    };
    await expect(stepPageHistory(page, replacing, 'back', allowed)).rejects.toMatchObject({
      code: 'history_refused',
    });
    expect(load).toHaveBeenCalledWith(page, 'https://b.example/', allowed);
    expect(page.url()).toBe('https://b.example/');
  });

  it('checks where a failed or timed-out step left the page, and puts it back', async () => {
    const { page, port, state } = fakeHistory(['https://a.example/', 'https://b.example/'], 1);
    const timedOut: PageHistoryPort = {
      ...port,
      go: async () => {
        // The load went on after the step gave up, and landed on DorkOS.
        state.urls[1] = 'http://localhost:4242/session';
        throw Object.assign(new Error('timed out'), { code: 'navigation_uncertain' });
      },
    };
    await expect(stepPageHistory(page, timedOut, 'back', allowed)).rejects.toMatchObject({
      code: 'history_refused',
    });
    expect(page.url()).toBe('https://b.example/');
  });

  it('passes a failed step’s own error on when the page is somewhere allowed', async () => {
    const { page, port } = fakeHistory(['https://a.example/', 'https://b.example/'], 1);
    const failing: PageHistoryPort = {
      ...port,
      go: async () => {
        throw Object.assign(new Error('timed out'), { code: 'navigation_uncertain' });
      },
    };
    await expect(stepPageHistory(page, failing, 'back', allowed)).rejects.toMatchObject({
      code: 'navigation_uncertain',
    });
  });

  it('falls back to an empty page when the way back is refused too', async () => {
    const { page, port } = fakeHistory(['https://a.example/', 'https://b.example/'], 1, {
      'https://a.example/': 'http://localhost:4242/',
      'https://b.example/': 'http://localhost:4242/',
    });
    const leaky: PageHistoryPort = { ...port, go: (p, at, url) => port.go(p, at, url, () => true) };
    await expect(stepPageHistory(page, leaky, 'back', allowed)).rejects.toMatchObject({
      code: 'history_refused',
    });
    expect(page.goto).toHaveBeenCalledWith('about:blank', expect.anything());
    expect(page.url()).toBe('about:blank');
  });
});

describe('historyAvailability', () => {
  it('says which ways have an allowed page', async () => {
    const { page, port } = fakeHistory(
      ['https://a.example/', 'https://b.example/', 'file:///etc/hosts'],
      1
    );
    expect(await historyAvailability(page, port, allowed)).toEqual({
      canGoBack: true,
      canGoForward: false,
    });
  });

  it('says neither way when history can’t be read', async () => {
    const port: PageHistoryPort = {
      read: async () => {
        throw new Error('gone');
      },
      go: vi.fn(),
      load: vi.fn(),
    };
    expect(await historyAvailability({} as Page, port, allowed)).toEqual({
      canGoBack: false,
      canGoForward: false,
    });
  });
});

/** A fake DevTools session: history, Fetch interception, and a page that loads. */
function fakeCdp(
  urls: string[],
  index: number,
  redirects: Record<string, string> = {},
  frames: string[] = []
) {
  const session = new EventEmitter();
  const pageEvents = new EventEmitter();
  const frame = {};
  const state = { urls: [...urls], index };
  let intercepting = false;
  const answers: { method: string; params: Record<string, unknown> }[] = [];
  const pending = new Map<string, (ok: boolean) => void>();
  let request = 0;
  /** One document request, paused while Fetch is on, answered by the guard. */
  const load = (url: string, frameId = 'main') =>
    new Promise<boolean>((resolve) => {
      if (!intercepting) return resolve(true);
      const requestId = `r${++request}`;
      pending.set(requestId, resolve);
      session.emit('Fetch.requestPaused', { requestId, frameId, request: { url } });
    });
  const send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    answers.push({ method, params });
    if (method === 'Page.getNavigationHistory')
      return {
        currentIndex: state.index,
        entries: state.urls.map((url, at) => ({ id: at + 100, url })),
      };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
    if (method === 'Fetch.enable') intercepting = true;
    if (method === 'Fetch.disable') intercepting = false;
    if (method === 'Fetch.continueRequest' || method === 'Fetch.failRequest') {
      pending.get(params.requestId as string)?.(method === 'Fetch.continueRequest');
      pending.delete(params.requestId as string);
    }
    if (method === 'Page.navigateToHistoryEntry') {
      const at = (params.entryId as number) - 100;
      void (async () => {
        const first = state.urls[at]!;
        for (const frame of frames) await load(frame, 'ad-frame');
        if (!(await load(first))) return;
        const hop = redirects[first];
        if (hop && !(await load(hop))) return;
        state.index = at;
        state.urls[at] = hop ?? first;
        pageEvents.emit('framenavigated', frame);
      })();
    }
    return {};
  });
  const cdp = { send, on: session.on.bind(session), off: session.off.bind(session) };
  const page = {
    url: () => state.urls[state.index]!,
    mainFrame: () => frame,
    once: pageEvents.once.bind(pageEvents),
    context: () => ({ newCDPSession: async () => cdp }),
    waitForEvent: (_name: string, options: { predicate: (f: unknown) => boolean }) =>
      new Promise((resolve) => {
        const on = (f: unknown) => {
          if (!options.predicate(f)) return;
          pageEvents.off('framenavigated', on);
          resolve(f);
        };
        pageEvents.on('framenavigated', on);
      }),
    goto: vi.fn(async () => undefined),
  } as unknown as Page;
  return { page, state, answers, load };
}

describe('cdpPageHistory', () => {
  it('reads the real history and moves by entry', async () => {
    const { page, state } = fakeCdp(['about:blank', 'https://a.example/', 'https://b.example/'], 2);
    const port = cdpPageHistory();
    expect(await port.read(page)).toEqual({
      index: 2,
      entries: [
        { url: 'about:blank' },
        { url: 'https://a.example/' },
        { url: 'https://b.example/' },
      ],
    });
    await stepPageHistory(page, port, 'back', allowed);
    expect(state.index).toBe(1);
  });

  it('refuses a redirect hop to a refused address before it loads', async () => {
    const { page, state, answers } = fakeCdp(['https://a.example/', 'https://b.example/'], 1, {
      'https://a.example/': 'http://localhost:4242/session',
    });
    await expect(stepPageHistory(page, cdpPageHistory(), 'back', allowed)).rejects.toMatchObject({
      code: 'history_refused',
    });
    // The first hop went through, the redirect was failed, and nothing moved.
    expect(answers.filter(({ method }) => method.startsWith('Fetch.'))).toEqual(
      expect.arrayContaining([
        { method: 'Fetch.continueRequest', params: { requestId: 'r1' } },
        {
          method: 'Fetch.failRequest',
          params: { requestId: 'r2', errorReason: 'BlockedByClient' },
        },
      ])
    );
    expect(state.index).toBe(1);
    expect(page.url()).toBe('https://b.example/');
    // Interception is only on for the step.
    expect(answers.at(-1)?.method).not.toBe('Fetch.enable');
    expect(answers.some(({ method }) => method === 'Fetch.disable')).toBe(true);
  });

  it('refuses a framed DorkOS page on the way without refusing the step', async () => {
    const { page, state, answers } = fakeCdp(['https://a.example/', 'https://b.example/'], 1, {}, [
      'http://localhost:4242/embed',
    ]);
    await stepPageHistory(page, cdpPageHistory(), 'back', allowed);
    expect(state.index).toBe(0);
    expect(answers).toContainEqual({
      method: 'Fetch.failRequest',
      params: { requestId: 'r1', errorReason: 'BlockedByClient' },
    });
  });

  it('turns interception off before it stops listening', async () => {
    const { page, answers } = fakeCdp(['https://a.example/', 'https://b.example/'], 1);
    await stepPageHistory(page, cdpPageHistory(), 'back', allowed);
    const methods = answers.map(({ method }) => method);
    expect(methods.lastIndexOf('Fetch.disable')).toBeGreaterThan(
      methods.lastIndexOf('Page.navigateToHistoryEntry')
    );
  });

  it('refuses a step whose entry changed since it was read', async () => {
    const { page } = fakeCdp(['https://a.example/'], 0);
    await expect(
      cdpPageHistory().go(page, 0, 'https://other.example/', allowed)
    ).rejects.toMatchObject({
      code: 'history_changed',
    });
  });
});

describe('embeddedPageHistory', () => {
  it('never asks the Mac app for an entry this side refuses', async () => {
    const goToHistory = vi.fn(async () => 'moved' as const);
    const port = embeddedPageHistory(
      () => ({ history: vi.fn(), goToHistory }),
      () => APP
    );
    const page = { goto: vi.fn() } as unknown as Page;
    expect(await port.go(page, 0, 'http://localhost:4242/', allowed)).toBe('refused');
    expect(await port.load(page, 'http://localhost:4242/', allowed)).toBe('refused');
    expect(goToHistory).not.toHaveBeenCalled();
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('passes the Mac app’s own refusal through', async () => {
    const goToHistory = vi.fn(async () => 'refused' as const);
    const port = embeddedPageHistory(
      () => ({ history: vi.fn(), goToHistory }),
      () => APP
    );
    const page = {
      waitForEvent: () => new Promise(() => undefined),
      mainFrame: () => ({}),
    } as unknown as Page;
    expect(await port.go(page, 0, 'https://a.example/', allowed)).toBe('refused');
    // The host gets DorkOS's full address list, so its own guard refuses every one.
    expect(goToHistory).toHaveBeenCalledWith(0, 'https://a.example/', APP);
  });
});
