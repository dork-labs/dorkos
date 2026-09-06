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

/**
 * The longest plan the panel will ever draw — ten rows, its own cap.
 *
 * The reason it is here: the panel sits between the transcript and the composer,
 * so every row it draws is a row of conversation it takes. At this length it
 * scrolls inside its own box instead of growing (DOR-1759), and that is only
 * visible with a plan this long.
 */
export const SAMPLE_LONG_PLAN: TaskItem[] = [
  createTaskItem({ subject: 'Read the existing auth module', status: 'completed' }),
  createTaskItem({ subject: 'Write down what changes', status: 'completed' }),
  createTaskItem({
    subject: 'Swap sessions for tokens',
    status: 'in_progress',
    activeForm: 'Swapping sessions for tokens',
  }),
  createTaskItem({ subject: 'Add token refresh', status: 'pending' }),
  createTaskItem({ subject: 'Update the middleware', status: 'pending' }),
  createTaskItem({ subject: 'Write unit tests for login', status: 'pending' }),
  createTaskItem({ subject: 'Write unit tests for refresh', status: 'pending' }),
  createTaskItem({ subject: 'Update the API docs', status: 'pending' }),
  createTaskItem({ subject: 'Check the migration path', status: 'pending' }),
  createTaskItem({ subject: 'Run the whole suite', status: 'pending' }),
];
