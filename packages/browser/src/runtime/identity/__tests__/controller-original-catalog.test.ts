import { expect, it, vi } from 'vitest';
import type { ConnectOverCDPTransport } from 'playwright-core';
import { readControllerOriginalCatalog } from '../controller-original-catalog.js';

const page = {
  targetId: 'original-page',
  type: 'page',
  url: 'about:blank',
  browserContextId: 'original-default',
};
const worker = {
  targetId: 'original-worker',
  type: 'service_worker',
  url: 'http://127.0.0.1/app',
  browserContextId: 'original-default',
};
function original(
  contexts: unknown = { browserContextIds: [], defaultBrowserContextId: 'original-default' },
  targets: unknown = [page, worker]
) {
  const commands: unknown[] = [];
  const transport: ConnectOverCDPTransport = {
    open() {},
    close() {},
    send(value) {
      const command = value as { id: number; method: string };
      commands.push(value);
      transport.onmessage?.({
        id: command.id,
        result:
          command.method === 'Target.getBrowserContexts' ? contexts : { targetInfos: targets },
      });
    },
  };
  return { transport, commands };
}
it('retains authoritative nonempty default context and both actual post-supervisor targets', async () => {
  const { transport, commands } = original();
  const catalog = await readControllerOriginalCatalog(transport);
  expect(catalog).toEqual({
    context: 'original-default',
    targets: [
      { id: 'original-page', type: 'page', context: 'original-default' },
      { id: 'original-worker', type: 'service_worker', context: 'original-default' },
    ],
  });
  expect(Object.isFrozen(catalog)).toBe(true);
  expect(Object.isFrozen(catalog.targets)).toBe(true);
  expect(catalog.targets.every(Object.isFrozen)).toBe(true);
  expect(commands).toEqual([
    { id: 1, method: 'Target.getBrowserContexts', params: {} },
    { id: 2, method: 'Target.getTargets', params: {} },
  ]);
  expect(transport.onmessage).toBeUndefined();
  expect(transport.onclose).toBeUndefined();
});
it.each([
  { browserContextIds: [] },
  { browserContextIds: [], defaultBrowserContextId: '' },
  { browserContextIds: ['incognito'], defaultBrowserContextId: 'original-default' },
])('refuses missing default provenance or original nondefault contexts (%j)', async (contexts) => {
  const { transport, commands } = original(contexts);
  await expect(readControllerOriginalCatalog(transport)).rejects.toThrow('CONTROLLER_CATALOG');
  expect(commands).toHaveLength(1);
  expect(transport.onmessage).toBeUndefined();
});
it.each([
  { targets: [page, page] },
  { targets: [page, { ...worker, browserContextId: 'foreign' }] },
  { targets: [page, { ...worker, targetId: '' }] },
  { targets: [page, null] },
])('refuses duplicate, malformed or foreign original targets (%j)', async ({ targets }) => {
  const { transport } = original(undefined, targets);
  await expect(readControllerOriginalCatalog(transport)).rejects.toThrow('CONTROLLER_CATALOG');
  expect(transport.onmessage).toBeUndefined();
  expect(transport.onclose).toBeUndefined();
});
it.each([false, undefined])(
  'retains exact original reply error %s and releases receiver ownership',
  async (value) => {
    const { transport } = original();
    transport.send = (command) =>
      transport.onmessage?.({ id: (command as { id: number }).id, error: value });
    await expect(readControllerOriginalCatalog(transport)).rejects.toBe(value);
    expect(transport.onmessage).toBeUndefined();
    expect(transport.onclose).toBeUndefined();
  }
);
it('joins original bounded timeout and removes its receiver after a missing original reply', async () => {
  vi.useFakeTimers();
  const { transport } = original();
  transport.send = () => {};
  const pending = readControllerOriginalCatalog(transport);
  const returned = pending.then(
    () => ({ failed: false }),
    (value: unknown) => ({ failed: true, value })
  );
  try {
    await vi.advanceTimersByTimeAsync(5000);
    const result = await returned;
    expect(result.failed).toBe(true);
    expect('value' in result && result.value).toEqual(
      new Error('CONTROLLER_CATALOG_ACK_UNOBSERVED')
    );
    expect(transport.onmessage).toBeUndefined();
    expect(transport.onclose).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await vi.runAllTimersAsync();
    await returned;
    vi.useRealTimers();
  }
});

it('retains an empty original snapshot without inventing a default target', async () => {
  const { transport } = original(undefined, []);
  await expect(readControllerOriginalCatalog(transport)).resolves.toEqual({
    context: 'original-default',
    targets: [],
  });
});
