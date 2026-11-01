import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import {
  ACTION_EFFECT_RESPONSE_TIMEOUT_MS,
  PAGE_READ_RESPONSE_TIMEOUT_MS,
  CLOSE_RESPONSE_TIMEOUT_MS,
} from '../lifecycle.js';
import { AUDIT_WRITE_RESPONSE_TIMEOUT_MS } from '../page-action.js';
import { LocalBrowserService } from '../service.js';
import { CLOUD_ORIGIN_REFUSAL } from '@dorkos/shared/cloud-origin';
import { MAX_BROWSER_SNAPSHOT_BYTES, MAX_BROWSER_SCREENSHOT_EDGE } from '../observation-limits.js';
import type { LocalBrowserBackend } from '../playwright-backend.js';

function fixture() {
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
    locator: () => locator,
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
  };
}
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function create(appOrigins?: () => readonly string[]) {
  const dir = await mkdtemp(path.join(tmpdir(), 'local-browser-unit-'));
  directories.push(dir);
  const f = fixture();
  return {
    ...f,
    dir,
    service: new LocalBrowserService(
      dir,
      undefined,
      f.backend,
      undefined,
      () => ({
        platform: 'darwin',
      }),
      undefined,
      appOrigins
    ),
  };
}
async function selectOwned(service: LocalBrowserService) {
  const state = await service.open({ mode: 'new-window' });
  await service.selectTab(state.tabs[0].id);
}

