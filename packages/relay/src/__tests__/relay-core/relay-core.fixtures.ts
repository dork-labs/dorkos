/**
 * Shared harness for the RelayCore test files in this folder: every case
 * drives a real RelayCore (chokidar watchers, SQLite and Maildir I/O).
 */
import { beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadCeilingMs } from '@dorkos/shared/test-budget';
import { RelayCore } from '../../relay-core.js';

/**
 * Bodies take 1-3s at load 14 and `close()` 0.2-2s at load 17 (measured slow,
 * not stuck: every close finishes), so vitest's 5s/10s defaults red a loaded
 * full verify on healthy code (DOR-2021). Sized from the load clamp's worst
 * case: 20s per test, 40s per hook. The 60s cap only bites if LOAD_SCALE_MAX
 * rises; it keeps a close that truly hangs saying so in a minute.
 */
export function applyRelayCoreTimeouts(): void {
  vi.setConfig({
    testTimeout: loadCeilingMs(5_000),
    hookTimeout: Math.min(60_000, loadCeilingMs(10_000)),
  });
}

/** The live temp dir and RelayCore for the current test. */
export interface RelayCoreHarness {
  tmpDir: string;
  relay: RelayCore;
}

/**
 * Give every test a fresh temp data dir and a RelayCore on it, closed and
 * removed afterwards. A test may replace `h.relay`; the replacement is closed.
 */
export function useRelayCore(prefix = 'relay-core-test-'): RelayCoreHarness {
  applyRelayCoreTimeouts();
  const h = {} as RelayCoreHarness;
  beforeEach(async () => {
    h.tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    h.relay = new RelayCore({
      dataDir: h.tmpDir,
      maxHops: 5,
      defaultTtlMs: 3_600_000,
      defaultCallBudget: 10,
    });
  });
  afterEach(async () => {
    await h.relay.close();
    await fs.rm(h.tmpDir, { recursive: true, force: true });
  });
  return h;
}

/** Make a throwaway temp dir. */
export function makeTmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
