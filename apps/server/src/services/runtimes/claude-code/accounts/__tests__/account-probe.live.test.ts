/**
 * Opt-in live check for the account probe (spec `claude-account-fleet` D3).
 *
 * Every other probe test uses a fake query. This one proves the real Claude
 * Code binary answers the usage call on an idle prompt with `settingSources: []`
 * and `persistSession: false`: windows are recorded, and no transcript appears
 * under the account's `projects/`. It runs no turn, so it spends nothing.
 *
 * Skipped unless `DORKOS_ACCOUNT_PROBE_LIVE=1` (read at module scope, and never
 * passed through turbo, so no `pnpm test`, `pnpm verify` or CI run arms it).
 * Run it by hand against a signed-in account:
 *
 *   DORKOS_ACCOUNT_PROBE_LIVE=1 pnpm vitest run \
 *     apps/server/src/services/runtimes/claude-code/accounts/__tests__/account-probe.live.test.ts
 *
 * `DORKOS_ACCOUNT_PROBE_DIR` names the account folder (default `~/.claude`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AccountUsageStore } from '../../../../core/usage/account-usage-store.js';
import { readConfigFile } from '../../../../core/usage/account-usage-reconcile.js';
import { defaultAccountFolder } from '../../../../core/usage/runtime-accounts.js';
import { probeAccount, resetAccountProbeState } from '../account-probe.js';

const LIVE = process.env.DORKOS_ACCOUNT_PROBE_LIVE === '1';
const ACCOUNT_DIR = process.env.DORKOS_ACCOUNT_PROBE_DIR ?? path.join(os.homedir(), '.claude');

/** Every file under `dir`, relative, so a new transcript shows up as a new name. */
async function listFiles(dir: string): Promise<Set<string>> {
  const out = new Set<string>();
  const walk = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.add(path.relative(dir, full));
    }
  };
  await walk(dir);
  return out;
}

describe.skipIf(!LIVE)('account probe, live (DORKOS_ACCOUNT_PROBE_LIVE=1)', () => {
  let root: string;
  let store: AccountUsageStore;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'account-probe-live-'));
    const dorkHome = path.join(root, 'dork');
    await fs.mkdir(dorkHome, { recursive: true });
    await fs.writeFile(
      path.join(dorkHome, 'config.json'),
      JSON.stringify({
        runtimes: {
          claudeCode: {
            defaultAccount: null,
            accounts: [{ id: 'live', path: ACCOUNT_DIR, label: 'Live probe' }],
          },
        },
      })
    );
    store = new AccountUsageStore({
      dorkHome,
      readConfig: () => readConfigFile(path.join(dorkHome, 'config.json')),
      resolveDefaultRoot: (runtime, config) => defaultAccountFolder(runtime, config, os.homedir()),
    });
    await store.load();
    resetAccountProbeState();
  });

  afterAll(async () => {
    store?.stop();
    await store?.flush();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('records windows from the real CLI and leaves no transcript', async () => {
    const projects = path.join(ACCOUNT_DIR, 'projects');
    const before = await listFiles(projects);

    const result = await probeAccount('live', { store, dorkHome: path.join(root, 'dork') });

    const after = await listFiles(projects);
    const added = [...after].filter((name) => !before.has(name));
    // Printed so the run can be pasted into the PR.
    console.log(
      JSON.stringify(
        {
          probe: result.probe,
          reason: result.reason,
          subscriptionType: result.account.subscriptionType,
          windows: result.account.windows.map((w) => ({
            key: w.key,
            usedPct: w.usedPct,
            resetsAt: w.resetsAt,
          })),
          newFilesUnderProjects: added,
        },
        null,
        2
      )
    );
    expect(result.probe).toBe('ok');
    expect(result.account.windows.length).toBeGreaterThan(0);
    expect(added).toEqual([]);
  }, 60_000);
});
