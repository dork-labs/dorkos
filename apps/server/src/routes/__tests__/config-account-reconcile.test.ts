/**
 * `PATCH /api/config` waits for the account usage store after a save that
 * changes Claude Code's accounts (spec `claude-account-ui` §6.5, "Main's own
 * row"), so the usage the client refetches next already reflects the save.
 *
 * The stale-row case uses a real store over a real config file, with a 60 s
 * scan's pass held open after it read the config BEFORE the save: exactly the
 * pass the config listener would otherwise join.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AccountUsageStore as AccountUsageStoreType } from '../../services/core/usage/account-usage-store.js';

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: { status: { enabled: false, connected: false, url: null } },
}));

vi.mock('../../services/runtimes/claude-code/sdk/sdk-utils.js', () => ({
  resolveClaudeCliPath: () => '/usr/local/bin/claude',
  createHeldUserPrompt: vi.fn(() => ({
    prompt: (async function* () {})(),
    close: vi.fn(),
    push: vi.fn(),
  })),
}));

const target = swappableServer();
const server = target.server;

let tmpDir: string;
let home: string;
let stores: AccountUsageStoreType[];
let unsubscribe: (() => void) | undefined;

/** A Claude account folder under the temp home. */
function accountFolder(name: string): string {
  const dir = path.join(home, name);
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  return dir;
}

type Mods = {
  configManager: (typeof import('../../services/core/config-manager.js'))['configManager'];
  setAccountUsageStore: (typeof import('../../services/core/usage/current-usage-store.js'))['setAccountUsageStore'];
};

/** Fresh modules, config and app per test; `store` is installed as the process store. */
async function mountApp(): Promise<Mods> {
  const configModule = await import('../../services/core/config-manager.js');
  configModule.initConfigManager(tmpDir);
  // A live binding, set by `initConfigManager`: read it after the call.
  const configManager = configModule.configManager;
  const { setAccountUsageStore } = await import('../../services/core/usage/current-usage-store.js');
  const configRouter = (await import('../config.js')).default;
  const runtimesRouter = (await import('../runtimes.js')).default;
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.user = { userId: 'user_cockpit', credential: 'cookie' };
    next();
  });
  app.use('/api/config', configRouter);
  app.use('/api/runtimes', runtimesRouter);
  target.mount(app);
  return { configManager, setAccountUsageStore };
}

/** The accounts a registry row list writes, the way the Settings screen writes them. */
function rows(...dirs: string[]) {
  return dirs.map((dir) => ({
    id: path.basename(dir).replace(/^\./, ''),
    path: dir,
    label: null,
    color: null,
  }));
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-config-reconcile-')));
  home = path.join(tmpDir, 'home');
  process.env.DORK_HOME = tmpDir;
  stores = [];
});

