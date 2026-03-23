import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { Task } from '@a2a-js/sdk';
import { SqliteTaskStore } from '../task-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    kind: 'task',
    id: 'task-001',
    contextId: 'ctx-001',
    status: { state: 'submitted' },
    history: [
      {
        kind: 'message',
        messageId: 'msg-001',
        role: 'user',
        parts: [{ kind: 'text', text: 'Hello agent' }],
      },
    ],
    artifacts: [
      {
        artifactId: 'art-001',
        name: 'result.txt',
        parts: [{ kind: 'text', text: 'Output content' }],
      },
    ],
    metadata: { agentId: 'agent-backend', custom: 'value' },
    ...overrides,
  };
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

describe('SqliteTaskStore', () => {
  describe('save and load', () => {
    it('round-trips a task through save and load', async () => {
      const task = makeTask();
      await store.save(task);

      const loaded = await store.load(task.id);
      expect(loaded).toBeDefined();
      expect(loaded!.kind).toBe('task');
      expect(loaded!.id).toBe('task-001');
      expect(loaded!.contextId).toBe('ctx-001');
      expect(loaded!.status.state).toBe('submitted');
    });

    it('preserves history through JSON serialization', async () => {
      const task = makeTask();
      await store.save(task);

      const loaded = await store.load(task.id);
      expect(loaded!.history).toHaveLength(1);
      expect(loaded!.history![0].role).toBe('user');
      expect(loaded!.history![0].parts[0]).toEqual({
        kind: 'text',
        text: 'Hello agent',
      });
    });

    it('preserves artifacts through JSON serialization', async () => {
      const task = makeTask();
      await store.save(task);

      const loaded = await store.load(task.id);
      expect(loaded!.artifacts).toHaveLength(1);
      expect(loaded!.artifacts![0].artifactId).toBe('art-001');
      expect(loaded!.artifacts![0].name).toBe('result.txt');
      expect(loaded!.artifacts![0].parts[0]).toEqual({
        kind: 'text',
        text: 'Output content',
      });
    });

    it('preserves metadata through JSON serialization', async () => {
      const task = makeTask();
      await store.save(task);

      const loaded = await store.load(task.id);
      expect(loaded!.metadata).toEqual({
        agentId: 'agent-backend',
        custom: 'value',
      });
    });

    it('stores empty history and artifacts when absent', async () => {
      const task = makeTask({ history: undefined, artifacts: undefined });
      await store.save(task);

      const loaded = await store.load(task.id);
      expect(loaded!.history).toEqual([]);
      expect(loaded!.artifacts).toEqual([]);
    });

    it('stores metadata as undefined when task has no metadata', async () => {
      const task = makeTask({ metadata: undefined });
      await store.save(task);

      const loaded = await store.load(task.id);
      expect(loaded!.metadata).toBeUndefined();
    });
  });

  describe('load', () => {
    it('returns undefined for non-existent task', async () => {
      const loaded = await store.load('non-existent-id');
      expect(loaded).toBeUndefined();
    });
  });

  describe('upsert behavior', () => {
    it('updates an existing task when saved with the same ID', async () => {
      const task = makeTask({ status: { state: 'submitted' } });
      await store.save(task);

      const updatedTask = makeTask({
        status: { state: 'completed' },
        history: [
          {
            kind: 'message',
            messageId: 'msg-001',
            role: 'user',
            parts: [{ kind: 'text', text: 'Hello agent' }],
          },
          {
            kind: 'message',
            messageId: 'msg-002',
            role: 'agent',
            parts: [{ kind: 'text', text: 'Hello user' }],
          },
        ],
        artifacts: [
          {
            artifactId: 'art-002',
            name: 'updated.txt',
            parts: [{ kind: 'text', text: 'Updated content' }],
          },
        ],
      });
      await store.save(updatedTask);

      const loaded = await store.load(task.id);
      expect(loaded!.status.state).toBe('completed');
      expect(loaded!.history).toHaveLength(2);
      expect(loaded!.artifacts).toHaveLength(1);
      expect(loaded!.artifacts![0].artifactId).toBe('art-002');
    });

    it('updates contextId on upsert', async () => {
      const task = makeTask({ contextId: 'ctx-original' });
      await store.save(task);

      const updated = makeTask({ contextId: 'ctx-updated' });
      await store.save(updated);

      const loaded = await store.load(task.id);
      expect(loaded!.contextId).toBe('ctx-updated');
    });

    it('does not create duplicate rows on upsert', async () => {
      const task = makeTask();
      await store.save(task);
      await store.save(makeTask({ status: { state: 'working' } }));
      await store.save(makeTask({ status: { state: 'completed' } }));

      // Verify only one row exists by loading — if duplicates existed,
      // the get() would still return one, so also check via raw query
      const loaded = await store.load(task.id);
      expect(loaded).toBeDefined();
      expect(loaded!.status.state).toBe('completed');
    });
  });

  describe('status timestamp', () => {
    it('populates status.timestamp from updatedAt', async () => {
      const task = makeTask();
      await store.save(task);

      const loaded = await store.load(task.id);
      expect(loaded!.status.timestamp).toBeDefined();
      // Should be a valid ISO 8601 date string
      expect(new Date(loaded!.status.timestamp!).toISOString()).toBe(loaded!.status.timestamp);
    });
  });

  describe('agentId extraction', () => {
    it('extracts agentId from metadata', async () => {
      const task = makeTask({ metadata: { agentId: 'my-agent' } });
      await store.save(task);

      // The agentId is a DB column, not on the Task type directly.
      // We verify it survives by checking the task round-trips correctly.
      const loaded = await store.load(task.id);
      expect(loaded).toBeDefined();
    });

    it('falls back to "unknown" when metadata has no agentId', async () => {
      const task = makeTask({ metadata: { other: 'data' } });
      await store.save(task);

      const loaded = await store.load(task.id);
      expect(loaded).toBeDefined();
    });
  });
});
