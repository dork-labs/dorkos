/**
 * The account reconcile carries the '0.87.0' rename of a registry row called
 * `default` through to every reference, then drops the marker, after which
 * `default` names only the machine default (contract rev 6d; spec
 * `claude-account-fleet` §6 R, task 1.3's hand-off).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@dorkos/test-utils/db';
import { pulseSchedules, type Db } from '@dorkos/db';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { readRawFrontmatter } from '@dorkos/skills/parser';
import { writeSkillFile } from '@dorkos/skills/writer';
import { AccountUsageStore } from '../account-usage-store.js';
import { readConfigFile } from '../account-usage-reconcile.js';
import { moveAccountReferences, type AccountReferenceSites } from '../account-reference-move.js';
import { defaultAccountFolder } from '../runtime-accounts.js';
import { TaskStore } from '../../../tasks/task-store.js';
import type { TaskFileSync } from '../../../tasks/sync/task-file-sync.js';
import { parseContentKey } from '../../../tasks/schedule-permission-clamp.js';
import { renameScheduleAccount } from '../../../tasks/approvals/account-rename.js';
import {
  dropClaudeAccountRenameMarkers,
  resolveLaunchAccountRoot,
} from '../../../runtimes/claude-code/claude-config-dir.js';

let root: string;
let dorkHome: string;
let home: string;
let skillFile: string;
let db: Db;
let tasks: TaskStore;
let agents: { id: string; account?: string | null; projectPath?: string }[];
let stores: AccountUsageStore[];

const configPath = () => path.join(dorkHome, 'config.json');
const renamedRow = () => ({
  id: 'default-2',
  path: path.join(home, '.claude-old-default'),
  label: 'Default',
  color: null,
  renamedFrom: 'default',
});

async function writeConfig(rows: unknown[]): Promise<void> {
  await fs.writeFile(
    configPath(),
    JSON.stringify({ runtimes: { claudeCode: { defaultAccount: null, accounts: rows } } })
  );
}

/** A config manager over the file on disk, as `ConfigManager` reads and writes it. */
const fileConfig = {
  get: <K extends keyof UserConfig>(key: K): UserConfig[K] => {
    const raw = JSON.parse(fsSync.readFileSync(configPath(), 'utf8'));
    return raw[key];
  },
  set: <K extends keyof UserConfig>(key: K, value: UserConfig[K]): void => {
    const raw = JSON.parse(fsSync.readFileSync(configPath(), 'utf8'));
    fsSync.writeFileSync(configPath(), JSON.stringify({ ...raw, [key]: value }));
  },
};

function sites(overrides: Partial<AccountReferenceSites> = {}): AccountReferenceSites {
  return {
    agents: {
      list: () => agents,
      setAccount: async (id, account) => {
        agents = agents.map((a) => (a.id === id ? { ...a, account } : a));
      },
    },
    renameScheduleAccount: (from, to) => renameScheduleAccount(db, from, to, async () => false),
    ...overrides,
  };
}

function makeStore(referenceSites: AccountReferenceSites = sites()): AccountUsageStore {
  const store = new AccountUsageStore({
    dorkHome,
    readConfig: () => readConfigFile(configPath()),
    resolveDefaultRoot: (runtime, config) => defaultAccountFolder(runtime, config, home),
    timings: { scanIntervalMs: 3_600_000 },
  });
  store.setReferenceMover({
    move: (renames) => moveAccountReferences(renames, referenceSites),
    dropMarkers: async (ids) => dropClaudeAccountRenameMarkers(fileConfig, ids),
  });
  stores.push(store);
  return store;
}

async function scheduleOn(account: string): Promise<string> {
  await writeSkillFile(
    path.join(root, 'skills'),
    'digest',
    {
      name: 'digest',
      description: 'Post the overnight digest',
      schedule: {
        cron: '0 7 * * *',
        timezone: 'UTC',
        enabled: true,
        permissions: 'acceptEdits',
        account,
      },
    },
    'Post the overnight digest.'
  );
  const def = {
    name: 'digest',
    meta: {
      name: 'digest',
      description: 'Post the overnight digest',
      schedule: {
        cron: '0 7 * * *',
        timezone: 'UTC',
        enabled: true,
        sticky: false,
        permissions: 'acceptEdits',
        account,
      },
    },
    body: 'Post the overnight digest.',
    filePath: skillFile,
    dirPath: path.dirname(skillFile),
    scope: 'global',
  } as Parameters<TaskFileSync['upsertFromFile']>[0];
  return tasks.fileSync.upsertFromFile(def).id;
}

const storedRows = async () =>
  JSON.parse(await fs.readFile(configPath(), 'utf8')).runtimes.claudeCode.accounts;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rename-reconcile-')));
  dorkHome = path.join(root, 'dork');
  home = path.join(root, 'home');
  skillFile = path.join(root, 'skills', 'digest', SKILL_FILENAME);
  await fs.mkdir(dorkHome, { recursive: true });
  db = createTestDb();
  tasks = new TaskStore(db);
  const agentDir = path.join(root, 'agent-a');
  await fs.mkdir(path.join(agentDir, '.dork'), { recursive: true });
  await fs.writeFile(path.join(agentDir, '.dork', 'agent.json'), '{}');
  agents = [
    { id: 'agent-a', account: 'default', projectPath: agentDir },
    { id: 'agent-b', account: 'work', projectPath: agentDir },
  ];
  stores = [];
});

