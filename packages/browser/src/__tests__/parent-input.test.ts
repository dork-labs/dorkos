import { fakeJPEG } from './parent-fixture.js';
import { it, expect, vi, afterEach } from 'vitest';
import type { CDPSession } from 'playwright-core';
import { composeInput } from '../lifecycle/input-owner.js';
import { submitInput, resetInput } from '../lifecycle/parent-actions.js';
import { closeRecord } from '../lifecycle/close.js';
import { parseBrowserBinding, parseBrowserCommand } from '../contracts.js';
import { captureTab } from '../tabs/capture.js';
import { configuration, tabFixture, deferred, tick } from './parent-fixture.js';
vi.mock('../profiles/owned-directory.js', () => ({ assertDirectory: vi.fn() }));
afterEach(() => vi.useRealTimers());

it('unready popup refuses immediately and late session stays owned after retirement', async () => {
  const h = tabFixture(),
    c = configuration(),
    session = deferred<CDPSession>();
  h.context.newCDPSession.mockImplementation(() => session.promise);
  const slot = composeInput(c, h.record, h.tab);
  expect((await submitInput(h.record, h.command())).outcome).toBe('rejected');
  expect(h.effects).toEqual([]);
  const closing = closeRecord(c, h.record);
  session.resolve(h.session as unknown as CDPSession);
  await slot.readiness?.catch(() => {});
  await closing;
  expect(h.effects).toEqual(['detach']);
  expect(h.context.newCDPSession).toHaveBeenCalledTimes(1);
  expect((await submitInput(h.record, h.command())).outcome).toBe('rejected');
});
it('stale capture cannot publish after reset counter publication before its ACK', async () => {
  const h = tabFixture(),
    c = configuration();
  await composeInput(c, h.record, h.tab).readiness;
  const held = deferred<Uint8Array>();
  h.raw.screenshot.mockImplementation(() => held.promise);
  const old = { ...h.tab.binding };
  const capture = captureTab(c, h.record, {
    kind: 'capture',
    requestId: h.command().requestId,
    binding: old,
  });
  const refusal = expect(capture).rejects.toMatchObject({ code: 'STALE_BINDING' });
  await tick();
  const reset = resetInput(h.record, old);
  held.resolve(fakeJPEG(100, 80));
  await refusal;
  await reset;
  await closeRecord(c, h.record);
});
it('strict seven-field reset binding rejects extras and canonical replacement blocks input', async () => {
  const h = tabFixture(),
    c = configuration();
  await composeInput(c, h.record, h.tab).readiness;
  expect(() => parseBrowserBinding({ ...h.tab.binding, page: h.page })).toThrow('INVALID_COMMAND');
  expect(() => parseBrowserCommand({ ...h.command(), rawProtocol: 'Input.arbitrary' })).toThrow(
    'INVALID_COMMAND'
  );
  const old = { ...h.tab.binding };
  h.record.tabs.set(h.tab.binding.tabId, { ...h.tab });
  expect((await submitInput(h.record, h.command(old))).outcome).toBe('rejected');
  expect(h.effects).toEqual([]);
  await closeRecord(c, h.record);
});
it('parent main-frame retirement fences ordinary admission before child callback and refuses changed-target releases', async () => {
  const h = tabFixture(),
    c = configuration();
  await composeInput(c, h.record, h.tab).readiness;
  h.event('framenavigated');
  expect(h.record.closePromise).toBeDefined();
  expect(h.record.lifetime.ordinary.phase).toBe('retiring');
  expect((await submitInput(h.record, h.command())).outcome).toBe('rejected');
  await h.record.closePromise;
  expect(h.record.lifetime.gate.stopped).toBe(true);
  expect(h.effects).toEqual(['detach']);
  expect(h.session.send).not.toHaveBeenCalled();
});

it.each(['getter', 'invoke'] as const)(
  'capture viewport %s canonical replacement cannot publish or advance sequence',
  async (point) => {
    const h = tabFixture();
    const binding = { ...h.tab.binding };
    const replace = () => h.record.tabs.set(binding.tabId, { ...h.tab });
    const viewport = vi.fn(() => {
      if (point === 'invoke') replace();
      return { width: 100, height: 80 };
    });
    Object.defineProperty(h.raw, 'viewportSize', {
      get: () => {
        if (point === 'getter') replace();
        return viewport;
      },
    });
    await expect(
      captureTab(configuration(), h.record, {
        kind: 'capture',
        requestId: h.command().requestId,
        binding,
      })
    ).rejects.toMatchObject({ code: 'STALE_BINDING' });
    expect(viewport).toHaveBeenCalledTimes(point === 'getter' ? 0 : 1);
    expect(h.tab.captureSequence).toBe(0);
  }
);
