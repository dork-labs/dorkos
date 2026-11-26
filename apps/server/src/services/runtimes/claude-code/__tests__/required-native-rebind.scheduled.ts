/**
 * The scheduled chats the required-native rebind must carry across its rekey:
 * one beat whose chat is the source, and one task run on it (DOR-3703).
 */
import type { Db } from '@dorkos/db';
import { HeartbeatStore } from '../../../heartbeats/heartbeat-store.js';
import { TaskStore } from '../../../tasks/task-store.js';

/**
 * Seed one beat and one task run on `sessionId`.
 *
 * @param db - The fixture's database.
 * @param sessionId - The chat both name.
 * @returns The task store and the run, for the snapshot to read back.
 */
export function seedScheduledChats(db: Db, sessionId: string) {
  const beats = new HeartbeatStore(db);
  beats.insertBeat({
    id: 'real-beat',
    agentId: 'fixture-agent',
    startedAt: 'now',
    kind: 'pulse',
    wake: 'timer',
  });
  beats.setBeatChat('real-beat', sessionId);
  const tasks = new TaskStore(db);
  const task = tasks.createTask({
    name: 'Required rebind fixture',
    description: 'test',
    prompt: 'test',
    filePath: '/tmp/4328-required-rebind/SKILL.md',
  });
  const run = tasks.createRun(task.id, 'manual');
  tasks.updateRun(run.id, { sessionId });
  return { tasks, run };
}
