import { tabFixture } from './parent-fixture.js';
import { it, expect, vi } from 'vitest';
import { createBrowserEngine } from '../index.js';
import { acquireBrowser } from '../lifecycle/acquisition.js';
import { parseTabId } from '../ids.js';
import { configuration, requestId, root } from './parent-fixture.js';
vi.mock('../lifecycle/acquisition.js', () => ({ acquireBrowser: vi.fn() }));
vi.mock('../runtime/host-identity.js', () => ({ hostIdentity: () => root }));

it('does not publish an acquisition if shutdown starts in the final await continuation gap', async () => {
  vi.mocked(acquireBrowser).mockImplementation(async (_, record) => {
    const tabId = parseTabId('tab_0123456789abcdef0123456789abcdef');
    const fixture = tabFixture(record);
    record.tabs.delete(fixture.tab.binding.tabId);
    fixture.tab.binding = { ...fixture.tab.binding, tabId };
    record.tabs.set(tabId, fixture.tab);
    record.status = 'running'; // A completed acquisition double, with no owned native process.
    queueMicrotask(() => {
      void engine.shutdown();
    });
  });
  const engine = createBrowserEngine(configuration());
  await expect(engine.open({ kind: 'open', requestId, mode: 'ephemeral' })).rejects.toMatchObject({
    code: 'ENGINE_STOPPED',
  });
  expect(await engine.shutdown()).toHaveLength(1);
});
