/**
 * Shared setup for the boot-migration suites (DOR-1486): a real temp data
 * directory, a real SQLite store, and helpers that seed legacy files and read
 * back what the migration left on disk and in the row.
 *
 * Everything runs against files on a temp disk, because the whole subject is
 * what ends up in the bytes and in the row. A mocked filesystem would let every
 * one of these pass while the migration moved nothing.
 */
import { afterEach, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { pulseSchedules, type Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { readRawFrontmatter } from '@dorkos/skills/parser';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { TaskStore } from '../../task-store.js';
import { TaskRegistrar } from '../../task-registrar.js';
import { TaskReconciler } from '../../task-reconciler.js';
import { ScheduleIdentityRegistry } from '../../schedule-identity.js';
import { migrateLegacySchedules } from '../../legacy-migration.js';
import type { TaskRoot } from '../../skills-roots.js';
import { FakeScheduler } from '../fake-scheduler.js';

export const AGENT_ID = 'agent-tender';

/** A SKILL.md in the retired shape: scheduling at the top level. */
export function legacyFile(name: string, fields: Record<string, string> = {}): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: '${value}'`);
  return [
    '---',
    `name: ${name}`,
    `description: A task named ${name}`,
    ...lines,
    '---',
    'Do the thing.',
  ].join('\n');
}

/** Write `content` to `filePath`, creating its directory. */
export async function writeAt(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

/** The `schedule:` mapping as it sits in a file, defaults and all left out. */
export async function scheduleIn(filePath: string): Promise<Record<string, unknown>> {
  const raw = readRawFrontmatter(await fs.readFile(filePath, 'utf-8'));
  return (raw?.data.schedule ?? {}) as Record<string, unknown>;
}

/** A fresh data directory, project and store per test, torn down after it. */
export interface LegacyHome {
  dorkHome: string;
  projectPath: string;
  db: Db;
  store: TaskStore;
  /** Write a legacy schedule into the global `tasks/` directory. */
  seedGlobalLegacy(name: string, fields?: Record<string, string>): Promise<string>;
  /** Write a legacy schedule into a project's `.dork/tasks/` directory. */
  seedProjectLegacy(name: string, fields?: Record<string, string>): Promise<string>;
  /** A row an older build wrote for `filePath`, approved unless told otherwise. */
  seedRow(
    name: string,
    filePath: string,
    opts?: { prompt?: string; cron?: string; description?: string; approved?: boolean }
  ): string;
  /** Run the migration exactly as `index.ts` does at boot. */
  migrate(): ReturnType<typeof migrateLegacySchedules>;
  /** Where a global legacy schedule ends up. */
  globalDestination(name: string): string;
  /**
   * The arm grant on a row, read straight from the column.
   *
   * Not off the mapped `Task`: `approvedContentKey` is deliberately not on it —
   * it is a gate's private bookkeeping, not something a surface renders — so an
   * assertion against `task.approvedContentKey` reads `undefined` for every row
   * ever written and passes whatever the migration did.
   */
  grantFor(id: string): string | null;
  /** One discovery pass over `roots`, returning the scheduler it registered jobs on. */
  discover(roots: TaskRoot[]): Promise<FakeScheduler>;
}

/** Register the per-test setup and return the live handles. */
export function useLegacyHome(): LegacyHome {
  const home = {} as LegacyHome;

  async function seedLegacy(dir: string, name: string, fields: Record<string, string> = {}) {
    const filePath = path.join(dir, name, SKILL_FILENAME);
    await writeAt(filePath, legacyFile(name, fields));
    return filePath;
  }

  beforeEach(async () => {
    // Resolved, because a migrated row is keyed on the file's REAL path and
    // every macOS temp directory sits under a symlinked `/var`.
    home.dorkHome = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-migration-'))
    );
    home.projectPath = path.join(home.dorkHome, 'project');
    await fs.mkdir(home.projectPath, { recursive: true });
    home.db = createTestDb();
    home.store = new TaskStore(home.db);
  });

  afterEach(async () => {
    home.store.close();
    await fs.rm(home.dorkHome, { recursive: true, force: true });
  });

  home.seedGlobalLegacy = (name, fields) =>
    seedLegacy(path.join(home.dorkHome, 'tasks'), name, fields);
  home.seedProjectLegacy = (name, fields) =>
    seedLegacy(path.join(home.projectPath, '.dork', 'tasks'), name, fields);
  home.seedRow = (name, filePath, opts = {}) => {
    const task = home.store.createTask({
      name,
      description: opts.description ?? `A task named ${name}`,
      prompt: opts.prompt ?? 'Do the thing.',
      cron: opts.cron ?? '0 3 * * *',
      filePath,
    });
    if (opts.approved !== false) home.store.approvals.recordApproval(task.id);
    return task.id;
  };
  home.migrate = () =>
    migrateLegacySchedules({
      dorkHome: home.dorkHome,
      store: home.store,
      agents: [{ agentId: AGENT_ID, projectPath: home.projectPath }],
    });
  home.globalDestination = (name) => path.join(home.dorkHome, 'skills', name, SKILL_FILENAME);
  home.grantFor = (id) => {
    const row = home.db
      .select({ key: pulseSchedules.approvedContentKey })
      .from(pulseSchedules)
      .where(eq(pulseSchedules.id, id))
      .get();
    return row?.key ?? null;
  };
  home.discover = async (roots) => {
    const scheduler = new FakeScheduler();
    const reconciler = new TaskReconciler(
      home.store,
      new TaskRegistrar({ store: home.store, scheduler }),
      new ScheduleIdentityRegistry()
    );
    for (const root of roots) reconciler.addRoot(root);
    await reconciler.reconcile();
    return scheduler;
  };
  return home;
}
