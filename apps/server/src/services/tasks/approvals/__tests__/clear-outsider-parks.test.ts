/**
 * A marked schedule stays off and pending review across boot and discovery (DOR-3860).
 * Switching off never removes the marks or creates approval; cleared rows remain untouched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@dorkos/test-utils/db';
import { pulseSchedules, type Db } from '@dorkos/db';
import { readRawFrontmatter } from '@dorkos/skills/parser';
import { ScheduleBlockSchema } from '@dorkos/skills';
import { writeSkillFile } from '@dorkos/skills/writer';
import { planTaskFileUpdate } from '../../task-file-update.js';
import { TaskStore } from '../../task-store.js';
import type { TaskFileSync } from '../../sync/task-file-sync.js';
import {
  decideAgentModeCall,
  type AgentModeSources,
} from '../../agent-mode/agent-mode-decision.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';

let root: string;
let db: Db;
let store: TaskStore;

/** A schedule on disk, switched on, and its row parked with these marks. */
async function parked(name: string, marks: unknown): Promise<string> {
  const schedule = {
    cron: '0 7 * * *',
    timezone: 'UTC',
    enabled: true,
    permissions: 'acceptEdits',
  };
  const filePath = await writeSkillFile(root, name, { name, description: 'd', schedule }, 'Go.');
  const task = store.fileSync.upsertFromFile({
    name,
    meta: { name, description: 'd', schedule: { ...schedule, sticky: false } },
    body: 'Go.',
    filePath,
    dirPath: path.dirname(filePath),
    scope: 'global',
  } as Parameters<TaskFileSync['upsertFromFile']>[0]);
  db.update(pulseSchedules)
    .set({
      status: 'pending_approval',
      approvedContentKey: null,
      originMarks: JSON.stringify(marks),
    })
    .where(eq(pulseSchedules.id, task.id))
    .run();
  return task.id;
}

const rowOf = (id: string) =>
  db.select().from(pulseSchedules).where(eq(pulseSchedules.id, id)).get()!;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'clear-parks-'));
  db = createTestDb();
  store = new TaskStore(db);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** What a discovery sync does with the file as it is on disk now. */
async function sync(filePath: string, packageOwned: 'record' | null = null) {
  const raw = readRawFrontmatter(await fs.readFile(filePath, 'utf8'));
  const name = 'digest';
  const schedule = ScheduleBlockSchema.parse(raw?.data.schedule);
  return store.fileSync.upsertFromFile(
    {
      name,
      meta: { name, description: 'd', schedule },
      body: 'Go.',
      filePath,
      dirPath: path.dirname(filePath),
      scope: 'global',
    } as Parameters<TaskFileSync['upsertFromFile']>[0],
    undefined,
    { source: 'discovery', packageOwned }
  );
}

