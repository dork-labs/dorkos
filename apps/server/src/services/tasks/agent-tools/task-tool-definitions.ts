/**
 * The five `tasks_*` tools as plain definitions: name, description, raw input
 * shape and handler. The capabilities in `task-agent-capabilities.ts` run them
 * per call with the caller the registry verified (C9a). Plain data: no
 * runtime's SDK reaches this folder.
 *
 * @module services/tasks/agent-tools/task-tool-definitions
 */
import type { z } from 'zod';
import type {
  AgentToolDeps,
  TaskProvenanceResolver,
} from '../../core/agent-tool-kit/agent-tool-kit.js';
import { createCreateScheduleHandler, createUpdateScheduleHandler } from './task-tools.js';
import { createDeleteScheduleHandler } from './task-delete-tool.js';
import {
  createGetRunHistoryHandler,
  createListSchedulesHandler,
  type CallerAgentResolver,
  type CallerMarksResolver,
} from './task-tool-parts.js';
import { callingTurnIsFull } from './task-tool-cross-agent.js';
import {
  CREATE_TASK_INPUT,
  DELETE_TASK_INPUT,
  LIST_TASKS_INPUT,
  RUN_HISTORY_INPUT,
  UPDATE_TASK_INPUT,
} from './task-tool-inputs.js';
import {
  TASKS_CREATE_DESCRIPTION,
  TASKS_DELETE_DESCRIPTION,
  TASKS_LIST_DESCRIPTION,
  TASKS_RUN_HISTORY_DESCRIPTION,
  TASKS_UPDATE_DESCRIPTION,
} from './task-tool-copy.js';

/** One tasks tool as a plain definition: its name, words, raw input shape and handler. */
export interface TaskToolDefinition {
  /** The MCP tool name, which the capability keeps and is gated by. */
  readonly name: string;
  /** The model-facing description. */
  readonly description: string;
  /** The raw input shape, which the capability's input object is built from. */
  readonly inputSchema: z.ZodRawShape;
  /** The handler, answering with the MCP envelope. */
  readonly handler: (args: never) => Promise<TaskToolResult>;
}

/** What a tasks handler answers: JSON text, flagged on failure, sometimes structured too. */
export type TaskToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

/**
 * The Tasks tool definitions: name, description, input schema, and handler.
 *
 * The capabilities in `task-agent-capabilities.ts` are built from these, and
 * run them per call with the caller the registry verified, on both MCP servers
 * (C9a). Plain data: no runtime's SDK reaches this folder.
 *
 * @param deps - Shared MCP tool dependencies.
 * @param resolveProvenance - How `tasks_create` learns which session is
 *   proposing. Omitted for the sessionless external `/mcp` server, where a
 *   proposal genuinely has no session behind it and provenance stays null.
 * @param callerMarks - The external caller's turn marks.
 * @param callerAgent - The external caller's verified home.
 */
export function getTasksTools(
  deps: AgentToolDeps,
  resolveProvenance?: TaskProvenanceResolver,
  callerMarks?: CallerMarksResolver,
  callerAgent?: CallerAgentResolver
): TaskToolDefinition[] {
  const define = <A>(
    name: string,
    description: string,
    inputSchema: z.ZodRawShape,
    handler: (args: A) => Promise<TaskToolResult>
  ): TaskToolDefinition => ({ name, description, inputSchema, handler: handler as never });
  return [
    define(
      'tasks_list',
      TASKS_LIST_DESCRIPTION,
      LIST_TASKS_INPUT,
      createListSchedulesHandler(deps)
    ),
    define(
      'tasks_create',
      TASKS_CREATE_DESCRIPTION,
      CREATE_TASK_INPUT,
      createCreateScheduleHandler(deps, resolveProvenance, callerMarks, callerAgent)
    ),
    define(
      'tasks_update',
      TASKS_UPDATE_DESCRIPTION,
      UPDATE_TASK_INPUT,
      createUpdateScheduleHandler(deps, resolveProvenance, callerMarks, callerAgent)
    ),
    define(
      'tasks_delete',
      TASKS_DELETE_DESCRIPTION,
      DELETE_TASK_INPUT,
      createDeleteScheduleHandler(deps)
    ),
    define(
      'tasks_get_run_history',
      TASKS_RUN_HISTORY_DESCRIPTION,
      RUN_HISTORY_INPUT,
      // Another agent's runs only from a Full, unmarked turn, as its edits (DOR-4600).
      createGetRunHistoryHandler(deps, resolveProvenance, () =>
        callingTurnIsFull(resolveProvenance, callerAgent)
      )
    ),
  ];
}
