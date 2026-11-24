import type { BrowserContext } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MAX_BROWSER_SNAPSHOT_BYTES } from '../../observation-limits.js';
import { fixture, trackedPageSession, create, selectOwned } from './service.fixtures.js';

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
    const service = trackedPageSession(f.dir, undefined, f.backend, undefined, () => ({
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
    const noAudit = trackedPageSession(
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
});

describe('local browser ownership and observations', () => {
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
  // DOR-3207: an agent may press pause (the route skips the person check), so
  // pause must only take access away. It moves nothing, closes nothing, and
  // stays on until a person resumes.
  it('pause is stop-only: the page, tab and window are untouched, and the agent stays out', async () => {
    const { service, page, context, browser, click } = await create();
    await selectOwned(service);
    const before = await service.state();
    const { revision } = await service.observe();
    vi.mocked(page.goto).mockClear();
    vi.mocked(page.bringToFront).mockClear();
    vi.mocked(context.newPage).mockClear();

    const paused = await service.pause();

    expect(paused.paused).toBe(true);
    expect(paused.selectedTabId).toBe(before.selectedTabId);
    expect(paused.tabs).toEqual(before.tabs);
    expect(page.goto).not.toHaveBeenCalled();
    expect(page.bringToFront).not.toHaveBeenCalled();
    expect(context.newPage).not.toHaveBeenCalled();
    expect(context.close).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
    await expect(
      service.action({ kind: 'click', role: 'button', name: 'Save', revision })
    ).rejects.toMatchObject({ code: 'paused' });
    expect(click).not.toHaveBeenCalled();
    // A second press is still only a stop, and does not lift the first.
    expect((await service.pause()).paused).toBe(true);
    await service.disconnect();
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

  it('captures one selected page and fences its handle after disconnect', async () => {
    const { service } = await create();
    const state = await service.open({ mode: 'new-window', sessionId: 'chat-one' });
    const lease = service.captureAgentLease();
    expect((await lease.agentState()).selectedTabId).toBe(state.tabs[0].id);
    expect((await lease.agentState()).tabs).toHaveLength(1);
    await service.disconnect();
    expect(() => lease.assertCurrent()).toThrow();
  });

  // DOR-4693: an own-window Chrome left open would hold the profile out of sight, so the plain
  // sign-in window could never start. Switching to embedded closes it first.
  it('closes the own window when the person switches to embedded', async () => {
    const f = await create();
    const embedded = {
      open: vi.fn(async () => ({
        endpoint: 'ws://127.0.0.1:41111/page/fixture',
        headers: { Authorization: 'Bearer fixture' },
        close: vi.fn(async () => undefined),
      })),
    };
    // The host is stood in, as for every own-window test: CI's Linux runners have no display.
    const service = trackedPageSession(f.dir, embedded, f.backend, undefined, () => ({
      platform: 'darwin',
    }));
    await service.open({ mode: 'new-window', sessionId: 'chat-one' });
    expect(f.context.close).not.toHaveBeenCalled();
    await service.open({ mode: 'embedded' });
    expect(f.context.close).toHaveBeenCalledOnce();
    expect((await service.state()).mode).toBe('embedded');
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
    const service = trackedPageSession(f.dir, embedded, f.backend);
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
    const { service, backend, context, dir } = await create(undefined, true);
    await service.open({ mode: 'new-window' });
    await service.disconnect();
    await service.open({ mode: 'new-window' });
    expect(backend.launch).toHaveBeenNthCalledWith(
      1,
      path.join(dir, 'browser-profiles', 'default'),
      expect.any(AbortSignal),
      expect.any(Function),
      null,
      expect.any(Function)
    );
    expect(backend.launch).toHaveBeenNthCalledWith(
      2,
      path.join(dir, 'browser-profiles', 'default'),
      expect.any(AbortSignal),
      expect.any(Function),
      null,
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
