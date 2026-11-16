/** Dependencies shared by every scheduled-task create door. */
import type { MeshCore } from '@dorkos/mesh';
import type { TaskStore } from '../task-store.js';
import type { TaskRegistrar } from '../task-registrar.js';
import type { TaskTimezoneDeps } from './default-timezone.js';

/** The collaborators a create needs. Every one is required to get a task right. */
export interface TaskLifecycleDeps extends TaskTimezoneDeps {
  /** Where the derived row is written. */
  store: TaskStore;
  /**
   * The seam that turns a row into a live cron job. Null before the scheduler
   * exists and during boot, which is not a reason to fail a create.
   */
  registrar: TaskRegistrar | null;
  /** The resolved data directory, for the `global` skills root. */
  dorkHome: string;
  /** Resolves an agent id to its project path. Absent when Mesh is disabled. */
  meshCore?: MeshCore;
}