afterEach(async () => {
  unsubscribe?.();
  unsubscribe = undefined;
  for (const store of stores) {
    store.stop();
    await store.flush();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('PATCH /api/config: account usage catches up before the answer', () => {
  /**
   * A real store over the real config file. `hold()` makes the NEXT config read
   * take its snapshot and then wait for `release()`: a 60 s scan that read the
   * config before the save and has not finished. `read` settles once that
   * snapshot is taken.
   */
  async function realStore(mods: Mods) {
    const { AccountUsageStore } = await import('../../services/core/usage/account-usage-store.js');
    const { readConfigFile } = await import('../../services/core/usage/account-usage-reconcile.js');
    const { defaultAccountFolder } = await import('../../services/core/usage/runtime-accounts.js');
    let gate: { wait: Promise<void>; taken: () => void } | undefined;
    const readConfig = vi.fn(async () => {
      const held = gate;
      gate = undefined;
      const snapshot = await readConfigFile(mods.configManager.path);
      if (held) {
        held.taken();
        await held.wait;
      }
      return snapshot;
    });
    const store = new AccountUsageStore({
      dorkHome: tmpDir,
      readConfig,
      resolveDefaultRoot: (runtime, config) => defaultAccountFolder(runtime, config, home),
      lockOptions: { giveUpMs: 200 },
      timings: { scanIntervalMs: 3_600_000 },
    });
    stores.push(store);
    await store.load();
    mods.setAccountUsageStore(store);
    // The listener `index.ts` wires: reconcile on every runtimes change, unawaited.
    unsubscribe = mods.configManager.onChange((change) => {
      if (change.sections.includes('runtimes')) void store.reconcileAccounts();
    });
    return {
      store,
      readConfig,
      hold() {
        let release!: () => void;
        let taken!: () => void;
        const wait = new Promise<void>((resolve) => (release = resolve));
        const read = new Promise<void>((resolve) => (taken = resolve));
        gate = { wait, taken };
        return { release, read };
      },
    };
  }

  it('lists no standalone `default` once a save registers its folder, even with a scan in flight', async () => {
    const mods = await mountApp();
    const main = accountFolder('.claude');
    const work = accountFolder('.claude2');
    const client = accountFolder('.claude3');
    mods.configManager.set('runtimes', {
      ...mods.configManager.get('runtimes'),
      claudeCode: {
        ...mods.configManager.get('runtimes').claudeCode,
        accounts: rows(work, client),
        defaultAccount: null,
      },
    });
    const { store, hold } = await realStore(mods);
    await store.reconcileAccounts({ fresh: true });
    const before = await request(server).get('/api/runtimes/claude-code/accounts/usage');
    expect(before.body.accounts.map((a: { accountId: string }) => a.accountId)).toContain(
      'default'
    );

    // The 60 s scan: it reads the config now (before the save), then stalls.
    const { release, read } = hold();
    const scan = store.reconcileAccounts();
    await read;
    // It resumes the moment the save lands, with its old snapshot.
    const off = mods.configManager.onChange(() => release());

    const saved = await request(server)
      .patch('/api/config')
      .send({ runtimes: { claudeCode: { accounts: rows(work, client, main) } } });
    off();
    expect(saved.status).toBe(200);
    await scan;

    const after = await request(server).get('/api/runtimes/claude-code/accounts/usage');
    const ids = after.body.accounts.map((a: { accountId: string }) => a.accountId);
    expect(ids).not.toContain('default');
    expect(ids).toContain('claude');
  });

  it('does not loop when the reconcile writes config itself', async () => {
    const mods = await mountApp();
    const work = accountFolder('.claude2');
    const client = accountFolder('.claude3');
    const { store, readConfig } = await realStore(mods);
    // Stands in for a reconcile that drops rename markers: its first read after
    // the save writes config, which fires the listener and asks for another pass.
    let wrote = false;
    const read = readConfig.getMockImplementation()!;
    readConfig.mockImplementation(async () => {
      if (!wrote) {
        wrote = true;
        mods.configManager.set('runtimes', {
          ...mods.configManager.get('runtimes'),
          codex: { ...mods.configManager.get('runtimes').codex },
        });
      }
      return read();
    });
    const passes = vi.spyOn(store, 'reconcileAccounts');

    const saved = await request(server)
      .patch('/api/config')
      .send({ runtimes: { claudeCode: { accounts: rows(work, client) } } });

    expect(saved.status).toBe(200);
    // The save's listener, the route's fresh pass, and the listener the
    // reconcile's own write fires, which joins a pass rather than looping.
    expect(passes.mock.calls.length).toBeLessThanOrEqual(3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(passes.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('answers 200 when the reconcile throws: the save has landed', async () => {
    const mods = await mountApp();
    const reconcileAccounts = vi.fn().mockRejectedValue(new Error('disk on fire'));
    mods.setAccountUsageStore({ reconcileAccounts } as unknown as AccountUsageStoreType);

    const saved = await request(server)
      .patch('/api/config')
      .send({ runtimes: { claudeCode: { defaultAccountColor: '#0d9488' } } });

    expect(saved.status).toBe(200);
    expect(reconcileAccounts).toHaveBeenCalledWith({ fresh: true });
    expect(mods.configManager.get('runtimes').claudeCode.defaultAccountColor).toBe('#0d9488');
  });

  it('answers 200 within the bound when the reconcile never finishes', async () => {
    const mods = await mountApp();
    const reconcileAccounts = vi.fn(() => new Promise<void>(() => {}));
    mods.setAccountUsageStore({ reconcileAccounts } as unknown as AccountUsageStoreType);

    const started = Date.now();
    const saved = await request(server)
      .patch('/api/config')
      .send({ runtimes: { claudeCode: { defaultAccount: accountFolder('.claude2') } } });

    expect(saved.status).toBe(200);
    expect(reconcileAccounts).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 10_000);

  it('does not wait on a runtimes edit that leaves the accounts alone', async () => {
    const mods = await mountApp();
    const reconcileAccounts = vi.fn(() => new Promise<void>(() => {}));
    mods.setAccountUsageStore({ reconcileAccounts } as unknown as AccountUsageStoreType);

    const saved = await request(server)
      .patch('/api/config')
      .send({ runtimes: { codex: { enabled: false } } });

    expect(saved.status).toBe(200);
    expect(reconcileAccounts).not.toHaveBeenCalled();
  });

  it('answers as before when no usage store is running', async () => {
    await mountApp();
    const saved = await request(server)
      .patch('/api/config')
      .send({ runtimes: { claudeCode: { defaultAccountColor: '#0d9488' } } });
    expect(saved.status).toBe(200);
  });
});