describe('a real sync after the clear', () => {
  it('a person’s file stays off and pending review', async () => {
    const id = await parked('digest', { outsider: true });
    await store.approvals.clearOutsiderParks();
    store.approvals.backfillApprovalGrants();

    const task = await sync(rowOf(id).filePath);

    expect(task).toMatchObject({ enabled: false, status: 'pending_approval' });
    expect(rowOf(id).approvedContentKey).toBeNull();
  });

  it('a package’s file, still saying on, stays off and pending review', async () => {
    const id = await parked('digest', { outsider: true });
    db.update(pulseSchedules)
      .set({ packageOwned: 'record' })
      .where(eq(pulseSchedules.id, id))
      .run();
    await store.approvals.clearOutsiderParks();
    store.approvals.backfillApprovalGrants();

    const raw = readRawFrontmatter(await fs.readFile(rowOf(id).filePath, 'utf8'));
    expect((raw?.data.schedule as { enabled: unknown }).enabled).toBe(true);
    const task = await sync(rowOf(id).filePath, 'record');

    expect(task).toMatchObject({ enabled: false, status: 'pending_approval' });
    expect(rowOf(id).approvedContentKey).toBeNull();
  });

  it('a project’s copy leaves the shared file alone, and stays off', async () => {
    const id = await parked('digest', { outsider: true });
    db.update(pulseSchedules).set({ projectOnly: true }).where(eq(pulseSchedules.id, id)).run();

    await store.approvals.clearOutsiderParks();

    const raw = readRawFrontmatter(await fs.readFile(rowOf(id).filePath, 'utf8'));
    expect((raw?.data.schedule as { enabled: unknown }).enabled).toBe(true);
    expect(rowOf(id)).toMatchObject({ enabled: false, status: 'pending_approval' });
  });

  it('a project’s copy stays off through a sync, and its neighbours do not change', async () => {
    const schedule = {
      cron: '0 7 * * *',
      timezone: 'UTC',
      enabled: true,
      permissions: 'acceptEdits',
    };
    const filePath = await writeSkillFile(
      root,
      'digest',
      { name: 'digest', description: 'd', schedule },
      'Go.'
    );
    const syncCopy = async (agentId: string) => {
      const raw = readRawFrontmatter(await fs.readFile(filePath, 'utf8'));
      return store.fileSync.upsertFromFile(
        {
          name: 'digest',
          meta: {
            name: 'digest',
            description: 'd',
            schedule: ScheduleBlockSchema.parse(raw?.data.schedule),
          },
          body: 'Go.',
          filePath,
          dirPath: path.dirname(filePath),
          scope: 'global',
        } as Parameters<TaskFileSync['upsertFromFile']>[0],
        agentId,
        { source: 'discovery', packageOwned: null, projectOnly: true }
      );
    };
    const clearedId = (await syncCopy('project-a')).id;
    const onId = (await syncCopy('project-b')).id;
    const offId = (await syncCopy('project-c')).id;
    db.update(pulseSchedules)
      .set({
        enabled: true,
        status: 'pending_approval',
        approvedContentKey: null,
        originMarks: JSON.stringify({ outsider: true }),
      })
      .where(eq(pulseSchedules.id, clearedId))
      .run();
    db.update(pulseSchedules)
      .set({ enabled: true, status: 'active' })
      .where(eq(pulseSchedules.id, onId))
      .run();
    db.update(pulseSchedules)
      .set({ enabled: false, status: 'active' })
      .where(eq(pulseSchedules.id, offId))
      .run();
    // Every earlier boot already ran this, so the neighbours start with their keys filled.
    store.approvals.backfillApprovalGrants();
    const before = { on: rowOf(onId), off: rowOf(offId) };
    expect(rowOf(clearedId).status).toBe('pending_approval');

    expect(await store.approvals.clearOutsiderParks()).toBe(1);
    store.approvals.backfillApprovalGrants();
    for (const agent of ['project-a', 'project-b', 'project-c']) await syncCopy(agent);

    expect(rowOf(clearedId)).toMatchObject({
      enabled: false,
      status: 'pending_approval',
      originMarks: JSON.stringify({ outsider: true }),
      approvedContentKey: null,
    });
    const raw = readRawFrontmatter(await fs.readFile(filePath, 'utf8'));
    expect((raw?.data.schedule as { enabled: unknown }).enabled).toBe(true);
    expect(rowOf(onId)).toMatchObject({
      enabled: before.on.enabled,
      status: before.on.status,
      approvedContentKey: before.on.approvedContentKey,
    });
    expect(rowOf(offId)).toMatchObject({
      enabled: before.off.enabled,
      status: before.off.status,
      approvedContentKey: before.off.approvedContentKey,
    });
  });
});

describe('a person approves a cleared schedule and turns it on', () => {
  it('a person’s file: the file says on, and the next sync keeps it on and approved', async () => {
    const id = await parked('digest', { outsider: true });
    await store.approvals.clearOutsiderParks();
    store.approvals.backfillApprovalGrants();
    const filePath = rowOf(id).filePath;

    // What the route does for `enabled: true`: the file write, then the row. A file saying on
    // never turns a task on by itself (DOR-3309), so the row's switch is the person's act.
    const plan = planTaskFileUpdate(filePath, await fs.readFile(filePath, 'utf8'), {
      enabled: true,
    });
    if (plan.kind === 'refuse') throw new Error(plan.message);
    await writeSkillFile(
      path.dirname(path.dirname(filePath)),
      'digest',
      plan.frontmatter,
      plan.body
    );
    store.updateTask(id, { enabled: true, status: 'active' });
    const task = await sync(filePath);

    expect(task).toMatchObject({ enabled: true, status: 'active' });
    expect(await sync(filePath)).toMatchObject({ enabled: true, status: 'active' });
  });

  it('a package’s file: the switch on the row holds through the next sync', async () => {
    const id = await parked('digest', { outsider: true });
    db.update(pulseSchedules)
      .set({ packageOwned: 'record' })
      .where(eq(pulseSchedules.id, id))
      .run();
    await store.approvals.clearOutsiderParks();
    store.approvals.backfillApprovalGrants();

    store.updateTask(id, { enabled: true, status: 'active' });
    const task = await sync(rowOf(id).filePath, 'record');

    expect(task).toMatchObject({ enabled: true, status: 'active' });
  });
});

