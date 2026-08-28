/**
 * Where a task's runtime, model and effort live between the file and the row,
 * and what a run records about the ones it actually used (DOR-1615, DOR-1347).
 *
 * Two rules carry the weight here and neither is obvious. The FILE is the source
 * of truth for the three settings, so a key removed from the `schedule:` block
 * clears the row's override rather than leaving a stale one behind. And a RUN
 * stamps what it resolved to, not what the task says, so run history reports
 * what happened instead of re-reading a setting that may have changed since.
 *
 * @module services/tasks/__tests__/task-store-execution-fields
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { TaskStore } from '../task-store.js';

const FILE_PATH = `/home/u/.dork/tasks/sweeper/${SKILL_FILENAME}`;

/**
 * A parsed SKILL.md whose `schedule:` block carries the given execution fields.
 *
 * @param block - The `runtime`/`model`/`effort` keys this case is about.
 */
function definition(block: Record<string, unknown>) {
  return {
    name: 'sweeper',
    meta: {
      name: 'sweeper',
      description: 'Sweep the repo overnight',
      schedule: { cron: '0 3 * * *', timezone: 'UTC', enabled: true, ...block },
    },
    body: 'sweep it',
    filePath: FILE_PATH,
    dirPath: FILE_PATH.replace(`/${SKILL_FILENAME}`, ''),
    scope: 'global',
  } as Parameters<TaskStore['upsertFromFile']>[0];
}

describe('the execution trio, file → row', () => {
  let store: TaskStore;
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
  });

  it('carries all three off the block on INSERT', () => {
    const task = store.upsertFromFile(
      definition({ runtime: 'codex', model: 'gpt-5.5', effort: 'high' })
    );
    expect(task).toMatchObject({ runtime: 'codex', model: 'gpt-5.5', effort: 'high' });
  });

  it('leaves all three null for a block that names none', () => {
    // Null is "whatever this task's agent runs on" — the answer every schedule
    // had before these fields, and the one a task keeps by saying nothing.
    const task = store.upsertFromFile(definition({}));
    expect(task).toMatchObject({ runtime: null, model: null, effort: null });
  });

  it('carries a CHANGED block onto an existing row', () => {
    store.upsertFromFile(definition({ runtime: 'codex', model: 'gpt-5.5', effort: 'high' }));
    const updated = store.upsertFromFile(
      definition({ runtime: 'opencode', model: 'anthropic/claude-sonnet-4-5' })
    );
    expect(updated).toMatchObject({ runtime: 'opencode', model: 'anthropic/claude-sonnet-4-5' });
  });

  it('CLEARS an override the block no longer names', () => {
    // The discriminating case for "the file is the source of truth": an update
    // branch that only wrote fields it found would leave the old runtime behind,
    // and a person who deleted the line would keep running on Codex forever.
    store.upsertFromFile(definition({ runtime: 'codex', model: 'gpt-5.5', effort: 'high' }));
    const cleared = store.upsertFromFile(definition({}));
    expect(cleared).toMatchObject({ runtime: null, model: null, effort: null });
  });

  it('drops a stored effort rung this build cannot read, rather than passing it on', () => {
    // The column is free-form TEXT filled from a SKILL.md, so it can hold a rung
    // a later release removed. "No preference" is what null already means, and
    // it is a better answer than an `EffortLevel` an adapter silently ignores.
    store.upsertFromFile(definition({ effort: 'high' }));
    db.$client.prepare(`UPDATE pulse_schedules SET effort = 'ludicrous'`).run();
    expect(store.getTasks()[0]!.effort).toBeNull();
    // …and the neighbouring free-form columns are still read verbatim, so this
    // is a parse of one field and not a blanket refusal of the row.
    db.$client.prepare(`UPDATE pulse_schedules SET runtime = 'gemini'`).run();
    expect(store.getTasks()[0]!.runtime).toBe('gemini');
  });
});

describe('what a run records about what it ran on', () => {
  let store: TaskStore;
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
  });

  it('stamps the resolved runtime and model onto an open run', () => {
    const task = store.upsertFromFile(definition({}));
    const run = store.createRun(task.id, 'manual');

    store.recordRunExecution(run.id, { runtime: 'codex', model: 'gpt-5.5' });

    expect(store.getRun(run.id)).toMatchObject({
      resolvedRuntime: 'codex',
      resolvedModel: 'gpt-5.5',
    });
  });

  it('records "no model was chosen" as a real answer', () => {
    const task = store.upsertFromFile(definition({}));
    const run = store.createRun(task.id, 'manual');

    store.recordRunExecution(run.id, { runtime: 'claude-code' });

    expect(store.getRun(run.id)).toMatchObject({
      resolvedRuntime: 'claude-code',
      resolvedModel: null,
    });
  });

  it('lands on a run that has already reached a terminal status', () => {
    // Why this is its own method and not a widening of `updateRun`: that one
    // deliberately ignores a write to a finished run, and in-process relay
    // delivery runs an ENTIRE turn inside `publish()` — so a stamp on that path
    // would be silently dropped if it went through the lifecycle door.
    const task = store.upsertFromFile(definition({}));
    const run = store.createRun(task.id, 'manual');
    store.updateRun(run.id, { status: 'completed', finishedAt: new Date().toISOString() });

    store.recordRunExecution(run.id, { runtime: 'opencode', model: 'anthropic/claude-sonnet-4-5' });

    expect(store.getRun(run.id)).toMatchObject({
      status: 'completed',
      resolvedRuntime: 'opencode',
      resolvedModel: 'anthropic/claude-sonnet-4-5',
    });
  });

  it('reads null on a run recorded before the columns existed', () => {
    const task = store.upsertFromFile(definition({ runtime: 'codex' }));
    const run = store.createRun(task.id, 'manual');
    expect(store.getRun(run.id)).toMatchObject({ resolvedRuntime: null, resolvedModel: null });
  });
});
