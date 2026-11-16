/** Dependencies for the scheduled-task HTTP routes. */
import type { MeshCore } from '@dorkos/mesh';
import type { ActivityService } from '../services/activity/activity-service.js';
import type { TaskRegistrar } from '../services/tasks/task-registrar.js';
import type { TaskSchedulerService } from '../services/tasks/task-scheduler-service.js';
import type { TaskStore } from '../services/tasks/task-store.js';
import type { TaskTimezoneDeps } from '../services/tasks/lifecycle/default-timezone.js';

/** What the Tasks routes read, handed over when Tasks starts. */
export interface TasksRouterDeps extends TaskTimezoneDeps {
  /** Task data persistence. */
  store: TaskStore;
  /** Dispatch and run-time queries. */
  scheduler: TaskSchedulerService;
  /** The seam that turns a task row into a live cron job. */
  registrar: TaskRegistrar;
  /** Resolved data directory path. */
  dorkHome: string;
  /** Resolves agent project paths; absent when Mesh is disabled. */
  meshCore?: MeshCore;
  /** Where task writes are recorded; absent in tests that do not watch it. */
  activity?: ActivityService;
}
