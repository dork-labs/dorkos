import { EventEmitter } from 'node:events';
import { vi, type Mock } from 'vitest';
import type { BrowserContext, Page } from 'playwright-core';
import type { LocalBrowserBackend } from '../playwright-backend.js';

export interface FixturePage {
  value: Page;
  events: EventEmitter;
  body: { ariaSnapshot: Mock<() => Promise<string>> };
  nodes: { evaluate: Mock<() => Promise<boolean>>; dispose: Mock<() => Promise<undefined>> };
  navigate(next: string): void;
}

/** Playwright's page/context edge only; the real service, broker, policy and tools run above it. */
export function chatPagesFixture() {
  const contextEvents = new EventEmitter();
  const pages: FixturePage[] = [];
  const makePage = (): FixturePage => {
    const events = new EventEmitter();
    let url = 'about:blank';
    let closed = false;
    const mainFrame = { url: () => url };
    const nodes = { evaluate: vi.fn(async () => true), dispose: vi.fn(async () => undefined) };
    const element = { dispose: vi.fn(async () => undefined) };
    const body = {
      count: async () => 1,
      nth: (): unknown => body,
      first: (): unknown => body,
      ariaSnapshot: vi.fn(async () => `- heading "${url}"`),
      elementHandle: async () => element,
    };
    const pixels = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(pixels);
    pixels.write('IHDR', 12);
    pixels.writeUInt32BE(100, 16);
    pixels.writeUInt32BE(100, 20);
    const value = {
      on: events.on.bind(events),
      off: events.off.bind(events),
      isClosed: () => closed,
      url: () => url,
      title: vi.fn(async () => `Title of ${url}`),
      context: () => context,
      mainFrame: () => mainFrame,
      frames: () => [mainFrame],
      evaluateHandle: vi.fn(async () => nodes),
      locator: () => body,
      bringToFront: vi.fn(async () => undefined),
      screenshot: vi.fn(async () => pixels),
      goto: vi.fn(async (next: string) => {
        url = next;
        events.emit('framenavigated', mainFrame);
      }),
      close: vi.fn(async () => {
        closed = true;
        events.emit('close');
      }),
    } as unknown as Page;
    const fixture = {
      value,
      events,
      body,
      nodes,
      navigate: (next: string) => {
        url = next;
        events.emit('framenavigated', mainFrame);
      },
    };
    pages.push(fixture);
    return fixture;
  };
  const context = {
    on: contextEvents.on.bind(contextEvents),
    off: contextEvents.off.bind(contextEvents),
    pages: () => pages.filter((page) => !page.value.isClosed()).map((page) => page.value),
    newPage: vi.fn(async () => {
      const page = makePage();
      contextEvents.emit('page', page.value);
      return page.value;
    }),
    close: vi.fn(async () => {
      contextEvents.emit('close');
    }),
    newCDPSession: vi.fn(async () => ({
      on: vi.fn(),
      send: vi.fn(async (method: string) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame' } } };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
        if (method === 'Runtime.evaluate') return { result: { value: false } };
        return {};
      }),
    })),
  } as unknown as BrowserContext;
  const backend: LocalBrowserBackend = { launch: vi.fn(async () => context), connect: vi.fn() };
  return { backend, context, contextEvents, pages, makePage };
}
