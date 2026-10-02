import { it, expect, vi } from 'vitest';
import { createBrowserEngine } from '../index.js';
import { acquireBrowser } from '../lifecycle/acquisition.js';
import { parseTabId } from '../ids.js';
import type { TabRecord } from '../lifecycle/records.js';
import { configuration, requestId } from './lifecycle-fixture.js';
vi.mock('../lifecycle/acquisition.js', () => ({ acquireBrowser: vi.fn() }));

it('does not publish an acquisition if shutdown starts in the final await continuation gap', async () => {
  vi.mocked(acquireBrowser).mockImplementation(async (_, record) => {
    const tabId = parseTabId('tab_0123456789abcdef0123456789abcdef');
    record.tabs.set(tabId, {
      binding: {
        browserId: record.browserId,
        browserGeneration: 0,
        tabId,
        navigationGeneration: 0,
        viewportVersion: 0,
        epoch: 0,
        inputGeneration: 0,
      },
      stopped: false,
    } as TabRecord);
    record.status = 'running'; // A completed acquisition double, with no owned native process.
    queueMicrotask(() => {
      void engine.shutdown();
    });
  });
  const engine = createBrowserEngine(
    await configuration('/tmp/browser-test-not-created', 'http://127.0.0.1:9001')
  );
  await expect(engine.open({ kind: 'open', requestId, mode: 'ephemeral' })).rejects.toMatchObject({
    code: 'ENGINE_STOPPED',
  });
  expect(await engine.shutdown()).toHaveLength(1);
});
