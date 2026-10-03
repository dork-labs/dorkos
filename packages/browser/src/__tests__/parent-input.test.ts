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

it('owns one ready canonical composition and reaches its actual mock text dispatch', async () => {
  const h = tabFixture(),
    c = configuration();
  const slot = composeInput(c, h.record, h.tab);
  await slot.readiness;
  expect(composeInput(c, h.record, h.tab)).toBe(slot);
  expect((await submitInput(h.record, h.command())).outcome).toBe('completed');
  expect(h.effects).toEqual(['text']);
  expect(await closeRecord(c, h.record)).toEqual({ cleanup: 'observed' });
  expect(h.effects).toEqual(['text', 'detach']);
});
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
it('reset publishes counters before held old native drain and refuses its stale settlement', async () => {
  const h = tabFixture(),
    c = configuration();
  const slot = composeInput(c, h.record, h.tab);
  await slot.readiness;
  const held = deferred<void>();
  h.raw.keyboard.insertText.mockImplementation(() => held.promise);
  const old = { ...h.tab.binding };
  const action = submitInput(h.record, h.command(old));
  await tick();
  expect(h.raw.keyboard.insertText).toHaveBeenCalledTimes(1);
  const reset = resetInput(h.record, old);
  expect(h.tab.binding.epoch, 'RESET_COUNTER_NOT_PUBLISHED_BEFORE_DRAIN').toBe(1);
  expect(h.tab.binding.inputGeneration).toBe(1);
  expect((await submitInput(h.record, h.command(old))).outcome).toBe('rejected');
  expect((await submitInput(h.record, h.command())).outcome).toBe('rejected');
  expect(resetInput(h.record, { ...h.tab.binding })).toBe(reset);
  held.resolve();
  expect((await action).outcome).not.toBe('completed');
  expect(await reset).toMatchObject({ status: 'stopped' });
  expect((await submitInput(h.record, h.command())).outcome).toBe('rejected');
  expect(h.record.lifetime.inputs.get(h.tab)).toBe(slot);
  await closeRecord(c, h.record);
});
it('idle reset awaits exact fixed cancellation ACK then uses the new complete canonical binding', async () => {
  const h = tabFixture(),
    c = configuration();
  const slot = composeInput(c, h.record, h.tab);
  await slot.readiness;
  expect((await submitInput(h.record, h.command())).outcome).toBe('completed');
  const old = { ...h.tab.binding },
    ack = deferred<void>();
  h.session.send.mockImplementation(() => ack.promise);
  const reset = resetInput(h.record, old);
  await tick();
  expect(h.tab.binding).toEqual({ ...old, epoch: 1, inputGeneration: 1 });
  expect((await submitInput(h.record, h.command(old))).outcome).toBe('rejected');
  expect((await submitInput(h.record, h.command())).outcome).toBe('rejected');
  expect(h.session.send.mock.calls).toEqual([
    ['Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }],
    ['Input.cancelDragging'],
  ]);
  expect(resetInput(h.record, { ...h.tab.binding })).toBe(reset);
  ack.resolve();
  expect(await reset).toEqual({ status: 'ready', binding: h.tab.binding });
  expect(h.record.lifetime.inputs.get(h.tab)).toBe(slot);
  expect(h.context.newCDPSession).toHaveBeenCalledTimes(1);
  expect((await submitInput(h.record, h.command())).outcome).toBe('completed');
  expect((await submitInput(h.record, h.command(old))).outcome).toBe('rejected');
  expect(h.raw.keyboard.insertText).toHaveBeenCalledTimes(2);
  expect(h.session.detach).not.toHaveBeenCalled();
  expect(await closeRecord(c, h.record)).toEqual({ cleanup: 'observed' });
  expect(h.session.detach).toHaveBeenCalledTimes(1);
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
it('parent main-frame retirement enters terminal cleanup before child callback; never reset native releases', async () => {
  const h = tabFixture(),
    c = configuration();
  h.record.lifetime.retire = () => {
    void closeRecord(c, h.record);
  };
  await composeInput(c, h.record, h.tab).readiness;
  h.event('framenavigated');
  expect(h.record.closePromise).toBeDefined();
  expect(h.record.lifetime.gate.stopped).toBe(true);
  await h.record.closePromise;
  expect(h.effects).toEqual(['detach']);
  expect(h.session.send).not.toHaveBeenCalled();
});
it('failed reset retires browser and preserves its advanced counters', async () => {
  const h = tabFixture(),
    c = configuration();
  h.record.lifetime.retire = () => {
    void closeRecord(c, h.record);
  };
  await composeInput(c, h.record, h.tab).readiness;
  h.session.send.mockRejectedValue(Error('PRIVATE_FAULT'));
  expect(await resetInput(h.record, { ...h.tab.binding })).toMatchObject({ status: 'stopped' });
  expect(h.tab.binding.epoch).toBe(1);
  expect(h.record.lifetime.gate.stopped).toBe(true);
  await h.record.closePromise;
  expect((await submitInput(h.record, h.command())).outcome).toBe('rejected');
});

it.each(['getter', 'invoke'] as const)(
  'capture viewport %s retirement refuses its next effect and sequence',
  async (point) => {
    const h = tabFixture();
    const c = configuration();
    const binding = { ...h.tab.binding };
    const viewport = vi.fn(function (this: unknown) {
      expect(this).toBe(h.page);
      if (point === 'invoke') h.record.lifetime.gate.stop();
      return { width: 100, height: 80 };
    });
    const getter = vi.fn(() => {
      if (point === 'getter') h.record.lifetime.gate.stop();
      return viewport;
    });
    Object.defineProperty(h.raw, 'viewportSize', { get: getter });
    await expect(
      captureTab(c, h.record, { kind: 'capture', requestId: h.command().requestId, binding })
    ).rejects.toMatchObject({ code: 'STALE_BINDING' });
    expect(h.raw.screenshot).toHaveBeenCalledTimes(1);
    expect(getter).toHaveBeenCalledTimes(1);
    expect(viewport).toHaveBeenCalledTimes(point === 'getter' ? 0 : 1);
    expect(h.tab.captureSequence).toBe(0);
    expect(h.tab.pending).toBe(0);
    await closeRecord(c, h.record);
  }
);
it('stable viewport capture observes its method once with the exact Page receiver', async () => {
  const h = tabFixture();
  const viewport = vi.fn(function (this: unknown) {
    expect(this).toBe(h.page);
    return { width: 100, height: 80 };
  });
  const getter = vi.fn(() => viewport);
  Object.defineProperty(h.raw, 'viewportSize', { get: getter });
  const frame = await captureTab(configuration(), h.record, {
    kind: 'capture',
    requestId: h.command().requestId,
    binding: { ...h.tab.binding },
  });
  expect(getter).toHaveBeenCalledTimes(1);
  expect(viewport).toHaveBeenCalledTimes(1);
  expect(frame.receipt).toMatchObject({ width: 100, height: 80, captureSequence: 1 });
  expect(frame.bytes).toEqual(fakeJPEG(100, 80));
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

it.each(['width', 'height'] as const)(
  'capture viewport %s accessor retirement refuses sequence publication',
  async (field) => {
    const h = tabFixture();
    const dimensions = { width: 100, height: 80 };
    const getter = vi.fn(() => {
      h.record.lifetime.gate.stop();
      return field === 'width' ? 100 : 80;
    });
    Object.defineProperty(dimensions, field, { get: getter });
    h.raw.viewportSize = vi.fn(() => dimensions);
    await expect(
      captureTab(configuration(), h.record, {
        kind: 'capture',
        requestId: h.command().requestId,
        binding: { ...h.tab.binding },
      })
    ).rejects.toMatchObject({ code: 'STALE_BINDING' });
    expect(getter).toHaveBeenCalledTimes(1);
    expect(h.tab.captureSequence).toBe(0);
    expect(h.tab.pending).toBe(0);
  }
);

it.each(['stable', 'getter', 'invoke', 'reject'] as const)(
  'capture counter exhaustion preserves its terminal cause through %s Page cleanup',
  async (fault) => {
    const h = tabFixture();
    h.tab.captureSequence = Number.MAX_SAFE_INTEGER;
    const close = vi.fn(function (this: unknown) {
      expect(this).toBe(h.page);
      if (fault === 'invoke') throw Error('COUNTER_CLOSE_INVOKE');
      return fault === 'reject' ? Promise.reject(Error('COUNTER_CLOSE_REJECT')) : Promise.resolve();
    });
    const getter = vi.fn(() => {
      if (fault === 'getter') throw Error('COUNTER_CLOSE_GETTER');
      return close;
    });
    Object.defineProperty(h.raw, 'close', { get: getter });
    await expect(
      captureTab(configuration(), h.record, {
        kind: 'capture',
        requestId: h.command().requestId,
        binding: { ...h.tab.binding },
      })
    ).rejects.toMatchObject({ code: 'COUNTER_EXHAUSTED' });
    expect(getter).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(fault === 'getter' ? 0 : 1);
    expect(h.tab.stopped).toBe(true);
    expect(h.tab.captureSequence).toBe(Number.MAX_SAFE_INTEGER);
    expect(h.tab.pending).toBe(0);
    await tick();
  }
);
