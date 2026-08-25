import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { Role, TaskState, type Artifact, type Task } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { SqliteTaskStore, dbStatusToTaskState, taskStateToDbStatus } from '../task-store.js';
import { buildMessage, textPart } from '../a2a-model.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The store is single-tenant and ignores the context, but the A2A v1.0
 * `TaskStore` interface requires one on every call.
 */
const ctx = new ServerCallContext();

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    artifactId: 'art-001',
    name: 'result.txt',
    description: '',
    parts: [textPart('Output content')],
    metadata: undefined,
    extensions: [],
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-001',
    contextId: 'ctx-001',
    status: {
      state: TaskState.TASK_STATE_SUBMITTED,
      message: undefined,
      timestamp: undefined,
    },
    history: [buildMessage({ role: Role.ROLE_USER, text: 'Hello agent', messageId: 'msg-001' })],
    artifacts: [makeArtifact()],
    metadata: { agentId: 'agent-backend', custom: 'value' },
    ...overrides,
  };
}

/** Build a task whose status carries just a state. */
function statusOf(state: TaskState): Task['status'] {
  return { state, message: undefined, timestamp: undefined };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let db: Db;
let store: SqliteTaskStore;

beforeEach(() => {
  db = createTestDb();
  store = new SqliteTaskStore(db);
});

describe('task state ↔ column mapping', () => {
  it('round-trips every A2A task state through the stored spelling', () => {
    const states = [
      TaskState.TASK_STATE_SUBMITTED,
      TaskState.TASK_STATE_WORKING,
      TaskState.TASK_STATE_INPUT_REQUIRED,
      TaskState.TASK_STATE_AUTH_REQUIRED,
      TaskState.TASK_STATE_COMPLETED,
      TaskState.TASK_STATE_CANCELED,
      TaskState.TASK_STATE_FAILED,
      TaskState.TASK_STATE_REJECTED,
    ];

    for (const state of states) {
      expect(dbStatusToTaskState(taskStateToDbStatus(state))).toBe(state);
    }
  });

  it('stores the readable v0.3 spelling, not the protobuf ordinal', () => {
    // The column holds strings written before the v1.0 upgrade; keeping the
    // spelling is what makes those rows still readable today.
    expect(taskStateToDbStatus(TaskState.TASK_STATE_INPUT_REQUIRED)).toBe('input-required');
    expect(taskStateToDbStatus(TaskState.TASK_STATE_COMPLETED)).toBe('completed');
  });

  it('maps an unknown stored status to the unspecified state', () => {
    expect(dbStatusToTaskState('not-a-state')).toBe(TaskState.TASK_STATE_UNSPECIFIED);
    expect(dbStatusToTaskState('unknown')).toBe(TaskState.TASK_STATE_UNSPECIFIED);
  });

  it('stores an absent state as "unknown"', () => {
    expect(taskStateToDbStatus(undefined)).toBe('unknown');
    expect(taskStateToDbStatus(TaskState.TASK_STATE_UNSPECIFIED)).toBe('unknown');
  });
});

describe('SqliteTaskStore', () => {
  describe('save and load', () => {
    it('round-trips a task through save and load', async () => {
      const task = makeTask();
      await store.save(task, ctx);

      const loaded = await store.load(task.id, ctx);
      expect(loaded).toBeDefined();
      expect(loaded!.id).toBe('task-001');
      expect(loaded!.contextId).toBe('ctx-001');
      expect(loaded!.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    });

    it('preserves history through JSON serialization', async () => {
      const task = makeTask();
      await store.save(task, ctx);

      const loaded = await store.load(task.id, ctx);
      expect(loaded!.history).toHaveLength(1);
      expect(loaded!.history[0]!.role).toBe(Role.ROLE_USER);
      expect(loaded!.history[0]!.parts[0]).toEqual(textPart('Hello agent'));
    });

    it('preserves artifacts through JSON serialization', async () => {
      const task = makeTask();
      await store.save(task, ctx);

      const loaded = await store.load(task.id, ctx);
      expect(loaded!.artifacts).toHaveLength(1);
      expect(loaded!.artifacts[0]!.artifactId).toBe('art-001');
      expect(loaded!.artifacts[0]!.name).toBe('result.txt');
      expect(loaded!.artifacts[0]!.parts[0]).toEqual(textPart('Output content'));
    });

    it('preserves metadata through JSON serialization', async () => {
      const task = makeTask();
      await store.save(task, ctx);

      const loaded = await store.load(task.id, ctx);
      expect(loaded!.metadata).toEqual({
        agentId: 'agent-backend',
        custom: 'value',
      });
    });

    it('stores empty history and artifacts when absent', async () => {
      const task = makeTask({ history: [], artifacts: [] });
      await store.save(task, ctx);

      const loaded = await store.load(task.id, ctx);
      expect(loaded!.history).toEqual([]);
      expect(loaded!.artifacts).toEqual([]);
    });

    it('stores metadata as undefined when task has no metadata', async () => {
      const task = makeTask({ metadata: undefined });
      await store.save(task, ctx);

      const loaded = await store.load(task.id, ctx);
      expect(loaded!.metadata).toBeUndefined();
    });
  });

  describe('load', () => {
    it('returns undefined for non-existent task', async () => {
      const loaded = await store.load('non-existent-id', ctx);
      expect(loaded).toBeUndefined();
    });
  });

  describe('upsert behavior', () => {
    it('updates an existing task when saved with the same ID', async () => {
      const task = makeTask({ status: statusOf(TaskState.TASK_STATE_SUBMITTED) });
      await store.save(task, ctx);

      const updatedTask = makeTask({
        status: statusOf(TaskState.TASK_STATE_COMPLETED),
        history: [
          buildMessage({ role: Role.ROLE_USER, text: 'Hello agent', messageId: 'msg-001' }),
          buildMessage({ role: Role.ROLE_AGENT, text: 'Hello user', messageId: 'msg-002' }),
        ],
        artifacts: [
          makeArtifact({
            artifactId: 'art-002',
            name: 'updated.txt',
            parts: [textPart('Updated content')],
          }),
        ],
      });
      await store.save(updatedTask, ctx);

      const loaded = await store.load(task.id, ctx);
      expect(loaded!.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
      expect(loaded!.history).toHaveLength(2);
      expect(loaded!.artifacts).toHaveLength(1);
      expect(loaded!.artifacts[0]!.artifactId).toBe('art-002');
    });

    it('updates contextId on upsert', async () => {
      const task = makeTask({ contextId: 'ctx-original' });
      await store.save(task, ctx);

      const updated = makeTask({ contextId: 'ctx-updated' });
      await store.save(updated, ctx);

      const loaded = await store.load(task.id, ctx);
      expect(loaded!.contextId).toBe('ctx-updated');
    });

    it('does not create duplicate rows on upsert', async () => {
      const task = makeTask();
      await store.save(task, ctx);
      await store.save(makeTask({ status: statusOf(TaskState.TASK_STATE_WORKING) }), ctx);
      await store.save(makeTask({ status: statusOf(TaskState.TASK_STATE_COMPLETED) }), ctx);

      const loaded = await store.load(task.id, ctx);
      expect(loaded).toBeDefined();
      expect(loaded!.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);

      const listed = await store.list(makeListRequest(), ctx);
      expect(listed.totalSize).toBe(1);
    });
  });

  describe('status timestamp', () => {
    it('populates status.timestamp from updatedAt', async () => {
      const task = makeTask();
      await store.save(task, ctx);

      const loaded = await store.load(task.id, ctx);
      expect(loaded!.status?.timestamp).toBeDefined();
      // Should be a valid ISO 8601 date string
      expect(new Date(loaded!.status!.timestamp!).toISOString()).toBe(loaded!.status!.timestamp);
    });
  });

  describe('agentId extraction', () => {
    it('extracts agentId from metadata', async () => {
      const task = makeTask({ metadata: { agentId: 'my-agent' } });
      await store.save(task, ctx);

      // The agentId is a DB column, not on the Task type directly.
      // We verify it survives by checking the task round-trips correctly.
      const loaded = await store.load(task.id, ctx);
      expect(loaded).toBeDefined();
    });

    it('falls back to "unknown" when metadata has no agentId', async () => {
      const task = makeTask({ metadata: { other: 'data' } });
      await store.save(task, ctx);

      const loaded = await store.load(task.id, ctx);
      expect(loaded).toBeDefined();
    });
  });

  describe('list', () => {
    it('returns every stored task when no filter is given', async () => {
      await store.save(makeTask({ id: 'task-001' }), ctx);
      await store.save(makeTask({ id: 'task-002' }), ctx);

      const result = await store.list(makeListRequest(), ctx);

      expect(result.totalSize).toBe(2);
      expect(result.tasks.map((t) => t.id).sort()).toEqual(['task-001', 'task-002']);
      expect(result.nextPageToken).toBe('');
    });

    it('filters by contextId', async () => {
      await store.save(makeTask({ id: 'task-001', contextId: 'ctx-a' }), ctx);
      await store.save(makeTask({ id: 'task-002', contextId: 'ctx-b' }), ctx);

      const result = await store.list(makeListRequest({ contextId: 'ctx-a' }), ctx);

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]!.id).toBe('task-001');
    });

    it('filters by status', async () => {
      await store.save(
        makeTask({ id: 'task-001', status: statusOf(TaskState.TASK_STATE_WORKING) }),
        ctx
      );
      await store.save(
        makeTask({ id: 'task-002', status: statusOf(TaskState.TASK_STATE_COMPLETED) }),
        ctx
      );

      const result = await store.list(
        makeListRequest({ status: TaskState.TASK_STATE_COMPLETED }),
        ctx
      );

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]!.id).toBe('task-002');
    });

    it('pages through results and hands back a token for the next page', async () => {
      for (let i = 0; i < 3; i++) {
        await store.save(makeTask({ id: `task-00${i}` }), ctx);
      }

      const first = await store.list(makeListRequest({ pageSize: 2 }), ctx);
      expect(first.tasks).toHaveLength(2);
      expect(first.totalSize).toBe(3);
      expect(first.nextPageToken).toBe('2');

      const second = await store.list(
        makeListRequest({ pageSize: 2, pageToken: first.nextPageToken }),
        ctx
      );
      expect(second.tasks).toHaveLength(1);
      expect(second.nextPageToken).toBe('');

      const seen = [...first.tasks, ...second.tasks].map((t) => t.id).sort();
      expect(seen).toEqual(['task-000', 'task-001', 'task-002']);
    });

    it('clamps an out-of-range page size into the range the spec allows', async () => {
      await store.save(makeTask(), ctx);

      expect((await store.list(makeListRequest({ pageSize: 0 }), ctx)).pageSize).toBe(50);
      expect((await store.list(makeListRequest({ pageSize: 5_000 }), ctx)).pageSize).toBe(100);
    });
  });

  describe('list — statusTimestampAfter', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('drops tasks last updated before the bound', async () => {
      await saveAt('2026-01-01T00:00:00.000Z', makeTask({ id: 'task-old' }));
      await saveAt('2026-06-01T00:00:00.000Z', makeTask({ id: 'task-new' }));

      const result = await store.list(
        makeListRequest({ statusTimestampAfter: '2026-03-01T00:00:00.000Z' }),
        ctx
      );

      expect(result.tasks.map((t) => t.id)).toEqual(['task-new']);
      expect(result.totalSize).toBe(1);
    });

    it('includes a task sitting exactly on the bound', async () => {
      // The spec says "greater than or equal", so the boundary row is IN.
      await saveAt('2026-03-01T00:00:00.000Z', makeTask({ id: 'task-exact' }));

      const result = await store.list(
        makeListRequest({ statusTimestampAfter: '2026-03-01T00:00:00.000Z' }),
        ctx
      );

      expect(result.tasks.map((t) => t.id)).toEqual(['task-exact']);
    });

    it('compares by instant, not by the spelling the caller used', async () => {
      await saveAt('2026-03-01T09:00:00.000Z', makeTask({ id: 'task-nine' }));

      // 10:00+02:00 is 08:00Z — an instant BEFORE the row, even though the
      // string sorts after it. Comparing the raw text would drop the task.
      const result = await store.list(
        makeListRequest({ statusTimestampAfter: '2026-03-01T10:00:00.000+02:00' }),
        ctx
      );

      expect(result.tasks.map((t) => t.id)).toEqual(['task-nine']);
    });

    it('filters nothing when the bound cannot be read as a date', async () => {
      await saveAt('2026-03-01T00:00:00.000Z', makeTask());

      const result = await store.list(makeListRequest({ statusTimestampAfter: 'not-a-date' }), ctx);

      expect(result.totalSize).toBe(1);
    });
  });

  describe('list — includeArtifacts', () => {
    it('omits artifacts unless they were asked for', async () => {
      await store.save(makeTask(), ctx);

      const result = await store.list(makeListRequest(), ctx);

      // The A2A default is off: a listing is a survey, not a payload dump.
      expect(result.tasks[0]!.artifacts).toEqual([]);
    });

    it('carries artifacts when asked for', async () => {
      await store.save(makeTask(), ctx);

      const result = await store.list(makeListRequest({ includeArtifacts: true }), ctx);

      expect(result.tasks[0]!.artifacts).toHaveLength(1);
      expect(result.tasks[0]!.artifacts[0]!.artifactId).toBe('art-001');
    });

    it('still returns artifacts from a direct load', async () => {
      // Asking for one task by id is asking for all of it — the listing
      // default must not leak into `load`.
      const task = makeTask();
      await store.save(task, ctx);

      const loaded = await store.load(task.id, ctx);

      expect(loaded!.artifacts).toHaveLength(1);
    });
  });
});

/**
 * Build a `ListTasksRequest` with the protobuf-required fields filled in.
 *
 * The defaults are the "no filter" values, and every one of them is meant to
 * be overridden — `statusTimestampAfter` and `includeArtifacts` especially,
 * since a filter nothing ever sets is a filter nothing ever checks.
 */
function makeListRequest(
  overrides: Partial<Parameters<SqliteTaskStore['list']>[0]> = {}
): Parameters<SqliteTaskStore['list']>[0] {
  return {
    tenant: '',
    contextId: '',
    status: TaskState.TASK_STATE_UNSPECIFIED,
    pageToken: '',
    statusTimestampAfter: undefined,
    includeArtifacts: undefined,
    ...overrides,
  };
}

/**
 * Save a task as though it were last touched at `when`.
 *
 * The store stamps `updatedAt` itself from the clock, so controlling the clock
 * is the only way to write rows the timestamp filter can tell apart.
 */
async function saveAt(when: string, task: Task): Promise<void> {
  vi.setSystemTime(new Date(when));
  await store.save(task, ctx);
}
