/** The fake Playwright page, context and browser the local-browser service tests drive, and their teardown. */
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, vi } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { LocalBrowserPageSession } from '../../leases/page-session.js';
import { BrowserProfileConnections } from '../../leases/profile-connection.js';
import { BrowserHandover } from '../../handover.js';
import { SignInWindow } from '../../sign-in-window.js';
import type { LocalBrowserBackend } from '../../playwright-backend.js';

export function fixture() {
  const events = new EventEmitter();
  const contextEvents = new EventEmitter();
  const browserEvents = new EventEmitter();
  let url = 'http://fixture.test/';
  let snapshot = '- button "Save"';
  const click = vi.fn(async () => undefined);
  const fill = vi.fn(async () => undefined);
  const handle = {
    click,
    fill,
    isEditable: vi.fn(async () => true),
    evaluate: vi.fn(async () => false),
    dispose: vi.fn(async (): Promise<void> => undefined),
  };
  const locator = {
    elementHandle: vi.fn(async () => handle),
    ariaSnapshot: vi.fn(async () => snapshot),
    count: vi.fn(async () => 1),
    click,
    fill,
    isEditable: vi.fn(async () => true),
  };
  // `body` as Playwright reads it: strict, so one call on two bodies fails (DOR-4192).
  let bodies = 1;
  let secondBody = '- link "Made-up second body"';
  const strict = () => new Error("strict mode violation: locator('body') resolved to 2 elements");
  const nthBody = (index: number) => ({
    ariaSnapshot: async () => (index === 0 ? locator.ariaSnapshot() : secondBody),
    elementHandle: async () => locator.elementHandle(),
  });
  const body = {
    count: vi.fn(async () => bodies),
    nth: nthBody,
    first: () => nthBody(0),
    ariaSnapshot: vi.fn(async () => {
      if (bodies > 1) throw strict();
      return locator.ariaSnapshot();
    }),
    elementHandle: vi.fn(async () => {
      if (bodies > 1) throw strict();
      return locator.elementHandle();
    }),
  };
  let isOriginalNode = true;
  const observedNodeSets: {
    evaluate: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }[] = [];
  const pixels = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(pixels);
  pixels.write('IHDR', 12, 'ascii');
  pixels.writeUInt32BE(100, 16);
  pixels.writeUInt32BE(100, 20);
  const frame = {};
  const childFrames: { url: () => string }[] = [];
  const page = {
    on: events.on.bind(events),
    off: events.off.bind(events),
    once: events.once.bind(events),
    waitForEvent: (name: string, options: { predicate: (value: unknown) => boolean }) =>
      new Promise((resolve) => {
        const on = (value: unknown) => {
          if (!options.predicate(value)) return;
          events.off(name, on);
          resolve(value);
        };
        events.on(name, on);
      }),
    context: () => context,
    url: () => url,
    title: async () => 'Fixture',
    isClosed: () => false,
    mainFrame: () => frame,
    frames: () => childFrames,
    keyboard: { press: vi.fn(async () => undefined) },
    mouse: { wheel: vi.fn(async () => undefined) },
    screenshot: vi.fn(async () => Buffer.from(pixels)),
    evaluateHandle: vi.fn(async () => {
      const nodes = {
        evaluate: vi.fn(async () => isOriginalNode),
        dispose: vi.fn(async (): Promise<void> => undefined),
      };
      observedNodeSets.push(nodes);
      return nodes;
    }),
    locator: (selector: string) => (selector === 'body' ? body : locator),
    getByRole: vi.fn(() => locator),
    bringToFront: vi.fn(async () => undefined),
    goto: vi.fn(async (next: string) => {
      url = next;
      events.emit('framenavigated', frame);
    }),
  } as unknown as Page;
  const context = {
    browser: () => null,
    pages: () => [page],
    on: contextEvents.on.bind(contextEvents),
    once: contextEvents.once.bind(contextEvents),
    off: contextEvents.off.bind(contextEvents),
    close: vi.fn(async () => undefined),
    newPage: vi.fn(async () => page),
  } as unknown as BrowserContext;
  const browser = {
    version: () => '153.0.0.0',
    contexts: () => [context],
    on: browserEvents.on.bind(browserEvents),
    once: browserEvents.once.bind(browserEvents),
    off: browserEvents.off.bind(browserEvents),
    close: vi.fn(async () => undefined),
  } as unknown as Browser;
  const backend: LocalBrowserBackend = {
    launch: vi.fn(async () => context),
    connect: vi.fn(async () => browser),
  };
  return {
    page,
    handle,
    contextEvents,
    browserEvents,
    events,
    backend,
    context,
    browser,
    locator,
    click,
    fill,
    observedNodeSets,
    pixels,
    replaceNode: () => {
      isOriginalNode = false;
    },
    navigate: (next: string) => {
      url = next;
      events.emit('framenavigated', frame);
    },
    change: (next: string) => {
      snapshot = next;
    },
    addFrame: (frameUrl: string) => {
      childFrames.push({ url: () => frameUrl });
    },
    /** Give the page a second `<body>`, with its own outline. */
    addBody: (outline = secondBody) => {
      bodies = 2;
      secondBody = outline;
    },
  };
}
export const sessions: LocalBrowserPageSession[] = [];
export function trackedPageSession(...args: ConstructorParameters<typeof LocalBrowserPageSession>) {
  const session = new LocalBrowserPageSession(...args);
  sessions.push(session);
  return session;
}
export const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    sessions.splice(0).map((session) => session.disconnect().catch(() => undefined))
  );
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
export async function create(appOrigins?: () => readonly string[], pooled = false) {
  const dir = await mkdtemp(path.join(tmpdir(), 'local-browser-unit-'));
  directories.push(dir);
  const f = fixture();
  if (pooled) f.page.close = vi.fn(async () => undefined);
  const backend = pooled ? new BrowserProfileConnections(f.backend).forChat() : f.backend;
  return {
    ...f,
    dir,
    service: trackedPageSession(
      dir,
      undefined,
      backend,
      undefined,
      () => ({
        platform: 'darwin',
      }),
      undefined,
      appOrigins
    ),
  };
}

