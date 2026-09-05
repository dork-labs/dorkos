import type { TaskItem } from '@dorkos/shared/types';
import { createTaskItem } from '../mock-factories';

/**
 * A todo list mid-run: one done, one in progress, two pending.
 *
 * @module dev/mock-samples/tasks
 */
export const SAMPLE_TASKS: TaskItem[] = [
  createTaskItem({
    subject: 'Set up project structure',
    status: 'completed',
    activeForm: 'Setting up project structure',
  }),
  createTaskItem({
    subject: 'Implement authentication service',
    status: 'in_progress',
    activeForm: 'Implementing authentication service',
    description: 'Add JWT-based auth with refresh tokens',
  }),
  createTaskItem({
    subject: 'Write unit tests for auth',
    status: 'pending',
    description: 'Cover login, logout, and token refresh flows',
  }),
  createTaskItem({
    subject: 'Add rate limiting middleware',
    status: 'pending',
  }),
];