afterEach(async () => {
  for (const store of stores) store.stop();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('carrying a renamed `default` row through to its references', () => {
  it('moves the manifest, the schedule with its approval, and the SKILL.md, then drops the marker', async () => {
    await writeConfig([renamedRow()]);
    const scheduleId = await scheduleOn('default');
    const store = makeStore();
    await store.reconcileAccounts();

    expect(agents.map((a) => [a.id, a.account])).toEqual([
      ['agent-a', 'default-2'],
      ['agent-b', 'work'],
    ]);
    const row = db.select().from(pulseSchedules).where(eq(pulseSchedules.id, scheduleId)).get()!;
    expect(row.account).toBe('default-2');
    expect(parseContentKey(row.approvedContentKey!)?.account).toBe('default-2');
    const frontmatter = readRawFrontmatter(await fs.readFile(skillFile, 'utf8'));
    expect((frontmatter?.data.schedule as Record<string, unknown>).account).toBe('default-2');
    expect(await storedRows()).toEqual([
      { id: 'default-2', path: renamedRow().path, label: 'Default', color: null },
    ]);

    // With the marker gone, a fresh `default` reference is the machine default.
    expect(resolveLaunchAccountRoot({ agentAccountId: 'default', config: fileConfig })).toBe(
      path.join(os.homedir(), '.claude')
    );
    await store.reconcileAccounts();
    expect(store.peek('claude-code', ['default'])[0]!.accountId).toBe('default');
  });

  it('keeps resolving `default` to the renamed row until its references moved', async () => {
    await writeConfig([renamedRow()]);
    const store = makeStore(sites({ agents: undefined }));
    await store.reconcileAccounts();
    expect((await storedRows())[0].renamedFrom).toBe('default');
    expect(store.peek('claude-code', ['default'])[0]!.accountId).toBe('default-2');
    expect(resolveLaunchAccountRoot({ agentAccountId: 'default', config: fileConfig })).toBe(
      renamedRow().path
    );
  });

  it('a move cut short keeps the marker, and the next reconcile finishes it', async () => {
    await writeConfig([renamedRow()]);
    await scheduleOn('default');
    let failSchedules = true;
    const store = makeStore(
      sites({
        renameScheduleAccount: async (from, to) => {
          if (failSchedules) throw new Error('disk full');
          return renameScheduleAccount(db, from, to, async () => false);
        },
      })
    );
    await store.reconcileAccounts();
    // The agent moved; the schedule did not; the marker stays.
    expect(agents[0]!.account).toBe('default-2');
    expect((await storedRows())[0].renamedFrom).toBe('default');

    failSchedules = false;
    await store.reconcileAccounts();
    expect((await storedRows())[0].renamedFrom).toBeUndefined();
    expect(agents[0]!.account).toBe('default-2');
    const frontmatter = readRawFrontmatter(await fs.readFile(skillFile, 'utf8'));
    expect((frontmatter?.data.schedule as Record<string, unknown>).account).toBe('default-2');
  });

  it('changes nothing when no row carries the marker', async () => {
    await writeConfig([
      { id: 'work', path: path.join(home, '.claude3'), label: null, color: null },
    ]);
    await scheduleOn('default');
    const setAccount = vi.fn();
    const renameSchedules = vi.fn();
    const store = makeStore(
      sites({ agents: { list: () => agents, setAccount }, renameScheduleAccount: renameSchedules })
    );
    const before = await fs.readFile(configPath(), 'utf8');
    await store.reconcileAccounts();
    expect(setAccount).not.toHaveBeenCalled();
    expect(renameSchedules).not.toHaveBeenCalled();
    expect(await fs.readFile(configPath(), 'utf8')).toBe(before);
    expect(agents[0]!.account).toBe('default');
  });

  it('skips an agent whose folder is gone, creates nothing, and still drops the marker', async () => {
    await writeConfig([renamedRow()]);
    const gone = path.join(root, 'gone-agent');
    agents.push({ id: 'agent-gone', account: 'default', projectPath: gone });
    const setAccount = vi.fn(async (id: string, account: string) => {
      agents = agents.map((a) => (a.id === id ? { ...a, account } : a));
    });
    const store = makeStore(sites({ agents: { list: () => agents, setAccount } }));
    await store.reconcileAccounts();
    expect(setAccount.mock.calls.map(([id]) => id)).toEqual(['agent-a']);
    await expect(fs.access(gone)).rejects.toThrow();
    expect((await storedRows())[0].renamedFrom).toBeUndefined();
  });

  it('a fresh reconcile after wiring the mover runs with it, not the pass already in flight', async () => {
    await writeConfig([renamedRow()]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const store = new AccountUsageStore({
      dorkHome,
      readConfig: async () => {
        await gate;
        return readConfigFile(configPath());
      },
      resolveDefaultRoot: (runtime, config) => defaultAccountFolder(runtime, config, home),
      timings: { scanIntervalMs: 3_600_000 },
    });
    stores.push(store);
    const early = store.reconcileAccounts();
    store.setReferenceMover({
      move: (renames) => moveAccountReferences(renames, sites()),
      dropMarkers: async (ids) => dropClaudeAccountRenameMarkers(fileConfig, ids),
    });
    const fresh = store.reconcileAccounts({ fresh: true });
    release();
    await Promise.all([early, fresh]);
    expect(agents[0]!.account).toBe('default-2');
    expect((await storedRows())[0].renamedFrom).toBeUndefined();
  });
});
