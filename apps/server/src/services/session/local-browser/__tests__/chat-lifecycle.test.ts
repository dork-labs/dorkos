import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalBrowserService } from '../service.js';
import { chatPagesFixture } from './chat-pages-fixture.js';

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'chat-pages-'));
  directories.push(dir);
  const fake = chatPagesFixture();
  const service = new LocalBrowserService(dir, undefined, fake.backend, undefined, () => ({
    platform: 'darwin',
  }));
  return { ...fake, service, dir };
}

it('opens two chats in one context, keeping their page reads and revisions separate', async () => {
  const f = await fixture();
  await f.service.open({ mode: 'new-window', sessionId: 'atlas', url: 'https://atlas.example/' });
  await f.service.open({ mode: 'new-window', sessionId: 'nova', url: 'https://nova.example/' });
  expect(f.backend.launch).toHaveBeenCalledTimes(1);
  const atlas = f.service.leaseFor('atlas');
  const nova = f.service.leaseFor('nova');
  const a = await atlas.observe();
  const n = await nova.observe();
  expect(a.url).toBe('https://atlas.example/');
  expect(n.url).toBe('https://nova.example/');
  expect(a.tabId).not.toBe(n.tabId);
  await nova.pause();
  expect((await atlas.agentState()).paused).toBe(false);
  expect((await nova.agentState()).paused).toBe(true);
  expect((await atlas.agentState()).revision).toBe(a.revision);
  await f.service.disconnect();
});

it('closing one tab ends only that lease; closing the context ends both', async () => {
  const f = await fixture();
  await f.service.open({ mode: 'new-window', sessionId: 'atlas' });
  await f.service.open({ mode: 'new-window', sessionId: 'nova' });
  await f.pages[0].value.close();
  expect(() => f.service.leaseFor('atlas')).toThrow(expect.objectContaining({ code: 'tab_gone' }));
  await expect(f.service.leaseFor('nova').agentState()).resolves.toMatchObject({
    status: 'connected',
  });
  f.contextEvents.emit('close');
  expect(() => f.service.leaseFor('nova')).toThrow(expect.objectContaining({ code: 'busy' }));
  await f.service.disconnect();
  expect(() => f.service.leaseFor('nova')).toThrow(expect.objectContaining({ code: 'tab_gone' }));
});

it('a protected origin pauses only the affected chat', async () => {
  const f = await fixture();
  await f.service.open({ mode: 'new-window', sessionId: 'atlas', url: 'https://atlas.example/' });
  await f.service.open({ mode: 'new-window', sessionId: 'nova', url: 'https://nova.example/' });
  f.pages[0].navigate('https://cloud.dorkos.ai/private?token=made-up');
  await expect(f.service.leaseFor('atlas').observe()).rejects.toMatchObject({
    code: 'cloud_origin',
  });
  await expect(f.service.leaseFor('nova').observe()).resolves.toMatchObject({
    url: 'https://nova.example/',
  });
  expect((await f.service.state('atlas')).paused).toBe(true);
  expect((await f.service.state('nova')).paused).toBe(false);
  await f.service.disconnect();
});

it('lets one chat act while another page action is still in flight', async () => {
  const f = await fixture();
  await f.service.open({ mode: 'new-window', sessionId: 'atlas' });
  await f.service.open({ mode: 'new-window', sessionId: 'nova' });
  let finish!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.mocked(f.pages[0].value.goto).mockImplementationOnce(async () => {
    started();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return null;
  });
  const action = f.service
    .leaseFor('atlas')
    .action({ kind: 'navigate', url: 'https://atlas.example/', revision: 0 });
  await ready;
  await expect(
    f.service
      .leaseFor('nova')
      .action({ kind: 'navigate', url: 'https://nova.example/', revision: 0 })
  ).resolves.toMatchObject({ sessionId: 'nova' });
  finish();
  await action;
  await f.service.disconnect();
});

it('returns a restarted chat to its own existing page', async () => {
  const f = await fixture();
  const first = await f.service.open({
    mode: 'new-window',
    sessionId: 'atlas',
    url: 'https://atlas.example/',
  });
  await f.service.open({ mode: 'new-window', sessionId: 'nova' });
  const returned = await f.service.open({ mode: 'new-window', sessionId: 'atlas' });
  expect(returned.selectedTabId).toBe(first.selectedTabId);
  expect(f.backend.launch).toHaveBeenCalledTimes(1);
  expect(f.context.newPage).toHaveBeenCalledTimes(2);
  await f.service.disconnect();
});