describe('local browser ownership and observations', () => {
  it('refuses an unsupported mode before either browser backend can run', async () => {
    const { service, backend } = await create();
    await expect(
      service.open({
        mode: 'existing',
      } as unknown as import('@dorkos/shared/local-browser').LocalBrowserOpen)
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(backend.launch).not.toHaveBeenCalled();
    expect(backend.connect).not.toHaveBeenCalled();
  });

  it('refuses a headed window on Linux without a graphical display before launch', async () => {
    const f = await create();
    const service = new LocalBrowserService(f.dir, undefined, f.backend, undefined, () => ({
      platform: 'linux',
    }));
    expect(service.capabilities()).toMatchObject({
      newWindow: false,
      unavailableReasons: { 'new-window': 'Open DorkOS on a computer with a display.' },
    });
    await expect(service.open({ mode: 'new-window' })).rejects.toMatchObject({
      code: 'unsupported',
      message: 'Open DorkOS on a computer with a display.',
    });
    expect(f.backend.launch).not.toHaveBeenCalled();
    expect(f.backend.connect).not.toHaveBeenCalled();
  });
  it.each([{ display: ':0' }, { waylandDisplay: 'wayland-0' }])(
    'opens an owned window for a declared Linux graphical session %o',
    async (display) => {
      const f = await create();
      const service = new LocalBrowserService(f.dir, undefined, f.backend, undefined, () => ({
        platform: 'linux',
        ...display,
      }));
      await service.open({ mode: 'new-window' });
      expect(f.backend.launch).toHaveBeenCalledOnce();
      await service.disconnect();
    }
  );
  it('opens an explicit URL in the owned selected page', async () => {
    const { service, context, page } = await create();
    const state = await service.open({
      mode: 'new-window',
      sessionId: 'chat-one',
      url: 'http://fixture.test/new',
    });
    expect(state.selectedTabId).toBe(state.tabs[0].id);
    expect(page.goto).toHaveBeenCalledWith('http://fixture.test/new', {
      waitUntil: 'commit',
      timeout: 15_000,
    });
    expect(context.newPage).not.toHaveBeenCalled();
    await service.disconnect();
  });
  it('fences observation and late selection when a person chooses another owned tab', async () => {
    const { service, context, page, observedNodeSets } = await create();
    const other = fixture();
    vi.spyOn(context, 'pages').mockReturnValue([page, other.page]);
    const state = await service.open({ mode: 'new-window', sessionId: 'chat-one' });
    let finishSelection!: () => void;
    vi.mocked(page.bringToFront).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishSelection = resolve;
      })
    );
    const first = service.selectTab(state.tabs[0].id);
    const firstRefusal = expect(first).rejects.toMatchObject({ code: 'stale_page' });
    const observing = service.observe();
    const observationRefusal = expect(observing).rejects.toMatchObject({ code: 'stale_page' });
    const second = service.selectTab(state.tabs[1].id);
    finishSelection();
    await Promise.all([firstRefusal, observationRefusal, second]);
    expect(observedNodeSets[0].dispose).toHaveBeenCalledOnce();
    expect((await service.state()).selectedTabId).toBe(state.tabs[1].id);
    await service.disconnect();
  });

  it('never polls unselected documents or waits for them on agent state/action completion', async () => {
    const { service, context, page } = await create();
    const unrelated = fixture();
    vi.spyOn(context, 'pages').mockReturnValue([page, unrelated.page]);
    const unrelatedTitle = vi
      .spyOn(unrelated.page, 'title')
      .mockImplementation(() => new Promise<string>(() => {}));
    const state = await service.open({ mode: 'new-window', sessionId: 'chat-one' });
    await service.selectTab(state.tabs[0].id);
    unrelatedTitle.mockClear();
    const selectedTitle = vi.spyOn(page, 'title');
    selectedTitle.mockClear();
    await service.state();
    await service.state();
    const agent = await service.agentState();
    expect(agent.tabs.map((tab) => tab.id)).toEqual([state.tabs[0].id]);
    const observed = await service.observe();
    const result = await service.action({
      kind: 'click',
      role: 'button',
      name: 'Save',
      revision: observed.revision,
    });
    expect(result.tabs.map((tab) => tab.id)).toEqual([state.tabs[0].id]);
    expect(unrelatedTitle).not.toHaveBeenCalled();
    expect(selectedTitle).toHaveBeenCalled();
    await service.disconnect();
  });
  it('refreshes cached labels on document events without reading titles on polling', async () => {
    const { service, context, page, events } = await create();
    const selected = fixture();
    vi.spyOn(context, 'pages').mockReturnValue([selected.page, page]);
    let finishInitialTitle!: (title: string) => void;
    const title = vi.spyOn(page, 'title').mockResolvedValue('Loaded document');
    title.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishInitialTitle = resolve;
        })
    );
    const state = await service.open({ mode: 'new-window', sessionId: 'chat-one' });
    // Opening must finish even when the document never answers its title request.
    expect(state.tabs[1].title).toBe('');
    events.emit('domcontentloaded');
    await Promise.resolve();
    const count = title.mock.calls.length;
    expect((await service.state()).tabs[1].title).toBe('Loaded document');
    finishInitialTitle('Old document');
    await Promise.resolve();
    expect((await service.state()).tabs[1].title).toBe('Loaded document');
    expect(title).toHaveBeenCalledTimes(count);
    await service.disconnect();
  });
  it('refreshes a selected same-document title after polling and action completion', async () => {
    const { service, page, fill } = await create();
    let current = 'Before input';
    vi.spyOn(page, 'title').mockImplementation(async () => current);
    const state = await service.open({ mode: 'new-window', sessionId: 'chat-one' });
    await service.selectTab(state.tabs[0].id);
    current = 'Human input';
    await service.state();
    expect((await service.agentState()).tabs[0].title).toBe('Human input');
    const observed = await service.observe();
    fill.mockImplementationOnce(async () => {
      current = 'Agent input';
    });
    await service.action({
      kind: 'fill',
      role: 'textbox',
      name: 'Title',
      text: 'Agent input',
      revision: observed.revision,
    });
    expect((await service.agentState()).tabs[0].title).toBe('Agent input');
    await service.disconnect();
  });
  it('captures state identity atomically across selection and disconnect changes', async () => {
    const { service, context, page } = await create();
    const other = fixture();
    vi.spyOn(context, 'pages').mockReturnValue([page, other.page]);
    const state = await service.open({ mode: 'new-window', sessionId: 'chat-one' });
    await service.selectTab(state.tabs[0].id);
    const first = service.agentState();
    await service.selectTab(state.tabs[1].id);
    const captured = await first;
    expect(captured.connectionId).toBe(state.connectionId);
    expect(captured.selectedTabId).toBe(state.tabs[0].id);
    expect(captured.tabs.map((tab) => tab.id)).toEqual([state.tabs[0].id]);
    const second = service.agentState();
    await service.disconnect();
    const prior = await second;
    expect(prior.connectionId).toBe(state.connectionId);
    expect(prior.selectedTabId).toBe(state.tabs[1].id);
    expect(prior.tabs.map((tab) => tab.id)).toEqual([state.tabs[1].id]);
    expect((await service.agentState()).tabs).toEqual([]);
  });
  it('rejects an oversized UTF-8 observation without granting a revision or retaining node handles', async () => {
    const { service, change, click, observedNodeSets } = await create();
    await selectOwned(service);
    await service.observe();
    change('界'.repeat(Math.ceil(MAX_BROWSER_SNAPSHOT_BYTES / 3)));
    await expect(service.observe()).rejects.toMatchObject({ code: 'page_too_large' });
    expect(observedNodeSets[1].dispose).toHaveBeenCalledOnce();
    const state = await service.state();
    await expect(
      service.action({ kind: 'click', role: 'button', name: 'Save', revision: state.revision })
    ).rejects.toMatchObject({ code: 'stale_page' });
    expect(click).not.toHaveBeenCalled();
    change('- button "Save"');
    await service.observe();
    await service.disconnect();
  });
  it('rejects screenshot dimensions without resizing the live page or granting an action revision', async () => {
    const { service, page, pixels } = await create();
    await selectOwned(service);
    const revision = (await service.state()).revision;
    const large = Buffer.from(pixels);
    large.writeUInt32BE(MAX_BROWSER_SCREENSHOT_EDGE + 1, 16);
    vi.mocked(page.screenshot).mockResolvedValueOnce(large);
    await expect(service.screenshot()).rejects.toMatchObject({ code: 'image_too_large' });
    expect(page.screenshot).toHaveBeenCalledExactlyOnceWith({
      type: 'png',
      fullPage: false,
      timeout: 750,
    });
    expect((await service.state()).revision).toBe(revision);
    await expect(
      service.action({ kind: 'click', role: 'button', name: 'Save', revision })
    ).rejects.toMatchObject({ code: 'stale_page' });
    await service.disconnect();
  });

  it('scopes keys, scrolling, and screenshots to the selected live page', async () => {
    const { service, page, pixels } = await create();
    await selectOwned(service);
    const first = await service.observe();
    await service.action({ kind: 'press', revision: first.revision, key: 'Enter' });
    expect(page.keyboard.press).toHaveBeenCalledExactlyOnceWith('Enter');
    const second = await service.observe();
    await service.action({ kind: 'scroll', revision: second.revision, deltaX: 0, deltaY: 600 });
    expect(page.mouse.wheel).toHaveBeenCalledExactlyOnceWith(0, 600);
    const image = await service.screenshot();
    expect(image).toMatchObject({
      data: pixels.toString('base64'),
      mimeType: 'image/png',
    });
  });
  it('journals outcomes without typed values or URL queries and refuses when recording is unavailable', async () => {
    const { service, dir, click, navigate, backend, page } = await create();
    await selectOwned(service);
    navigate('http://fixture.test/path?private_query=hidden');
    const first = await service.observe();
    await service.action({
      kind: 'fill',
      revision: first.revision,
      role: 'textbox',
      name: 'Email',
      text: 'private typed secret',
    });
    vi.spyOn(page, 'title').mockResolvedValue('private typed secret in page title');
    const second = await service.observe();
    click
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        throw new Error('timeout after dispatch');
      });
    await expect(
      service.action({ kind: 'click', revision: second.revision, role: 'button', name: 'Save' })
    ).rejects.toMatchObject({ code: 'uncertain' });
    const journal = await readFile(path.join(dir, 'local-browser', 'actions.jsonl'), 'utf8');
    expect(journal).not.toContain('private typed secret');
    expect(journal).not.toContain('private_query');
    expect(journal).not.toContain('/path');
    const records = journal
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.outcome)).toEqual([
      'unknown',
      'succeeded',
      'unknown',
      'unknown',
    ]);
    expect(records[0].operationId).toBe(records[1].operationId);
    expect(records[0].tabId).toEqual(expect.any(String));
    expect(records.every((record) => !('title' in record))).toBe(true);
    const noAudit = new LocalBrowserService(
      dir,
      undefined,
      backend,
      async () => {
        throw new Error('disk unavailable');
      },
      () => ({ platform: 'darwin' })
    );
    await selectOwned(noAudit);
    const fresh = await noAudit.observe();
    await expect(
      noAudit.action({ kind: 'click', revision: fresh.revision, role: 'button', name: 'Save' })
    ).rejects.toMatchObject({ code: 'audit_unavailable' });
    expect(click).toHaveBeenCalledTimes(2);
  });
  it('refuses observed actions after a person navigates', async () => {
    const { service, navigate, click } = await create();
    await selectOwned(service);
    const { revision } = await service.observe();
    navigate('http://fixture.test/other');
    await expect(
      service.action({ kind: 'click', role: 'button', name: 'Save', revision })
    ).rejects.toMatchObject({ code: 'stale_page' });
    expect(click).not.toHaveBeenCalled();
  });
  it('checks current page content and never reuses a consumed revision', async () => {
    const { service, change, click } = await create();
    await selectOwned(service);
    const old = await service.observe();
    change('- button "Delete"');
    await expect(
      service.action({ kind: 'click', role: 'button', name: 'Save', revision: old.revision })
    ).rejects.toMatchObject({ code: 'stale_page' });
    expect(click).not.toHaveBeenCalled();
    const current = await service.observe();
    await service.action({
      kind: 'click',
      role: 'button',
      name: 'Delete',
      revision: current.revision,
    });
    await expect(
      service.action({ kind: 'click', role: 'button', name: 'Delete', revision: current.revision })
    ).rejects.toMatchObject({ code: 'stale_page' });
    expect(click).toHaveBeenCalledTimes(2); // trial plus exactly one real click
  });
  it('pause during actionability wait prevents effect dispatch', async () => {
    const { service, click } = await create();
    await selectOwned(service);
    const { revision } = await service.observe();
    let release!: () => void;
    let trialStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      trialStarted = resolve;
    });
    click.mockImplementationOnce(async () => {
      trialStarted();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const action = service.action({ kind: 'click', role: 'button', name: 'Save', revision });
    const rejection = expect(action).rejects.toMatchObject({ code: 'paused' });
    await started;
    const pause = service.pause();
    release();
    await pause;
    await rejection;
    expect(click).toHaveBeenCalledTimes(1);
    expect((await service.state()).paused).toBe(true);
    await service.resume();
    await expect(
      service.action({ kind: 'click', role: 'button', name: 'Save', revision })
    ).rejects.toMatchObject({ code: 'stale_page' });
  });
  it('refuses an identical accessible replacement node at the same address', async () => {
    const { service, click, replaceNode, observedNodeSets } = await create();
    await selectOwned(service);
    const { revision } = await service.observe();
    replaceNode();
    await expect(
      service.action({ kind: 'click', revision, role: 'button', name: 'Save' })
    ).rejects.toMatchObject({ code: 'stale_page' });
    expect(click).not.toHaveBeenCalled();
    expect(observedNodeSets[0].dispose).toHaveBeenCalledOnce();
  });
  it('disposes observation identity on new observations, navigation, and disconnect', async () => {
    const { service, observedNodeSets, navigate } = await create();
    await selectOwned(service);
    const first = await service.observe();
    const second = await service.observe();
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(observedNodeSets[0].dispose).toHaveBeenCalledOnce();
    navigate('http://fixture.test/other');
    expect(observedNodeSets[1].dispose).toHaveBeenCalledOnce();
    await service.observe();
    await service.disconnect();
    expect(observedNodeSets[2].dispose).toHaveBeenCalledOnce();
  });
  it('navigation during the trial never dispatches an effect into the new page', async () => {
    const { service, click, navigate } = await create();
    await selectOwned(service);
    const { revision } = await service.observe();
    click.mockImplementationOnce(async () => {
      navigate('http://fixture.test/replacement');
    });
    await expect(
      service.action({ kind: 'click', role: 'button', name: 'Save', revision })
    ).rejects.toMatchObject({ code: 'stale_page' });
    expect(click).toHaveBeenCalledTimes(1);
  });
  it('shares only with the chosen chat and exposes only its selected tab to tools', async () => {
    const { service } = await create();
    const state = await service.open({ mode: 'new-window', sessionId: 'chat-one' });
    expect(() => service.requireSharedSession('chat-two')).toThrow();
    expect(() => service.requireSharedSession('chat-one')).not.toThrow();
    expect((await service.agentState()).selectedTabId).toBe(state.tabs[0].id);
    await service.selectTab(state.tabs[0].id);
    expect((await service.agentState()).tabs).toHaveLength(1);
    await service.disconnect();
    expect(() => service.requireSharedSession('chat-one')).toThrow();
  });

  it('closes the embedded bridge transport and guest without closing an owned context', async () => {
    const f = await create();
    const close = vi.fn(async () => undefined);
    const embedded = {
      open: vi.fn(async () => ({
        endpoint: 'ws://127.0.0.1:41111/page/fixture',
        headers: { Authorization: 'Bearer fixture' },
        close,
      })),
    };
    const service = new LocalBrowserService(f.dir, embedded, f.backend);
    await service.open({ mode: 'embedded' });
    expect(f.backend.connect).toHaveBeenCalledWith('ws://127.0.0.1:41111/page/fixture', {
      Authorization: 'Bearer fixture',
    });
    await service.disconnect();
    expect(f.browser.close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(f.context.close).not.toHaveBeenCalled();
    expect((await service.state()).status).toBe('disconnected');
  });
  it('reports managed preparation while opening and fences callbacks after cancellation', async () => {
    const { service, backend, context } = await create();
    let progress!: NonNullable<Parameters<LocalBrowserBackend['launch']>[2]>;
    let finish!: (context: BrowserContext) => void;
    vi.mocked(backend.launch).mockImplementationOnce(async (_storage, _signal, report) => {
      progress = report!;
      return new Promise<BrowserContext>((resolve) => {
        finish = resolve;
      });
    });
    const opening = service.open({ mode: 'new-window', sessionId: 'chat-one' });
    const cancelled = expect(opening).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(backend.launch).toHaveBeenCalledOnce());
    expect((await service.state()).preparation).toEqual({
      stage: 'checking',
      component: null,
      percent: null,
    });
    progress({ stage: 'downloading', component: 'chromium', percent: 30 });
    expect((await service.state()).preparation?.percent).toBe(30);
    const disconnecting = service.disconnect();
    progress({ stage: 'downloading', component: 'chromium', percent: 80 });
    expect((await service.state()).preparation).toBeNull();
    finish(context);
    await Promise.all([cancelled, disconnecting]);
    const next = await service.open({ mode: 'new-window', sessionId: 'chat-two' });
    expect(next.preparation).toBeNull();
    progress({ stage: 'downloading', component: 'chromium', percent: 100 });
    expect((await service.state()).preparation).toBeNull();
    await service.disconnect();
  });
  it('disconnect during startup never leaves a late owned window connected', async () => {
    const { service, backend, context } = await create();
    let release!: (context: BrowserContext) => void;
    let started!: () => void;
    const launching = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(backend.launch).mockImplementationOnce(async () => {
      started();
      return new Promise<BrowserContext>((resolve) => {
        release = resolve;
      });
    });
    const opening = service.open({ mode: 'new-window' });
    const refusal = expect(opening).rejects.toMatchObject({ code: 'cancelled' });
    await launching;
    const disconnecting = service.disconnect();
    release(context);
    await Promise.all([refusal, disconnecting]);
    expect(context.close).toHaveBeenCalledOnce();
    expect((await service.state()).status).toBe('disconnected');
  });
  it('reuses DorkOS saved logins and closes only its owned window', async () => {
    const { service, backend, context, dir } = await create();
    await service.open({ mode: 'new-window' });
    await service.disconnect();
    await service.open({ mode: 'new-window' });
    expect(backend.launch).toHaveBeenNthCalledWith(
      1,
      path.join(dir, 'browser-profiles', 'default'),
      expect.any(AbortSignal),
      expect.any(Function)
    );
    expect(backend.launch).toHaveBeenNthCalledWith(
      2,
      path.join(dir, 'browser-profiles', 'default'),
      expect.any(AbortSignal),
      expect.any(Function)
    );
    expect(context.close).toHaveBeenCalledOnce();
  });
  it('does not replay an action whose effect may already have happened', async () => {
    const { service, click } = await create();
    await selectOwned(service);
    const { revision } = await service.observe();
    click
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        throw new Error('timeout after dispatch');
      });
    await expect(
      service.action({ kind: 'click', role: 'button', name: 'Save', revision })
    ).rejects.toMatchObject({ code: 'uncertain' });
    await expect(
      service.action({ kind: 'click', role: 'button', name: 'Save', revision })
    ).rejects.toMatchObject({ code: 'stale_page' });
    expect(click).toHaveBeenCalledTimes(2);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function lifecycleFixture() {
  const fixture = await create();
  const audit = vi.fn(
    async (_record: import('../action-audit.js').LocalBrowserAuditRecord): Promise<void> =>
      undefined
  );
  return {
    ...fixture,
    audit,
    service: new LocalBrowserService(fixture.dir, undefined, fixture.backend, audit, () => ({
      platform: 'darwin',
    })),
  };
}

