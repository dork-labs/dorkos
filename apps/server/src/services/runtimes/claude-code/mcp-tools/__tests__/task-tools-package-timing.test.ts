/**
 * `tasks_update` on a package's schedule: an agent can change when it runs,
 * and a person has to approve that before it does (DOR-2302).
 *
 * A package's schedule takes a new timing on its row alone — its file is the
 * package's and DorkOS never writes it — so no watcher and no sync is coming
 * to park it. The tool has to, in the same call, and has to say so to the
 * agent in words that are true for this case ("already stopped", not "within
 * a few minutes").
 *
 * @module services/runtimes/claude-code/mcp-tools/__tests__/task-tools-package-timing
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Task } from '@dorkos/shared/schemas';
import { parseSkillFile } from '@dorkos/skills/parser';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import { hasSchedule } from '@dorkos/skills';
import { TaskStore } from '../../../../tasks/task-store.js';
import type { McpToolDeps } from '../types.js';
import { getTasksTools, REAPPROVAL_NOTE, TIMING_REAPPROVAL_NOTE } from '../task-tools.js';
import { raiseStanding } from '../../../../notifications/standing-events.js';

vi.mock('../../../../notifications/standing-events.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../notifications/standing-events.js')>()),
  raiseStanding: vi.fn(),
}));

/** The shape `tool()` returns, narrowed to what this test drives. */
interface SessionTool {
  name: string;
  handler: (
    args: Record<string, unknown>,
    extra: unknown
  ) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}

const SKILL = [
  '---',
  'name: drain',
  'description: A packaged schedule',
  'schedule:',
  "  cron: '0 9 * * *'",
  '---',
  'Drain the queue.',
].join('\n');

describe('tasks_update and a package’s schedule’s timing', () => {
  let store: TaskStore;
  let tools: Record<string, SessionTool>;
  let root: string;
  let filePath: string;

  beforeEach(async () => {
    vi.mocked(raiseStanding).mockClear();
    store = new TaskStore(createTestDb());
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-mcp-pkg-timing-')));
    const dorkHome = path.join(root, 'dork');
    const dir = path.join(dorkHome, 'plugins', 'pack', 'skills', 'drain');
    await fs.mkdir(dir, { recursive: true });
    filePath = path.join(dir, 'SKILL.md');
    await fs.writeFile(filePath, SKILL, 'utf-8');

    const deps = {
      taskStore: store,
      defaultCwd: '/tmp/test',
      dorkHome,
      meshCore: { getProjectPath: () => null },
    } as unknown as McpToolDeps;
    tools = Object.fromEntries(
      (getTasksTools(deps) as unknown as SessionTool[]).map((t) => [t.name, t])
    );
  });

  afterEach(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  /** The package's schedule, installed and approved, as a person left it. */
  function approvedSchedule(): Task {
    const parsed = parseSkillFile(filePath, SKILL, SkillFrontmatterSchema);
    if (!parsed.ok || !hasSchedule(parsed.definition.meta)) throw new Error('fixture unreadable');
    return store.upsertFromFile({
      ...parsed.definition,
      meta: parsed.definition.meta,
      scope: 'global',
      projectPath: undefined,
    });
  }

  /** Call a tool and parse its single JSON content block. */
  async function call(name: string, args: Record<string, unknown>) {
    const result = await tools[name]!.handler(args, undefined);
    return {
      isError: result.isError === true,
      payload: JSON.parse(result.content[0]!.text) as Record<string, unknown>,
    };
  }

  it('lands the agent’s timing, stops the schedule at once, and says so', async () => {
    // Purpose: this used to be refused outright; now it lands — and because no
    // sync will ever notice a row-only change, the tool itself has to park it.
    const task = approvedSchedule();

    const { isError, payload } = await call('tasks_update', { id: task.id, cron: '* * * * *' });

    expect(isError).toBe(false);
    expect(payload.schedule).toMatchObject({
      cron: '* * * * *',
      defaultCron: '0 9 * * *',
      status: 'pending_approval',
    });
    expect(payload).toMatchObject({ needsReapproval: true, note: TIMING_REAPPROVAL_NOTE });
    expect(vi.mocked(raiseStanding)).toHaveBeenCalledWith(
      'schedule.parked',
      expect.objectContaining({ taskId: task.id })
    );
    expect(await fs.readFile(filePath, 'utf-8')).toBe(SKILL);
  });

  it('parks a reset that changes when an approved schedule runs', async () => {
    // Purpose: going back to the package's timing is still a change to when
    // the approved work runs; an agent does not get to make it unseen.
    const task = approvedSchedule();
    store.updateTask(task.id, { cron: '30 7 * * *' }, { timingLandsOn: 'row' });
    store.recordApproval(task.id);

    const { payload } = await call('tasks_update', { id: task.id, resetTiming: true });

    expect(payload.schedule).toMatchObject({ cron: '0 9 * * *', status: 'pending_approval' });
    expect(payload.note).toBe(TIMING_REAPPROVAL_NOTE);
  });

  it('lets a timezone-only change through without asking again', async () => {
    // Purpose: the approval key has never included the timezone, and a package's
    // schedule must not be stricter than any other.
    const task = approvedSchedule();

    const { payload } = await call('tasks_update', { id: task.id, timezone: 'Asia/Tokyo' });

    expect(payload.schedule).toMatchObject({ timezone: 'Asia/Tokyo', status: 'active' });
    expect(payload.needsReapproval).toBeUndefined();
    expect(payload.note).not.toBe(REAPPROVAL_NOTE);
  });

  it('refuses a reset sent with a new timing, and changes nothing', async () => {
    // Purpose: two timings in one call; the tool must not pick one for the agent.
    const task = approvedSchedule();

    const { isError } = await call('tasks_update', {
      id: task.id,
      resetTiming: true,
      cron: '30 7 * * *',
    });

    expect(isError).toBe(true);
    expect(store.getTask(task.id)).toMatchObject({ cron: '0 9 * * *', status: 'active' });
  });

  it('still refuses a change to what it does', async () => {
    // Purpose: timing is the only new thing an agent may change here.
    const task = approvedSchedule();

    const { isError, payload } = await call('tasks_update', { id: task.id, prompt: 'Do more.' });

    expect(isError).toBe(true);
    expect(payload.code).toBe('schedule_package_owned');
  });
});
