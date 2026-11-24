import type { BrowserContext } from 'playwright-core';
import { createTestDb } from '@dorkos/test-utils/db';
import { createLocalBrowserProfileStore } from '../../profile-store.js';
import { describe, expect, it, vi } from 'vitest';
import { CLOSE_RESPONSE_TIMEOUT_MS } from '../../lifecycle.js';
import { AUDIT_WRITE_RESPONSE_TIMEOUT_MS } from '../../page-action.js';
import {
  deferred,
  lifecycleFixture,
  handoffCloseFixture,
  create,
  selectOwned,
  trackedPageSession,
} from './service.fixtures.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

describe('bounded browser lifecycle ownership', () => {
  // Regression pins: joining a close and its 2 s response budget predate DOR-4731's fix.
  it('waits for the pending close before the next handoff starts its sign-in', async () => {
    const { service, context, handover, signIns, close } = await handoffCloseFixture();
    vi.useFakeTimers();
    const disconnecting = service.disconnect();
    const asking = handover.ask('chat-one', 'password');
    await vi.advanceTimersByTimeAsync(CLOSE_RESPONSE_TIMEOUT_MS - 1);
    expect(signIns.current).toBeNull();
    expect(context.close).toHaveBeenCalledOnce();

    close.resolve();
    await disconnecting;
    const { handoffId } = await asking;
    expect((await handover.state()).handoff?.id).toBe(handoffId);
    expect(signIns.current?.status).toBe('open');
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('refuses the next handoff at the unchanged close deadline and retains the profile', async () => {
    const { service, context, handover, signIns, close } = await handoffCloseFixture();
    vi.useFakeTimers();
    const disconnecting = expect(service.disconnect()).rejects.toMatchObject({ code: 'busy' });
    const asking = expect(handover.ask('chat-one', 'password')).rejects.toMatchObject({
      code: 'busy',
    });
    await vi.advanceTimersByTimeAsync(CLOSE_RESPONSE_TIMEOUT_MS);
    await Promise.all([disconnecting, asking]);
    expect(signIns.current).toBeNull();
    expect(context.close).toHaveBeenCalledOnce();
    await expect(service.profileRemoval.forget(null)).rejects.toMatchObject({
      code: 'profile_busy',
    });

    close.resolve();
    await service.disconnect();
    await expect(service.profileRemoval.forget(null)).resolves.toBeUndefined();
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
    // The late continuation finds the browser disconnected, and says so: never a pause a
    // person could lift (DOR-4678).
    const refused = expect(acting).rejects.toMatchObject({ code: 'closed' });
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

  // DOR-4181: once a person closes the window, Forget and Delete work without a Disconnect,
  // but only after the close settles, so Chromium is done with the profile first.
  it('releases a profile the person closed its window on, once that close settles', async () => {
    const { service, context, contextEvents } = await lifecycleFixture();
    const profiles = createLocalBrowserProfileStore(createTestDb(), () => Buffer.alloc(32, 1));
    const { id } = profiles.create('Example work');
    service.useProfileAccess(
      async () => undefined,
      (candidate) => candidate === id
    );
    await service.open({ mode: 'new-window', profileId: id });
    const closing = deferred<void>();
    vi.mocked(context.close).mockReturnValueOnce(closing.promise);
    contextEvents.emit('close');
    await Promise.resolve();
    expect((await service.state()).status).toBe('closed');
    // Chromium may still be flushing cookies until the close request settles.
    await expect(service.profileRemoval.delete(id, profiles)).rejects.toMatchObject({
      code: 'profile_busy',
    });
    closing.resolve();
    await vi.waitFor(async () => {
      await expect(service.profileRemoval.delete(id, profiles)).resolves.toBeUndefined();
    });
    expect(profiles.get(id)).toBeUndefined();
    // The panel still says the browser closed, and offers to reconnect.
    const after = await service.state();
    expect(after.status).toBe('closed');
    expect(after.mode).toBe('new-window');
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

  it('retains a failed embedded close tombstone and reports busy on every repeat', async () => {
    const fixture = await lifecycleFixture();
    const close = vi.fn(async () => {
      throw new Error('private bridge unavailable');
    });
    const service = trackedPageSession(
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
});

// DOR-3897: a click or key press is only sent (`noWaitAfter`), so the load it
// starts is checked before the action reports. A load the browser refused, or a
// tab left on the browser's error page, must never read as success.
describe('a page load an action starts', () => {
  type Fixture = Awaited<ReturnType<typeof create>>;
  const ERROR_PAGE = 'chrome-error://chromewebdata/';

  /** A main-frame page request as Playwright reports it. */
  function navigationRequest(f: Fixture, url: string, errorText?: string) {
    return {
      isNavigationRequest: () => true,
      frame: () => f.page.mainFrame(),
      url: () => url,
      failure: () => (errorText ? { errorText } : null),
    };
  }

  /** The real click (not the trial) starts a load that ends as `outcome` says. */
  function clickLoads(f: Fixture, url: string, outcome: { failed?: string; landsOn?: string }) {
    f.click.mockImplementation(async (options?: { trial?: boolean }) => {
      if (options?.trial) return;
      setTimeout(() => {
        const request = navigationRequest(f, url, outcome.failed);
        f.events.emit('request', request);
        if (outcome.failed) f.events.emit('requestfailed', request);
        f.navigate(outcome.landsOn ?? url);
      }, 10);
    });
  }

  async function journal(f: Fixture): Promise<{ phase: string; outcome: string }[]> {
    const raw = await readFile(path.join(f.dir, 'local-browser', 'actions.jsonl'), 'utf8');
    return raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  }

  it.each([
    [
      'an unknown host',
      'http://made-up-host.invalid/',
      'net::ERR_NAME_NOT_RESOLVED',
      'Can’t find made-up-host.invalid',
    ],
  ])(
    'a click onto %s reports that it didn’t load, in the page’s own title, and is journaled as failed',
    async (_what, url, error, title) => {
      const f = await create();
      await selectOwned(f.service);
      const { revision } = await f.service.observe();
      clickLoads(f, url, { failed: error, landsOn: ERROR_PAGE });
      await expect(
        f.service.action({ kind: 'click', role: 'button', name: 'Save', revision })
      ).rejects.toMatchObject({
        code: 'load_failed',
        message: `${title} (${error.replace('net::', '')}). Read the page again.`,
      });
      expect((await journal(f)).map((record) => record.outcome)).toEqual(['unknown', 'failed']);
      await f.service.disconnect();
    }
  );

  it.each(['navigate', 'click'] as const)(
    'reports a committed %s as successful when its old execution context is destroyed (DOR-4817)',
    async (kind) => {
      const f = await create();
      await selectOwned(f.service);
      const { revision } = await f.service.observe();
      const target = 'http://fixture.test/committed';
      const commit = async () => {
        f.events.emit('request', navigationRequest(f, target));
        f.navigate(target);
        throw new Error('Execution context was destroyed, most likely because of a navigation');
      };
      if (kind === 'navigate') vi.mocked(f.page.goto).mockImplementationOnce(commit);
      else
        f.click.mockImplementation(async (options?: { trial?: boolean }) => {
          if (!options?.trial) await commit();
        });
      const state = await f.service.action(
        kind === 'navigate'
          ? { kind, url: target, revision }
          : { kind, role: 'button', name: 'Save', revision }
      );
      expect(state.tabs.find((tab) => tab.id === state.selectedTabId)?.url).toBe(target);
      expect((await journal(f)).map((record) => record.outcome)).toEqual(['unknown', 'succeeded']);
      await expect(
        f.service.action({ kind: 'click', role: 'button', name: 'Save', revision })
      ).rejects.toMatchObject({ code: 'stale_page' });
      if (kind === 'navigate') expect(f.page.goto).toHaveBeenCalledTimes(1);
      else expect(f.click).toHaveBeenCalledTimes(2);
      await f.service.disconnect();
    }
  );

  // Security's checks: the refusal carries only the requested host and Chromium's
  // fixed code. A path or query can hold a token, and the error text, the page
  // and the response are the page's own words.
  it('names only the host and the fixed code, never the path, query or any page text', async () => {
    const f = await create();
    await selectOwned(f.service);
    const { revision } = await f.service.observe();
    vi.spyOn(f.page, 'title').mockResolvedValue('made-up page secret');
    clickLoads(f, 'https://made-up.example:8443/reset?token=made-up-token#frag', {
      failed: 'net::ERR_CONNECTION_REFUSED <b>made-up injected text</b>',
      landsOn: ERROR_PAGE,
    });
    const refusal = f.service.action({ kind: 'click', role: 'button', name: 'Save', revision });
    await expect(refusal).rejects.toMatchObject({
      code: 'load_failed',
      message: 'made-up.example:8443 didn’t respond (ERR_CONNECTION_REFUSED). Read the page again.',
    });
    const message = await refusal.catch((error: Error) => error.message);
    for (const leak of ['token', '/reset', 'frag', 'injected', 'secret', '<b>'])
      expect(message, leak).not.toContain(leak);
  });

  it('journals a failed action with the same minimal fields as any other', async () => {
    const f = await create();
    await selectOwned(f.service);
    const { revision } = await f.service.observe();
    clickLoads(f, 'https://made-up.example/reset?token=made-up-token', {
      failed: 'net::ERR_NAME_NOT_RESOLVED',
      landsOn: ERROR_PAGE,
    });
    await f.service
      .action({ kind: 'click', role: 'button', name: 'Save', revision })
      .catch(() => undefined);
    const raw = await readFile(path.join(f.dir, 'local-browser', 'actions.jsonl'), 'utf8');
    for (const leak of ['made-up.example', 'token', 'reset', 'ERR_', 'chrome-error'])
      expect(raw, leak).not.toContain(leak);
    const [started, finished] = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(finished?.outcome).toBe('failed');
    expect(Object.keys(finished ?? {}).sort()).toEqual(Object.keys(started ?? {}).sort());
    expect(finished?.origin).toBe('http://fixture.test');
  });

  it('after a refused load, the agent’s last read no longer counts and the tab isn’t the page it asked for', async () => {
    const f = await create();
    await selectOwned(f.service);
    const { revision } = await f.service.observe();
    vi.mocked(f.page.goto).mockRejectedValueOnce(
      new Error('page.goto: net::ERR_CONNECTION_REFUSED at http://made-up.example/')
    );
    await expect(
      f.service.action({ kind: 'navigate', url: 'http://made-up.example/', revision })
    ).rejects.toMatchObject({ code: 'load_failed' });
    // The read from before is spent: acting on it again is refused, not replayed.
    await expect(
      f.service.action({ kind: 'click', role: 'button', name: 'Save', revision })
    ).rejects.toMatchObject({ code: 'stale_page' });
    const state = await f.service.state();
    const selected = state.tabs.find((tab) => tab.id === state.selectedTabId);
    expect(selected?.url).not.toBe('http://made-up.example/');
    await f.service.disconnect();
  });
});