describe('bounded browser lifecycle ownership', () => {
  it('returns pause immediately and retains pre-dispatch ownership after its response expires', async () => {
    const { service, observedNodeSets, click } = await lifecycleFixture();
    await service.open({ mode: 'new-window' });
    const observed = await service.observe();
    const stalled = deferred<boolean>();
    observedNodeSets[0].evaluate.mockReturnValueOnce(stalled.promise);
    vi.useFakeTimers();
    const acting = service.action({
      kind: 'click',
      role: 'button',
      name: 'Save',
      revision: observed.revision,
    });
    const refused = expect(acting).rejects.toMatchObject({ code: 'stale_page' });
    await vi.advanceTimersByTimeAsync(0);
    expect(observedNodeSets[0].evaluate).toHaveBeenCalledOnce();
    expect((await service.pause()).paused).toBe(true);
    await vi.advanceTimersByTimeAsync(ACTION_EFFECT_RESPONSE_TIMEOUT_MS);
    await refused;
    await service.resume();
    const fresh = await service.observe();
    await expect(
      service.action({ kind: 'click', role: 'button', name: 'Save', revision: fresh.revision })
    ).rejects.toMatchObject({ code: 'busy' });
    stalled.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(click).not.toHaveBeenCalled();
    await service.disconnect();
  });

  it('starts actual shutdown without awaiting a stalled action and fences its late continuation', async () => {
    const { service, observedNodeSets, context, click } = await lifecycleFixture();
    await service.open({ mode: 'new-window' });
    const observed = await service.observe();
    const stalled = deferred<boolean>();
    observedNodeSets[0].evaluate.mockReturnValueOnce(stalled.promise);
    vi.useFakeTimers();
    const acting = service.action({
      kind: 'click',
      role: 'button',
      name: 'Save',
      revision: observed.revision,
    });
    const refused = expect(acting).rejects.toMatchObject({ code: 'paused' });
    await vi.advanceTimersByTimeAsync(0);
    expect(observedNodeSets[0].evaluate).toHaveBeenCalledOnce();
    expect((await service.disconnect()).status).toBe('disconnected');
    expect(context.close).toHaveBeenCalledOnce();
    await expect(service.open({ mode: 'new-window' })).rejects.toMatchObject({ code: 'busy' });
    stalled.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    await refused;
    expect(click).not.toHaveBeenCalled();
  });

  it('reports a late input acknowledgement as unknown and never releases its pending lease on timeout', async () => {
    const { service, page, audit } = await lifecycleFixture();
    await service.open({ mode: 'new-window' });
    const observed = await service.observe();
    const acknowledgement = deferred<void>();
    vi.mocked(page.keyboard.press).mockReturnValueOnce(acknowledgement.promise);
    vi.useFakeTimers();
    const acting = service.action({ kind: 'press', key: 'Enter', revision: observed.revision });
    const uncertain = expect(acting).rejects.toMatchObject({ code: 'uncertain' });
    await vi.advanceTimersByTimeAsync(0);
    expect(page.keyboard.press).toHaveBeenCalledOnce();
    await service.pause();
    await vi.advanceTimersByTimeAsync(ACTION_EFFECT_RESPONSE_TIMEOUT_MS);
    await uncertain;
    await service.resume();
    const fresh = await service.observe();
    await expect(
      service.action({ kind: 'press', key: 'Enter', revision: fresh.revision })
    ).rejects.toMatchObject({ code: 'busy' });
    acknowledgement.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      audit.mock.calls.some(
        ([record]) =>
          record.phase === 'finished' && record.kind === 'press' && record.outcome === 'succeeded'
      )
    ).toBe(false);
    expect(page.keyboard.press).toHaveBeenCalledOnce();
    await service.disconnect();
  });

  it('does not let nonmutating handle disposal hold action completion or pause', async () => {
    const { service, handle } = await lifecycleFixture();
    await service.open({ mode: 'new-window' });
    const observed = await service.observe();
    handle.dispose.mockImplementationOnce(() => new Promise<void>(() => {}));
    await service.action({
      kind: 'click',
      role: 'button',
      name: 'Save',
      revision: observed.revision,
    });
    expect((await service.pause()).paused).toBe(true);
    await service.disconnect();
  });

  it('retains the owned profile after a protocol-close event until its close request settles', async () => {
    const { service, context, contextEvents, backend } = await lifecycleFixture();
    const state = await service.open({ mode: 'new-window' });
    const closing = deferred<void>();
    vi.mocked(context.close).mockReturnValueOnce(closing.promise);
    vi.useFakeTimers();
    const first = expect(service.disconnect()).rejects.toMatchObject({
      code: 'busy',
      message: 'The browser is still closing. Wait before opening it again.',
    });
    const second = expect(service.disconnect()).rejects.toMatchObject({ code: 'busy' });
    await vi.advanceTimersByTimeAsync(CLOSE_RESPONSE_TIMEOUT_MS);
    await Promise.all([first, second]);
    expect(context.close).toHaveBeenCalledOnce();
    await expect(service.open({ mode: 'new-window' })).rejects.toMatchObject({ code: 'busy' });
    await expect(service.resume()).rejects.toMatchObject({ code: 'busy' });
    await expect(service.navigate('http://fixture.test/new')).rejects.toMatchObject({
      code: 'busy',
    });
    await expect(service.selectTab(state.tabs[0].id)).rejects.toMatchObject({ code: 'busy' });
    expect(backend.launch).toHaveBeenCalledOnce();
    expect((await service.state()).paused).toBe(true);
    contextEvents.emit('close');
    await vi.advanceTimersByTimeAsync(0);
    expect((await service.state()).status).not.toBe('disconnected');
    await expect(service.open({ mode: 'new-window' })).rejects.toMatchObject({ code: 'busy' });
    await expect(service.resume()).rejects.toMatchObject({ code: 'busy' });
    expect(backend.launch).toHaveBeenCalledOnce();
    const completed = service.disconnect();
    closing.resolve();
    await completed;
    expect((await service.state()).status).toBe('disconnected');
    await service.open({ mode: 'new-window' });
    expect(backend.launch).toHaveBeenCalledTimes(2);
  });

  it('retains a failed owned close despite a later protocol-close event', async () => {
    const { service, context, contextEvents, backend } = await lifecycleFixture();
    await service.open({ mode: 'new-window' });
    vi.mocked(context.close).mockRejectedValueOnce(new Error('owned close request rejected'));
    await expect(service.disconnect()).rejects.toMatchObject({
      code: 'busy',
      message: 'Restart DorkOS to finish closing this browser.',
    });
    contextEvents.emit('close');
    expect((await service.state()).status).not.toBe('disconnected');
    await expect(service.disconnect()).rejects.toMatchObject({
      code: 'busy',
      message: 'Restart DorkOS to finish closing this browser.',
    });
    await expect(service.open({ mode: 'new-window' })).rejects.toMatchObject({ code: 'busy' });
    await expect(service.resume()).rejects.toMatchObject({ code: 'busy' });
    expect(context.close).toHaveBeenCalledOnce();
    expect(backend.launch).toHaveBeenCalledOnce();
  });

  it('keeps late acquisition and its actual close owned after bounded cancellation', async () => {
    const { service, context, backend } = await lifecycleFixture();
    const acquisition = deferred<BrowserContext>();
    vi.mocked(backend.launch).mockReturnValueOnce(acquisition.promise);
    const opening = service.open({ mode: 'new-window' });
    const cancelled = expect(opening).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(backend.launch).toHaveBeenCalledOnce());
    const closing = deferred<void>();
    vi.mocked(context.close).mockReturnValueOnce(closing.promise);
    vi.useFakeTimers();
    const disconnecting = expect(service.disconnect()).rejects.toMatchObject({ code: 'busy' });
    await vi.advanceTimersByTimeAsync(CLOSE_RESPONSE_TIMEOUT_MS);
    await disconnecting;
    await expect(service.open({ mode: 'new-window' })).rejects.toMatchObject({ code: 'busy' });
    acquisition.resolve(context);
    await vi.advanceTimersByTimeAsync(0);
    expect(context.close).toHaveBeenCalledOnce();
    await expect(service.open({ mode: 'new-window' })).rejects.toMatchObject({ code: 'busy' });
    closing.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await cancelled;
    expect((await service.state()).status).toBe('disconnected');
    expect(backend.launch).toHaveBeenCalledOnce();
  });

  it('bounds node observation and disposes a late handle without granting a revision', async () => {
    const { service, page } = await lifecycleFixture();
    await service.open({ mode: 'new-window' });
    const nodes = deferred<Awaited<ReturnType<Page['evaluateHandle']>>>();
    vi.mocked(page.evaluateHandle).mockReturnValueOnce(nodes.promise);
    vi.useFakeTimers();
    const reading = expect(service.observe()).rejects.toMatchObject({ code: 'stale_page' });
    await vi.advanceTimersByTimeAsync(PAGE_READ_RESPONSE_TIMEOUT_MS);
    await reading;
    const late = { dispose: vi.fn(async (): Promise<void> => undefined) };
    nodes.resolve(late as unknown as Awaited<ReturnType<Page['evaluateHandle']>>);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.dispose).toHaveBeenCalledOnce();
    await expect(
      service.action({ kind: 'press', key: 'Enter', revision: (await service.state()).revision })
    ).rejects.toMatchObject({ code: 'stale_page' });
    await service.disconnect();
  });

  it('bounds a human tab focus wait without keeping the UI request pending forever', async () => {
    const { service, page } = await lifecycleFixture();
    const state = await service.open({ mode: 'new-window' });
    vi.mocked(page.bringToFront).mockReturnValueOnce(new Promise<void>(() => {}));
    vi.useFakeTimers();
    const selecting = expect(service.selectTab(state.tabs[0].id)).rejects.toMatchObject({
      code: 'stale_page',
    });
    await vi.advanceTimersByTimeAsync(PAGE_READ_RESPONSE_TIMEOUT_MS);
    await selecting;
    await service.disconnect();
  });
  it('retains a failed embedded close tombstone and reports busy on every repeat', async () => {
    const fixture = await lifecycleFixture();
    const close = vi.fn(async () => {
      throw new Error('private bridge unavailable');
    });
    const service = new LocalBrowserService(
      fixture.dir,
      {
        open: async () => ({ endpoint: 'http://owned.test', headers: {}, close }),
      },
      fixture.backend,
      fixture.audit
    );
    await service.open({ mode: 'embedded' });
    await expect(service.disconnect()).rejects.toMatchObject({
      code: 'busy',
      message: 'Restart DorkOS to finish closing this browser.',
    });
    await expect(service.disconnect()).rejects.toMatchObject({
      code: 'busy',
      message: 'Restart DorkOS to finish closing this browser.',
    });
    await expect(service.open({ mode: 'embedded' })).rejects.toMatchObject({
      code: 'busy',
      message: 'Restart DorkOS to finish closing this browser.',
    });
    expect(close).toHaveBeenCalledOnce();
    expect(fixture.browser.close).toHaveBeenCalledOnce();
  });
  it('bounds the durable start wait and never dispatches after that write eventually finishes', async () => {
    const { service, audit, click } = await lifecycleFixture();
    await service.open({ mode: 'new-window' });
    const observed = await service.observe();
    const started = deferred<void>();
    audit.mockImplementationOnce(() => started.promise);
    vi.useFakeTimers();
    const action = service.action({
      kind: 'click',
      role: 'button',
      name: 'Save',
      revision: observed.revision,
    });
    const refused = expect(action).rejects.toMatchObject({ code: 'audit_unavailable' });
    await vi.advanceTimersByTimeAsync(AUDIT_WRITE_RESPONSE_TIMEOUT_MS);
    await refused;
    expect(click).not.toHaveBeenCalled();
    started.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(click).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledOnce();
    await service.disconnect();
  });

  it('bounds a stalled success receipt and journals unknown after its late success write settles', async () => {
    const { service, audit, click } = await lifecycleFixture();
    await service.open({ mode: 'new-window' });
    const observed = await service.observe();
    const finish = deferred<void>();
    const journal: import('../action-audit.js').LocalBrowserAuditRecord[] = [];
    audit.mockImplementation(async (record) => {
      if (record.phase === 'finished' && record.outcome === 'succeeded') await finish.promise;
      journal.push({ ...record });
    });
    vi.useFakeTimers();
    const action = service.action({
      kind: 'click',
      role: 'button',
      name: 'Save',
      revision: observed.revision,
    });
    const uncertain = expect(action).rejects.toMatchObject({ code: 'uncertain' });
    await vi.advanceTimersByTimeAsync(0);
    expect(click).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(AUDIT_WRITE_RESPONSE_TIMEOUT_MS * 2);
    await uncertain;
    expect(journal.map((record) => record.phase)).toEqual(['started']);
    // The correcting record cannot overtake the writer that is still serializing success.
    expect(audit).toHaveBeenCalledTimes(2);
    finish.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(journal.map((record) => [record.phase, record.outcome])).toEqual([
      ['started', 'unknown'],
      ['finished', 'succeeded'],
      ['finished', 'unknown'],
    ]);
    expect(new Set(journal.map((record) => record.operationId)).size).toBe(1);
    expect(click).toHaveBeenCalledTimes(2);
    await service.disconnect();
  });
});

