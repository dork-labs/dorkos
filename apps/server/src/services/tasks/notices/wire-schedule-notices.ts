/**
 * Wire schedule reports after rooms and Mesh exist, before the scheduler starts.
 * @module services/tasks/notices/wire-schedule-notices
 */
import type { MeshCore } from '@dorkos/mesh';
import type { TaskStore } from '../task-store.js';
import { configManager } from '../../core/config-manager.js';
import { ScheduleNotices } from './schedule-notices.js';
import { scheduleNoticeRoom, type ScheduleNoticeRoomDeps } from './schedule-notice-room.js';

/** Build the live writer from the server's existing room subsystem. */
export function wireScheduleNotices(
  deps: Omit<ScheduleNoticeRoomDeps, 'owner'> & {
    taskStore: TaskStore;
    mesh?: MeshCore | null;
    operatorAuthorId: () => string;
  }
): void {
  const post = scheduleNoticeRoom({
    ...deps,
    owner: (snapshot) => {
      const task = deps.taskStore.getTask(snapshot.id);
      if (!task) return null;
      const agent = task.agentId ? deps.mesh?.get(task.agentId) : null;
      const path = task.agentId
        ? (deps.mesh?.getProjectPath(task.agentId) ?? null)
        : task.proposedByAgentPath;
      if (task.agentId && (!agent || !path)) return null; // Removed owners never report as another agent.
      if (path) {
        const owner = agent ?? deps.mesh?.listWithPaths().find((a) => a.projectPath === path);
        return owner ? { path, name: owner.displayName ?? owner.name } : null;
      }
      // A person's global schedule has no agent. Its private fallback uses the
      // same default teammate as their direct chat, without impersonating it.
      const defaultName = configManager.getAll().agents.defaultAgent;
      const agents = deps.mesh?.listWithPaths() ?? [];
      const fallback =
        agents.find((a) => a.name === defaultName) ?? agents.find((a) => a.name === 'dorkbot');
      return {
        path: fallback?.projectPath ?? null,
        name: fallback?.name ?? 'Agent',
        authorId: deps.operatorAuthorId(),
      };
    },
  });
  new ScheduleNotices({
    store: deps.taskStore,
    post,
    timezone: () => configManager.getAll().profile.timezone,
  }).observe();
}