describe('clearOutsiderParks', () => {
  it('leaves the row and its file off, and the back-fill does not switch it on', async () => {
    const id = await parked('digest', { outsider: true });
    db.update(pulseSchedules)
      .set({ approvedContentKey: 'stale-grant', previousApprovalKey: 'older-grant' })
      .where(eq(pulseSchedules.id, id))
      .run();

    expect(await store.approvals.clearOutsiderParks()).toBe(1);
    store.approvals.backfillApprovalGrants();

    const row = rowOf(id);
    expect(row).toMatchObject({
      enabled: false,
      status: 'pending_approval',
      originMarks: JSON.stringify({ outsider: true }),
      approvedContentKey: null,
    });
    const raw = readRawFrontmatter(await fs.readFile(row.filePath, 'utf8'));
    expect((raw?.data.schedule as { enabled: unknown }).enabled).toBe(false);
  });

  it('clears a teammate’s mark the same way', async () => {
    const id = await parked('digest', { teammate: [{ roomId: 'r', authorId: 'a' }] });

    expect(await store.approvals.clearOutsiderParks()).toBe(1);
    expect(rowOf(id)).toMatchObject({
      status: 'pending_approval',
      enabled: false,
      originMarks: JSON.stringify({ teammate: [{ roomId: 'r', authorId: 'a' }] }),
      approvedContentKey: null,
    });
  });

  it('leaves an ordinary switched-off approved row untouched', async () => {
    const id = await parked('ordinary-off', { outsider: true });
    db.update(pulseSchedules)
      .set({ enabled: false, status: 'active', originMarks: null })
      .where(eq(pulseSchedules.id, id))
      .run();
    store.approvals.backfillApprovalGrants();
    const before = rowOf(id);
    expect(before.approvedContentKey).not.toBeNull();
    const fileBefore = await fs.readFile(before.filePath, 'utf8');

    expect(await store.approvals.clearOutsiderParks()).toBe(0);
    expect(store.approvals.backfillApprovalGrants()).toBe(0);

    expect(rowOf(id)).toEqual(before);
    expect(await fs.readFile(before.filePath, 'utf8')).toBe(fileBefore);
  });

  it('preserves the row’s outside-word marks after switching it off', async () => {
    const marks = {
      outsider: true,
      teammate: [{ roomId: 'sample-room', authorId: 'sample-agent' }],
    };
    const id = await parked('marked-words', marks);

    expect(await store.approvals.clearOutsiderParks()).toBe(1);
    expect(store.getTask(id)?.originMarks).toMatchObject(marks);
    expect(rowOf(id).originMarks).toBe(JSON.stringify(marks));
  });

  it('still asks with marked-task when its owning agent approves after restart cleanup', async () => {
    const owner = path.join(root, 'sample-owner');
    const editor = path.join(root, 'sample-editor');
    const sources: AgentModeSources = {
      declaredModes: () => CLAUDE_CODE_CAPABILITIES.permissionModes,
      agentLevelMode: async () => 'bypassPermissions',
      agentPathOf: (id) => (id === 'sample-owner' ? owner : editor),
      readConfig: () => ({
        preset: 'trusted',
        defaults: {
          areas: {},
          actions: { 'tasks.approve': 'allowed', 'tasks.set_mode': 'allowed' },
        },
      }),
      readAgentPermissions: async () => undefined,
      startedBy: () => null,
      turnLevelOf: () => ({ asks: 'never', reach: 'everything' }),
    };
    const caller = {
      structural: true,
      agentPath: owner,
      sessionId: 'sample-owner-chat',
      marked: false,
      resolved: 'home' as const,
    };
    for (const mode of ['dontAsk', 'default'] as const) {
      const id = await parked(`marked-${mode.toLowerCase()}`, { outsider: true });
      db.update(pulseSchedules)
        .set({
          agentId: 'sample-owner',
          permissionMode: mode,
          proposedByAgentPath: editor,
          proposedBySessionId: 'sample-editor-chat',
        })
        .where(eq(pulseSchedules.id, id))
        .run();
      await store.approvals.clearOutsiderParks();
      store.approvals.backfillApprovalGrants();
      const task = store.getTask(id)!;
      const call = {
        door: 'update' as const,
        body: { status: 'active' },
        task,
        edits: {
          lastEditedByAgentPath: editor,
          lastEditedBySessionId: 'sample-editor-chat',
          agentApprovalKey: null,
        },
      };
      const decision = await decideAgentModeCall(call, caller, sources);
      expect(decision).toMatchObject({ kind: 'decided', state: 'ask', asks: ['marked-task'] });
      expect(
        await decideAgentModeCall(
          { ...call, task: { ...task, originMarks: null } },
          caller,
          sources
        )
      ).toMatchObject({ kind: 'decided', state: 'allowed' });
    }
  });

  it('matches nothing the second time', async () => {
    await parked('digest', { outsider: true });
    await store.approvals.clearOutsiderParks();
    expect(await store.approvals.clearOutsiderParks()).toBe(0);
  });
});
