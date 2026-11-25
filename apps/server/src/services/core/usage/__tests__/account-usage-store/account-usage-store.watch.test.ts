import { describe, it, expect, onTestFinished, vi } from 'vitest';
import path from 'node:path';
import { writeLedger } from '../../ledger-file.js';
import { loadCeilingMs, loadScaledMs } from '@dorkos/shared/test-budget';
import { fsWatchWithPolling } from '../../../../../__tests__/watch-with-polling.js';
import {
  usage,
  useUsageStoreSandbox,
  obs,
  writeConfig,
  claudeConfig,
  makeStore,
  claudeDir,
} from './account-usage-store.fixtures.js';

useUsageStoreSandbox();

describe('AccountUsageStore: the folder watch', () => {
  // The folder watch POLLS (`fsWatchWithPolling`): macOS drops native events
  // under load, and this case reddened healthy code on exactly that
  // (DOR-2021). The real `fs.watch` call, its filename filter and the debounce
  // are production's; only how a change is noticed differs.
  it(
    'picks up a reading flow writes and emits it',
    { timeout: Math.min(loadCeilingMs(6_000), 60_000) },
    async () => {
      const polling = fsWatchWithPolling(50);
      onTestFinished(() => polling.restore());
      await writeConfig(
        claudeConfig([{ id: 'work', path: path.join(usage.home, '.claude3'), label: null }])
      );
      await writeLedger(claudeDir(), 'work', [obs('five_hour', 1)], new Date(usage.clock));
      const broadcast = vi.fn();
      const store = makeStore({
        broadcast,
        timings: { watchDebounceMs: 20, broadcastThrottleMs: 20, scanIntervalMs: 3_600_000 },
      });
      await store.load();
      expect(broadcast).not.toHaveBeenCalled();
      await writeLedger(
        claudeDir(),
        'work',
        [obs('seven_day', 81, usage.clock + 1)],
        new Date(usage.clock)
      );
      await vi.waitFor(
        () =>
          expect(store.peek('claude-code', ['work'])[0]!.windows.map((w) => w.key)).toContain(
            'seven_day'
          ),
        { timeout: loadScaledMs(3_000) }
      );
      await vi.waitFor(() => expect(broadcast).toHaveBeenCalled(), {
        timeout: loadScaledMs(3_000),
      });
      expect(polling.opened.length).toBeGreaterThan(0);
    }
  );
});