export async function selectOwned(service: LocalBrowserPageSession) {
  const state = await service.open({ mode: 'new-window' });
  await service.selectTab(state.tabs[0].id);
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export async function lifecycleFixture() {
  const fixture = await create();
  const audit = vi.fn(
    async (_record: import('../../action-audit.js').LocalBrowserAuditRecord): Promise<void> =>
      undefined
  );
  return {
    ...fixture,
    audit,
    service: trackedPageSession(fixture.dir, undefined, fixture.backend, audit, () => ({
      platform: 'darwin',
    })),
  };
}

export async function handoffCloseFixture() {
  const f = await lifecycleFixture();
  f.service.useProfileAccess(
    async () => undefined,
    () => true
  );
  const signIns = new SignInWindow({
    executable: async () => '/made-up/Chromium',
    installedChrome: () => undefined,
    held: () => false,
    lockOwner: () => 12345,
    prepare: async () => undefined,
    spawner: () => ({
      pid: 12345,
      exited: new Promise(() => {}),
      quit: () => undefined,
      forceQuit: () => undefined,
    }),
  });
  const handover = new BrowserHandover(f.service, signIns, () => f.dir);
  handover.useOutsideTurnCheck(async () => null);
  await f.service.open({ mode: 'new-window', sessionId: 'chat-one', url: 'https://example.test/' });
  const close = deferred<void>();
  vi.mocked(f.context.close).mockReturnValueOnce(close.promise);
  return { ...f, handover, signIns, close };
}

/**
 * Back and Forward (DOR-4449) over a made-up DevTools history: the page's
 * entries, moved by entry id, with every document load the step's guard sees.
 */
export function withHistory(f: ReturnType<typeof fixture>, urls: string[], index: number) {
  const history = { urls: [...urls], index };
  const session = new EventEmitter();
  const sent: string[] = [];
  const cdp = {
    on: session.on.bind(session),
    off: session.off.bind(session),
    send: vi.fn(async (method: string, params: { entryId?: number } = {}) => {
      sent.push(method);
      if (method === 'Page.getNavigationHistory')
        return {
          currentIndex: history.index,
          entries: history.urls.map((url, at) => ({ id: at + 1, url })),
        };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Page.navigateToHistoryEntry') {
        history.index = params.entryId! - 1;
        queueMicrotask(() => f.navigate(history.urls[history.index]!));
      }
      return {};
    }),
  };
  Object.assign(f.context, { newCDPSession: vi.fn(async () => cdp) });
  f.navigate(urls[index]!);
  return { history, sent };
}
