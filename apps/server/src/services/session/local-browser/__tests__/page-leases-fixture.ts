import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import type { BrowserContext, Page } from 'playwright-core';
import type {
  LocalBrowserAction,
  LocalBrowserObservation,
  LocalBrowserState,
} from '@dorkos/shared/local-browser';
import { noopLogger } from '@dorkos/shared/logger';
import { composeRegistry } from '../../../core/capabilities/index.js';
import { createLocalBrowserDomain } from '../capabilities.js';
import { LocalBrowserService } from '../service.js';
import type { LocalBrowserBackend } from '../playwright-backend.js';
import { SignInWindow } from '../sign-in-window.js';

/** A controllable protocol boundary; no browser binary or server is started. */
export function fakeLeasePage(context: () => BrowserContext, label: string) {
  const events = new EventEmitter();
  let closed = false;
  let url = `https://${label}.example.test/`;
  let outline = `- button "Save ${label}"`;
  const pixels = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(pixels);
  pixels.write('IHDR', 12, 'ascii');
  pixels.writeUInt32BE(100, 16);
  pixels.writeUInt32BE(100, 20);
  const nodes = {
    evaluate: vi.fn(async () => true),
    dispose: vi.fn(async () => undefined),
  };
  const element = {
    dispose: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => false),
    isEditable: vi.fn(async () => true),
    click: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
  };
  const locator = {
    count: vi.fn(async () => 1),
    ariaSnapshot: vi.fn(async () => outline),
    elementHandle: vi.fn(async () => element),
  };
  const frame = { url: () => url };
  const wheel = vi.fn(async (): Promise<void> => undefined);
  const page = {
    on: events.on.bind(events),
    once: events.once.bind(events),
    off: events.off.bind(events),
    removeListener: events.removeListener.bind(events),
    isClosed: () => closed,
    url: () => url,
    context,
    opener: vi.fn(async () => null),
    title: vi.fn(async () => `Page ${label}`),
    mainFrame: () => frame,
    frames: () => [frame],
    evaluateHandle: vi.fn(async () => nodes),
    locator: () => ({ ...locator, first: () => locator, nth: () => locator }),
    getByRole: () => locator,
    mouse: {
      wheel,
      move: vi.fn(async () => undefined),
      down: vi.fn(async () => undefined),
      up: vi.fn(async () => undefined),
    },
    keyboard: {
      press: vi.fn(async () => undefined),
      down: vi.fn(async () => undefined),
      up: vi.fn(async () => undefined),
      insertText: vi.fn(async () => undefined),
    },
    screenshot: vi.fn(async () => pixels),
    bringToFront: vi.fn(async () => undefined),
    goto: vi.fn(async (next: string) => {
      url = next;
      events.emit('framenavigated', frame);
    }),
    close: vi.fn(async () => {
      if (closed) return;
      closed = true;
      events.emit('close');
    }),
  } as unknown as Page;
  return {
    page,
    events,
    nodes,
    locator,
    wheel,
    navigate(next: string) {
      url = next;
      events.emit('framenavigated', frame);
    },
    outline(next: string) {
      outline = next;
    },
  };
}

/** Deferred protocol work has an explicit entry witness and release, never a timing sleep. */
export function heldProtocolCall() {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    started,
    release,
    run: async () => {
      entered();
      await pending;
    },
  };
}

/** Exercise real service, profile admission and capability scoping over fake protocol edges. */
export async function leaseFixture(leaseAudit?: (record: unknown) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'page-leases-'));
  const contexts: { context: BrowserContext; pages: ReturnType<typeof fakeLeasePage>[] }[] = [];
  const protocolSessions: {
    page: Page;
    events: EventEmitter;
    send: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
  }[] = [];
  const backend: LocalBrowserBackend = {
    connect: vi.fn(async () => {
      throw new Error('Own-window fixture must not attach');
    }),
    launch: vi.fn(async () => {
      const events = new EventEmitter();
      const pages: ReturnType<typeof fakeLeasePage>[] = [];
      const context = {
        on: events.on.bind(events),
        once: events.once.bind(events),
        off: events.off.bind(events),
        browser: () => null,
        pages: () => pages.filter((p) => !p.page.isClosed()).map((p) => p.page),
        newPage: vi.fn(async () => {
          const next = fakeLeasePage(() => context, `page-${contexts.length}-${pages.length}`);
          pages.push(next);
          events.emit('page', next.page);
          return next.page;
        }),
        newCDPSession: vi.fn(async (page: Page) => {
          const events = new EventEmitter();
          const send = vi.fn(async (command: string) => {
            if (command === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame' } } };
            if (command === 'Page.createIsolatedWorld') return { executionContextId: 1 };
            return { result: { value: false } };
          });
          const detach = vi.fn(async () => undefined);
          protocolSessions.push({ page, events, send, detach });
          return { on: events.on.bind(events), off: events.off.bind(events), send, detach };
        }),
        close: vi.fn(async () => {
          await Promise.all(pages.map((p) => p.page.close()));
          events.emit('close');
        }),
      } as unknown as BrowserContext;
      contexts.push({ context, pages });
      return context;
    }),
  };
  const audit = vi.fn(async () => undefined);
  const signIn = vi
    .spyOn(SignInWindow.prototype, 'start')
    .mockRejectedValue(new Error('Unexpected plain-window launch'));
  const service = new LocalBrowserService(
    directory,
    undefined,
    backend,
    audit,
    () => ({
      platform: 'darwin',
    }),
    undefined,
    undefined,
    leaseAudit,
    async () => 'agent-atlas'
  );
  service.useProfileSelection(async (input) => ({
    id: input.profileId ?? 'default',
    label: 'Fixture browser',
    agentId: input.sessionId ? 'agent-atlas' : null,
    agentName: null,
  }));
  service.useProfileAccess(
    async () => undefined,
    () => true
  );
  service.handover.useOutsideTurnCheck(async () => null);
  const registry = composeRegistry([createLocalBrowserDomain(service)], { logger: noopLogger });
  return {
    directory,
    service,
    backend,
    contexts,
    protocolSessions,
    audit,
    signIn,
    open: (sessionId: string, profileId = 'agent-atlas') =>
      service.open({ mode: 'new-window', sessionId, profileId }),
    state: (sessionId: string) =>
      registry.invoke('local_browser.state', {}, { sessionId }) as Promise<LocalBrowserState>,
    observe: (sessionId: string) =>
      registry.invoke(
        'local_browser.observe',
        {},
        { sessionId }
      ) as Promise<LocalBrowserObservation>,
    act: (sessionId: string, action: LocalBrowserAction) =>
      registry.invoke('local_browser.act', { action }, { sessionId }),
    screenshot: (sessionId: string) =>
      registry.invoke('local_browser.screenshot', {}, { sessionId }),
    ask: (sessionId: string) =>
      registry.invoke('local_browser.ask_person', { reason: 'wall' }, { sessionId }),
    async cleanup() {
      await service.closeAll().catch(() => undefined);
      await Promise.all(contexts.map(({ context }) => context.close()));
      signIn.mockRestore();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
