import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent, PermissionMode } from '@dorkos/shared/types';
import type { PendingInteraction } from './interactive-handlers.js';

/** In-memory state for an active agent session. */
export interface AgentSession {
  sdkSessionId: string;
  lastActivity: number;
  permissionMode: PermissionMode;
  model?: string;
  cwd?: string;
  /** True once the first SDK query has been sent (JSONL file exists) */
  hasStarted: boolean;
  /** Active SDK query object — used for mid-stream control (setPermissionMode, setModel) */
  activeQuery?: Query;
  pendingInteractions: Map<string, PendingInteraction>;
  eventQueue: StreamEvent[];
  eventQueueNotify?: () => void;
}

/** Mutable tool tracking state passed by reference into the event mapper. */
export interface ToolState {
  inTool: boolean;
  currentToolName: string;
  currentToolId: string;
  taskToolInput: string;
  appendTaskInput: (chunk: string) => void;
  resetTaskInput: () => void;
  setToolState: (tool: boolean, name: string, id: string) => void;
}

/** Create a fresh ToolState instance for a streaming loop. */
export function createToolState(): ToolState {
  let inTool = false;
  let currentToolName = '';
  let currentToolId = '';
  let taskToolInput = '';
  return {
    get inTool() { return inTool; },
    get currentToolName() { return currentToolName; },
    get currentToolId() { return currentToolId; },
    get taskToolInput() { return taskToolInput; },
    appendTaskInput: (chunk: string) => { taskToolInput += chunk; },
    resetTaskInput: () => { taskToolInput = ''; },
    setToolState: (tool: boolean, name: string, id: string) => {
      inTool = tool; currentToolName = name; currentToolId = id;
    },
  };
}