describe('named profiles (DOR-3218)', () => {
  const profileId = '00000000-0000-4000-8000-000000000001';

  it('opens a named profile in its own folder', async () => {
    const f = await create();
    f.service.useProfileAccess(
      async () => undefined,
      () => true
    );
    await f.service.open({ mode: 'new-window', profileId });
    expect(f.backend.launch).toHaveBeenLastCalledWith(
      path.join(f.dir, 'browser-profiles', profileId),
      expect.anything(),
      expect.anything()
    );
    await f.service.disconnect();
  });

  it.each([
    ['unknown', true],
    ['set up yet', false],
  ])('refuses to open a profile when it is not %s, and makes no folder', async (_name, set) => {
    const f = await create();
    if (set)
      f.service.useProfileAccess(
        async () => undefined,
        () => false
      );
    await expect(f.service.open({ mode: 'new-window', profileId })).rejects.toMatchObject({
      code: 'profile_not_found',
    });
    expect(f.backend.launch).not.toHaveBeenCalled();
    await expect(readFile(path.join(f.dir, 'browser-profiles', profileId))).rejects.toThrow();
  });

  it('asks the access check on each call, and skips it on the default profile', async () => {
    const f = await create();
    const access = vi.fn(async () => undefined);
    f.service.useProfileAccess(access, () => true);
    await f.service.open({ mode: 'new-window', sessionId: 's' });
    await f.service.requireProfileAccess('s');
    expect(access).not.toHaveBeenCalled();
    await f.service.open({ mode: 'new-window', profileId, sessionId: 's' });
    await f.service.requireProfileAccess('s');
    await f.service.requireProfileAccess('s');
    expect(access).toHaveBeenCalledTimes(2);
    expect(access).toHaveBeenLastCalledWith(profileId, 's');
    await f.service.disconnect();
  });

  it('never opens a named profile in the embedded browser', async () => {
    const f = await create();
    f.service.useProfileAccess(
      async () => undefined,
      () => true
    );
    await expect(f.service.open({ mode: 'embedded', profileId })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});

describe('DorkOS app origins (DOR-3218)', () => {
  const refused = { code: 'dorkos_origin' };
  const origins = () => [
    'http://localhost:4242',
    'http://127.0.0.1:4242',
    'http://[::1]:4242',
    'http://0.0.0.0:4242',
    'http://fixture.local:4242',
    'http://192.168.1.20:4242',
    'https://fixture.ngrok.app',
  ];

  it.each(origins())('refuses navigation to %s before dispatch', async (url) => {
    const { service, page } = await create(origins);
    await selectOwned(service);
    const observed = await service.observe();
    await expect(
      service.action({ kind: 'navigate', url, revision: observed.revision })
    ).rejects.toMatchObject(refused);
    expect(page.goto).not.toHaveBeenCalled();
    await service.disconnect();
  });

  it.each(origins())('refuses a redirect to %s and gives the agent nothing', async (url) => {
    const { service, page, context, navigate, change } = await create(origins);
    const cookies = vi.fn(async () => []);
    Object.assign(context, { cookies, storageState: cookies });
    await selectOwned(service);
    const observed = await service.observe();
    vi.mocked(page.evaluateHandle).mockClear();
    vi.mocked(page.goto).mockImplementationOnce(async () => {
      change('- text "PAGE-SECRET"');
      navigate(`${url}/connections?token=URL-SECRET`);
      return null;
    });
    const error = await service
      .action({
        kind: 'navigate',
        url: 'http://fixture.test/redirect',
        revision: observed.revision,
      })
      .catch((caught: unknown) => caught as Error);
    expect(error).toMatchObject(refused);
    expect(JSON.stringify({ message: (error as Error).message })).not.toMatch(/SECRET/);
    expect((await service.state()).paused).toBe(true);
    await expect(service.observe()).rejects.toMatchObject(refused);
    await expect(service.screenshot()).rejects.toMatchObject(refused);
    await expect(service.agentState()).rejects.toMatchObject(refused);
    expect(page.evaluateHandle).not.toHaveBeenCalled();
    expect(page.screenshot).not.toHaveBeenCalled();
    expect(cookies).not.toHaveBeenCalled();
    await service.disconnect();
  });

  it.each(['file:///etc/hosts', 'view-source:http://localhost:4242/'])(
    'refuses an agent navigation to %s before dispatch',
    async (url) => {
      const { service, page } = await create(origins);
      await selectOwned(service);
      const observed = await service.observe();
      await expect(
        service.action({ kind: 'navigate', url, revision: observed.revision })
      ).rejects.toMatchObject({ code: 'unsupported_address' });
      expect(page.goto).not.toHaveBeenCalled();
      await service.disconnect();
    }
  );

  it.each([
    ['view-source:http://localhost:4242/connections', 'dorkos_origin'],
    ['view-source:https://fixture.ngrok.app/', 'dorkos_origin'],
    ['view-source:https://cloud.dorkos.ai/', 'cloud_origin'],
    ['file:///Users/someone/.dork/page.html', 'unsupported_address'],
  ])('never reads a tab already showing %s', async (url, code) => {
    const { service, navigate, page } = await create(origins);
    await selectOwned(service);
    navigate(url);
    vi.mocked(page.evaluateHandle).mockClear();
    await expect(service.observe()).rejects.toMatchObject({ code });
    await expect(service.screenshot()).rejects.toMatchObject({ code });
    expect(page.evaluateHandle).not.toHaveBeenCalled();
    expect(page.screenshot).not.toHaveBeenCalled();
    expect((await service.state()).paused).toBe(true);
    await service.disconnect();
  });

  it.each(['frameattached', 'framedetached', 'framenavigated'])(
    'fails a screenshot when a sub-frame event %s lands during it',
    async (event) => {
      const { service, page, events, pixels } = await create(origins);
      await selectOwned(service);
      vi.mocked(page.screenshot).mockImplementationOnce(async () => {
        events.emit(event, {});
        return Buffer.from(pixels);
      });
      await expect(service.screenshot()).rejects.toMatchObject({ code: 'stale_page' });
      await service.disconnect();
    }
  );

  it('fails an observation when a frame came and went during it', async () => {
    const { service, locator, events } = await create(origins);
    await selectOwned(service);
    locator.ariaSnapshot.mockImplementationOnce(async () => {
      events.emit('frameattached', {});
      events.emit('framedetached', {});
      return '- button "Save"';
    });
    await expect(service.observe()).rejects.toMatchObject({ code: 'stale_page' });
    await service.disconnect();
  });

  it('lets an action through when a frame changes between reading and acting', async () => {
    const { service, click, events } = await create(origins);
    await selectOwned(service);
    const observed = await service.observe();
    events.emit('frameattached', {});
    await service.action({
      kind: 'click',
      role: 'button',
      name: 'Save',
      revision: observed.revision,
    });
    expect(click).toHaveBeenCalled();
    await service.disconnect();
  });

  it('checks live origins rather than the set at connection time', async () => {
    const live: string[] = [];
    const { service, page } = await create(() => live);
    await selectOwned(service);
    const observed = await service.observe();
    live.push('https://new-tunnel.example');
    await expect(
      service.action({
        kind: 'navigate',
        url: 'https://new-tunnel.example/connections',
        revision: observed.revision,
      })
    ).rejects.toMatchObject(refused);
    expect(page.goto).not.toHaveBeenCalled();
    await service.disconnect();
  });

  it('pauses after a click redirects to DorkOS and refuses all later reads', async () => {
    const { service, click, navigate, page } = await create(origins);
    await selectOwned(service);
    const observed = await service.observe();
    click.mockImplementationOnce(async () => {
      navigate('http://localhost:4242/connections');
    });
    await expect(
      service.action({ kind: 'click', role: 'button', name: 'Save', revision: observed.revision })
    ).rejects.toMatchObject(refused);
    expect((await service.state()).paused).toBe(true);
    vi.mocked(page.evaluateHandle).mockClear();
    await expect(service.agentState()).rejects.toMatchObject(refused);
    await expect(service.observe()).rejects.toMatchObject(refused);
    await expect(service.screenshot()).rejects.toMatchObject(refused);
    expect(page.evaluateHandle).not.toHaveBeenCalled();
    expect(page.screenshot).not.toHaveBeenCalled();
    await service.disconnect();
  });

  it('refuses a page framing DorkOS before observing it', async () => {
    const { service, addFrame, page } = await create(origins);
    await selectOwned(service);
    addFrame('https://fixture.ngrok.app/settings');
    await expect(service.observe()).rejects.toMatchObject(refused);
    expect(page.evaluateHandle).not.toHaveBeenCalled();
    await service.disconnect();
  });

  it('refuses acting on DorkOS even with a stale observation', async () => {
    const { service, navigate, click } = await create(origins);
    await selectOwned(service);
    const observed = await service.observe();
    navigate('http://localhost:4242/connections');
    await expect(
      service.action({ kind: 'click', role: 'button', name: 'Save', revision: observed.revision })
    ).rejects.toMatchObject(refused);
    expect(click).not.toHaveBeenCalled();
    await service.disconnect();
  });

  it('keeps an unrelated website on another port usable', async () => {
    const { service, page } = await create(origins);
    await selectOwned(service);
    const observed = await service.observe();
    await service.action({
      kind: 'navigate',
      url: 'http://localhost:9000',
      revision: observed.revision,
    });
    expect(page.goto).toHaveBeenCalled();
    await service.observe();
    await service.disconnect();
  });

  it('rechecks origins after the audit wait, before any page effect', async () => {
    const f = await create();
    const live: string[] = [];
    const service = new LocalBrowserService(
      f.dir,
      undefined,
      f.backend,
      async (record) => {
        if (record.phase === 'started') live.push('http://fixture.test');
      },
      () => ({ platform: 'darwin' }),
      undefined,
      () => live
    );
    await selectOwned(service);
    const observed = await service.observe();
    await expect(
      service.action({ kind: 'click', role: 'button', name: 'Save', revision: observed.revision })
    ).rejects.toMatchObject(refused);
    expect(f.click).not.toHaveBeenCalled();
    expect((await service.state()).paused).toBe(true);
    await service.disconnect();
  });

  it('checks a replacement tab before returning its state to an agent', async () => {
    const { service, context, page } = await create(origins);
    const other = fixture();
    other.navigate('http://localhost:4242/connections');
    vi.spyOn(context, 'pages').mockReturnValue([page, other.page]);
    await service.open({ mode: 'new-window' });
    vi.spyOn(page, 'isClosed').mockReturnValue(true);
    await expect(service.agentState()).rejects.toMatchObject(refused);
    expect((await service.state()).paused).toBe(true);
    await service.disconnect();
  });
});

describe('the Cloud origin (DOR-3196)', () => {
  const refused = { code: 'cloud_origin', message: CLOUD_ORIGIN_REFUSAL };

  it.each([
    'https://cloud.dorkos.ai/',
    'https://cloud.dorkos.ai/any/path',
    'https://x.cloud.dorkos.ai/',
    'https://dorkos.ai/any/path',
  ])('refuses an agent navigation to %s before it is dispatched', async (target) => {
    const { service, page } = await create();
    await selectOwned(service);
    const observed = await service.observe();
    vi.mocked(page.goto).mockClear();
    await expect(
      service.action({ kind: 'navigate', url: target, revision: observed.revision })
    ).rejects.toMatchObject(refused);
    expect(page.goto).not.toHaveBeenCalled();
    await service.disconnect();
  });

  it('pauses and never observes when a click lands on the Cloud origin', async () => {
    const { service, click, navigate, page } = await create();
    await selectOwned(service);
    const observed = await service.observe();
    click.mockImplementationOnce(async () => {
      navigate('https://cloud.dorkos.ai/some/page');
      return undefined;
    });
    await expect(
      service.action({ kind: 'click', role: 'button', name: 'Save', revision: observed.revision })
    ).rejects.toMatchObject(refused);
    expect((await service.state()).paused).toBe(true);
    vi.mocked(page.evaluateHandle).mockClear();
    await expect(service.observe()).rejects.toMatchObject(refused);
    await expect(service.screenshot()).rejects.toMatchObject(refused);
    expect(page.evaluateHandle).not.toHaveBeenCalled();
    expect(page.screenshot).not.toHaveBeenCalled();
    await service.disconnect();
  });

  it('refuses an agent navigation that a redirect carries onto the Cloud origin', async () => {
    const { service, page, navigate } = await create();
    await selectOwned(service);
    const observed = await service.observe();
    vi.mocked(page.goto).mockImplementationOnce(async () => {
      navigate('https://app.cloud.dorkos.ai/');
      return null;
    });
    await expect(
      service.action({
        kind: 'navigate',
        url: 'http://fixture.test/redirect',
        revision: observed.revision,
      })
    ).rejects.toMatchObject(refused);
    expect((await service.state()).paused).toBe(true);
    await service.disconnect();
  });

  it('does not observe a page that frames the Cloud origin', async () => {
    const { service, addFrame, page } = await create();
    await selectOwned(service);
    addFrame('https://cloud.dorkos.ai/frame');
    await expect(service.observe()).rejects.toMatchObject(refused);
    expect(page.evaluateHandle).not.toHaveBeenCalled();
    await service.disconnect();
  });

  it('never describes a Cloud tab to the agent, even one the person opened', async () => {
    const { service, navigate } = await create();
    await selectOwned(service);
    navigate('https://cloud.dorkos.ai/some/page?token=secret');
    await expect(service.agentState()).rejects.toMatchObject(refused);
    expect((await service.state()).paused).toBe(true);
    await service.disconnect();
  });

  it('still lets the person open the Cloud origin themselves', async () => {
    const { service, page } = await create();
    await selectOwned(service);
    await service.navigate('https://cloud.dorkos.ai/');
    expect(page.goto).toHaveBeenLastCalledWith('https://cloud.dorkos.ai/', {
      waitUntil: 'commit',
      timeout: 15_000,
    });
    const opened = await create();
    await opened.service.open({ mode: 'new-window', url: 'https://cloud.dorkos.ai/start' });
    expect(opened.page.goto).toHaveBeenCalledWith('https://cloud.dorkos.ai/start', {
      waitUntil: 'commit',
      timeout: 15_000,
    });
    await service.disconnect();
    await opened.service.disconnect();
  });

  it('leaves other sites alone', async () => {
    const { service, page } = await create();
    await selectOwned(service);
    const observed = await service.observe();
    await service.action({
      kind: 'navigate',
      url: 'https://dorkos.ai.example.com/',
      revision: observed.revision,
    });
    expect(page.goto).toHaveBeenLastCalledWith('https://dorkos.ai.example.com/', {
      waitUntil: 'commit',
      timeout: 750,
    });
    await service.observe();
    await service.disconnect();
  });
});