it('scoped Disconnect closes only that chat’s pages and preserves the other lease', async () => {
  const f = await fixture();
  await f.service.open({ mode: 'new-window', sessionId: 'atlas' });
  await f.service.open({ mode: 'new-window', sessionId: 'nova' });
  await f.service.disconnect('atlas');
  expect(f.pages[0].value.close).toHaveBeenCalledTimes(1);
  expect(f.pages[1].value.close).not.toHaveBeenCalled();
  expect(f.context.close).not.toHaveBeenCalled();
  await expect(f.service.leaseFor('nova').agentState()).resolves.toMatchObject({
    sessionId: 'nova',
  });
  await f.service.disconnect();
});

it('cancels a pending chat grant without closing another chat’s window', async () => {
  const f = await fixture();
  await f.service.open({ mode: 'new-window', sessionId: 'atlas' });
  let finish!: (value: string) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.service.useAgentIdentityLookup(async () => {
    started();
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  });
  const opening = f.service.open({ mode: 'new-window', sessionId: 'nova' });
  const rejected = expect(opening).rejects.toMatchObject({ code: 'cancelled' });
  await ready;
  await f.service.disconnect('nova');
  finish('agent-nova');
  await rejected;
  expect(f.pages[1].value.close).toHaveBeenCalledOnce();
  expect(() => f.service.leaseFor('nova')).toThrow();
  await expect(f.service.leaseFor('atlas').agentState()).resolves.toMatchObject({
    sessionId: 'atlas',
  });
  expect(f.context.close).not.toHaveBeenCalled();
  await f.service.disconnect();
});

it('never changes a profile beneath another chat’s active handoff', async () => {
  const f = await fixture();
  f.service.useProfileAccess(
    async () => undefined,
    () => true
  );
  f.service.handover.useOutsideTurnCheck(async () => false);
  await f.service.open({ mode: 'new-window', sessionId: 'atlas', url: 'https://atlas.example/' });
  const handoff = await f.service.handover.ask('atlas', 'wall', null);
  await expect(
    f.service.handover.open({
      mode: 'new-window',
      sessionId: 'nova',
      profileId: '00000000-0000-4000-8000-000000000001',
    })
  ).rejects.toMatchObject({ code: 'handoff_open' });
  expect(f.context.close).not.toHaveBeenCalled();
  expect(f.backend.launch).toHaveBeenCalledTimes(1);
  await f.service.handover.open({ mode: 'new-window', sessionId: 'nova' });
  await expect(f.service.leaseFor('nova').agentState()).resolves.toMatchObject({
    sessionId: 'nova',
  });
  await f.service.handover.handBack(handoff.handoffId);
  await f.service.disconnect();
});

it('idle expiry leaves a handed-off page unowned while another chat remains active', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  const f = await fixture();
  f.service.handover.useOutsideTurnCheck(async () => false);
  await f.service.open({ mode: 'new-window', sessionId: 'atlas', url: 'https://atlas.example/' });
  await f.service.open({ mode: 'new-window', sessionId: 'nova', url: 'https://nova.example/' });
  const handoff = await f.service.handover.ask('atlas', 'wall', null);
  await vi.advanceTimersByTimeAsync(29 * 60_000);
  await f.service.leaseFor('nova').agentState();
  await vi.advanceTimersByTimeAsync(2 * 60_000);
  await expect(f.service.leaseFor('atlas').observe()).rejects.toMatchObject({ code: 'tab_locked' });
  await expect(f.service.leaseFor('nova').agentState()).resolves.toMatchObject({
    sessionId: 'nova',
  });
  expect(f.pages[0].value.close).not.toHaveBeenCalled();
  await f.service.handover.handBack(handoff.handoffId);
  await expect(f.service.leaseFor('atlas').observe()).resolves.toMatchObject({
    url: 'https://atlas.example/',
  });
  await f.service.disconnect();
});

it('cancels a chat while its initial navigation is finishing without reopening the closed tab', async () => {
  const f = await fixture();
  await f.service.open({ mode: 'new-window', sessionId: 'atlas' });
  const page = f.makePage();
  vi.mocked(f.context.newPage).mockResolvedValueOnce(page.value);
  let finish!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.mocked(page.value.goto).mockImplementationOnce(async () => {
    started();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return null;
  });
  const opening = f.service.open({
    mode: 'new-window',
    sessionId: 'nova',
    url: 'https://nova.example/',
  });
  const rejected = expect(opening).rejects.toMatchObject({ code: 'cancelled' });
  await ready;
  await f.service.disconnect('nova');
  finish();
  await rejected;
  await expect(f.service.leaseFor('atlas').agentState()).resolves.toMatchObject({
    sessionId: 'atlas',
  });
  expect(f.context.close).not.toHaveBeenCalled();
  await f.service.disconnect();
});
