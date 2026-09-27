/**
 * Schedules move with a Claude account the '0.87.0' migration renamed, and
 * keep their approval (spec `claude-account-fleet` §6 R).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@dorkos/test-utils/db';
import { pulseSchedules, type Db } from '@dorkos/db';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { readRawFrontmatter } from '@dorkos/skills/parser';
import { writeSkillFile } from '@dorkos/skills/writer';
import { TaskStore } from '../../task-store.js';
import type { TaskFileSync } from '../../sync/task-file-sync.js';
import { parseContentKey } from '../../schedule-permission-clamp.js';
import { renameScheduleAccount, rewriteScheduleAccountInPlace } from '../account-rename.js';

const notOwned = async () => false;

const PROMPT = 'Post the overnight digest.';
const CRON = '0 7 * * *';
const DISCOVERY = { source: 'discovery' } as const;

let root: string;
let filePath: string;
let db: Db;
let store: TaskStore;

async function writeSchedule(account: string): Promise<void> {
  await writeSkillFile(
    root,
    'digest',
    {
      name: 'digest',
      description: 'Post the overnight digest',
      schedule: { cron: CRON, timezone: 'UTC', enabled: true, permissions: 'acceptEdits', account },
    },
    PROMPT
  );
}

function definition(account: string) {
  return {
    name: 'digest',
    meta: {
      name: 'digest',
      description: 'Post the overnight digest',
      schedule: {
        cron: CRON,
        timezone: 'UTC',
        enabled: true,
        sticky: false,
        permissions: 'acceptEdits',
        account,
      },
    },
    body: PROMPT,
    filePath,
    dirPath: path.dirname(filePath),
    scope: 'global',
  } as Parameters<TaskFileSync['upsertFromFile']>[0];
}

async function fileAccount(): Promise<unknown> {
  const raw = readRawFrontmatter(await fs.readFile(filePath, 'utf8'));
  return (raw?.data.schedule as Record<string, unknown>).account;
}

const row = (id: string) =>
  db.select().from(pulseSchedules).where(eq(pulseSchedules.id, id)).get()!;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'account-rename-'));
  filePath = path.join(root, 'digest', SKILL_FILENAME);
  db = createTestDb();
  store = new TaskStore(db);
});

afterEach(async () => {
  await fs.chmod(path.join(root, 'digest'), 0o755).catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
});

describe('renameScheduleAccount', () => {
  it('moves the row, its approval and its file, and the schedule stays approved', async () => {
    await writeSchedule('default');
    const id = store.fileSync.upsertFromFile(definition('default')).id;
    expect(parseContentKey(row(id).approvedContentKey!)?.account).toBe('default');

    expect(await renameScheduleAccount(db, 'default', 'default-2', notOwned)).toEqual({
      rows: 1,
      files: 1,
    });

    expect(row(id).account).toBe('default-2');
    expect(parseContentKey(row(id).approvedContentKey!)?.account).toBe('default-2');
    expect(await fileAccount()).toBe('default-2');
    // The next file sync reads the moved file and finds the work it approved.
    expect(
      store.fileSync.upsertFromFile(definition('default-2'), undefined, DISCOVERY).status
    ).toBe('active');
  });

  it('re-runs cleanly after being cut short between the row and the file', async () => {
    await writeSchedule('default');
    const id = store.fileSync.upsertFromFile(definition('default')).id;
    await fs.chmod(path.join(root, 'digest'), 0o555);
    await expect(renameScheduleAccount(db, 'default', 'default-2', notOwned)).rejects.toThrow();
    // The row and its approval moved together; the file did not.
    expect(row(id).account).toBe('default-2');
    expect(await fileAccount()).toBe('default');

    await fs.chmod(path.join(root, 'digest'), 0o755);
    expect(await renameScheduleAccount(db, 'default', 'default-2', notOwned)).toEqual({
      rows: 0,
      files: 1,
    });
    expect(await fileAccount()).toBe('default-2');
    expect(parseContentKey(row(id).approvedContentKey!)?.account).toBe('default-2');
    expect(await renameScheduleAccount(db, 'default', 'default-2', notOwned)).toEqual({
      rows: 0,
      files: 0,
    });
  });

  it('leaves a schedule on another account alone', async () => {
    await writeSchedule('work');
    const id = store.fileSync.upsertFromFile(definition('work')).id;
    const before = row(id);
    expect(await renameScheduleAccount(db, 'default', 'default-2', notOwned)).toEqual({
      rows: 0,
      files: 0,
    });
    expect(row(id)).toEqual(before);
    expect(await fileAccount()).toBe('work');
  });

  it('edits only the account value, byte for byte everywhere else', async () => {
    const before = [
      '---',
      '# kept: a comment',
      'name: digest',
      'description: "Post the overnight digest"  # quoted',
      'tags: [daily, digest]',
      'schedule:',
      "  cron: '0 7 * * *'",
      '  enabled: true',
      "  account: 'default' # the main sign-in",
      '  timezone: UTC',
      '---',
      '',
      'Post the overnight digest.',
      '',
    ].join('\n');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, before);
    const id = store.fileSync.upsertFromFile(definition('default')).id;

    await renameScheduleAccount(db, 'default', 'default-2', notOwned);

    expect(await fs.readFile(filePath, 'utf8')).toBe(
      before.replace("account: 'default' #", "account: 'default-2' #")
    );
    expect(row(id).account).toBe('default-2');
  });

  it('leaves a flow-style schedule block to the planner', () => {
    const flow = '---\nname: x\nschedule: { cron: "0 7 * * *", account: default }\n---\nbody\n';
    expect(rewriteScheduleAccountInPlace(flow, 'default', 'default-2')).toBeNull();
  });

  it('skips a schedule an installed package owns: neither its row nor its file moves', async () => {
    await writeSchedule('default');
    const id = store.fileSync.upsertFromFile(definition('default')).id;
    const before = await fs.readFile(filePath, 'utf8');
    const owned = async ({ filePath: file }: { filePath: string }) => file === filePath;

    expect(await renameScheduleAccount(db, 'default', 'default-2', owned)).toEqual({
      rows: 0,
      files: 0,
    });
    expect(row(id).account).toBe('default');
    expect(parseContentKey(row(id).approvedContentKey!)?.account).toBe('default');
    expect(await fs.readFile(filePath, 'utf8')).toBe(before);
  });

  it('writes through a symlinked SKILL.md: the link stays a link and its target changes', async () => {
    const real = path.join(root, 'real-skill.md');
    await writeSchedule('default');
    await fs.rename(filePath, real);
    await fs.symlink(real, filePath);
    const id = store.fileSync.upsertFromFile(definition('default')).id;

    expect(await renameScheduleAccount(db, 'default', 'default-2', notOwned)).toEqual({
      rows: 1,
      files: 1,
    });
    expect((await fs.lstat(filePath)).isSymbolicLink()).toBe(true);
    expect(await fileAccount()).toBe('default-2');
    expect(row(id).account).toBe('default-2');
    expect((await fs.readdir(path.dirname(filePath))).filter((n) => n.endsWith('.tmp'))).toEqual(
      []
    );
  });

  it('a disk that fills mid-write leaves the file untouched and no temp file behind', async () => {
    await writeSchedule('default');
    const id = store.fileSync.upsertFromFile(definition('default')).id;
    const before = await fs.readFile(filePath, 'utf8');
    const diskFull = () => Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });

    // Every way of writing gets half its bytes down, then the disk is full.
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      const realWrite = handle.writeFile.bind(handle);
      handle.writeFile = (async (data: string) => {
        await realWrite(data.slice(0, Math.floor(data.length / 2)));
        throw diskFull();
      }) as typeof handle.writeFile;
      return handle;
    });
    const realWriteFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation((async (file: string, data: string) => {
      await realWriteFile(file, String(data).slice(0, Math.floor(String(data).length / 2)));
      throw diskFull();
    }) as typeof fs.writeFile);

    await expect(renameScheduleAccount(db, 'default', 'default-2', notOwned)).rejects.toThrow(
      /ENOSPC/
    );
    vi.restoreAllMocks();

    expect(await fs.readFile(filePath, 'utf8')).toBe(before);
    expect((await fs.readdir(path.dirname(filePath))).filter((n) => n.endsWith('.tmp'))).toEqual(
      []
    );
    // The row moved; the file is finished by the next run.
    expect(row(id).account).toBe('default-2');
    expect(await renameScheduleAccount(db, 'default', 'default-2', notOwned)).toEqual({
      rows: 0,
      files: 1,
    });
    expect(await fileAccount()).toBe('default-2');
  });
});
