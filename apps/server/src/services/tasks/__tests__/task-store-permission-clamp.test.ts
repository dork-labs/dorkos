/**
 * A SKILL.md on disk cannot hand a scheduled task every approval prompt turned
 * off.
 *
 * Isolated from `task-store.test.ts` because the whole file mocks the logger:
 * the downgrade is only honest if somebody is told it happened, so the warning
 * is part of the behaviour under test, not decoration around it.
 *
 * @module services/tasks/__tests__/task-store-permission-clamp
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { TaskStore } from '../task-store.js';
import { logger } from '../../../lib/logger.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const FILE_PATH = `/home/u/.dork/tasks/sweeper/${SKILL_FILENAME}`;

/** A parsed SKILL.md definition declaring `permissions`. */
function definition(permissions: string, filePath = FILE_PATH) {
  return {
    name: 'sweeper',
    meta: {
      name: 'sweeper',
      description: 'Sweep the repo overnight',
      cron: '0 3 * * *',
      timezone: 'UTC',
      enabled: true,
      permissions,
    },
    body: 'sweep it',
    filePath,
    dirPath: filePath.replace(`/${SKILL_FILENAME}`, ''),
    scope: 'global',
  } as Parameters<TaskStore['upsertFromFile']>[0];
}

describe('a task file cannot arm an unattended bypass run', () => {
  let store: TaskStore;
  let db: Db;

  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
    db = createTestDb();
    store = new TaskStore(db);
  });

  it('creates a file-declared bypassPermissions task with the normal prompts instead', () => {
    const task = store.upsertFromFile(definition('bypassPermissions'));

    expect(task.permissionMode).toBe('acceptEdits');
    // The row is armed either way — `enabled` defaults true and the insert
    // hardcodes `active` — so the mode is the whole of the protection.
    expect(task.enabled).toBe(true);
    expect(task.status).toBe('active');
  });

  it('says so, naming the file, so the downgrade is not silent', () => {
    store.upsertFromFile(definition('bypassPermissions'));

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn).mock.calls[0]?.[0]).toContain(FILE_PATH);
  });

  it('leaves acceptEdits alone, and says nothing', () => {
    const task = store.upsertFromFile(definition('acceptEdits'));

    expect(task.permissionMode).toBe('acceptEdits');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('carries every mode that still asks through untouched', () => {
    for (const mode of ['default', 'plan', 'dontAsk', 'auto']) {
      const filePath = `/home/u/.dork/tasks/${mode}/${SKILL_FILENAME}`;
      const task = store.upsertFromFile(definition(mode, filePath));
      expect(task.permissionMode).toBe(mode);
    }
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('cannot raise a task that was not already there by editing its file', () => {
    const created = store.upsertFromFile(definition('acceptEdits'));
    const raised = store.upsertFromFile(definition('bypassPermissions'));

    expect(raised.id).toBe(created.id);
    expect(raised.permissionMode).toBe('acceptEdits');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('keeps a bypass a person already granted through the cockpit', () => {
    const created = store.upsertFromFile(definition('bypassPermissions'));
    // What `PATCH /api/tasks/:id` does once the caller clears the agent bar:
    // the row is the record of a person's decision, and the file is rewritten
    // to match. The re-sync that follows must not undo it.
    store.updateTask(created.id, { permissionMode: 'bypassPermissions' });
    vi.mocked(logger.warn).mockClear();

    const resynced = store.upsertFromFile(definition('bypassPermissions'));

    expect(resynced.permissionMode).toBe('bypassPermissions');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stops repeating itself while the file keeps asking', () => {
    // The reconciler re-reads every task file every five minutes. One standing
    // refusal must not become 288 log lines a day.
    store.upsertFromFile(definition('bypassPermissions'));
    store.upsertFromFile(definition('bypassPermissions'));
    store.upsertFromFile(definition('bypassPermissions'));

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
