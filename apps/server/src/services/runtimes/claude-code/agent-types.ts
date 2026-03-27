import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent, PermissionMode, UiState } from '@dorkos/shared/types';
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
  /** True when auto-created by updateSession — sendMessage should check transcript before first query. */
  needsTranscriptCheck?: boolean;
  /** Active SDK query object — used for mid-stream control (setPermissionMode, setModel) */
  activeQuery?: Query;
  pendingInteractions: Map<string, PendingInteraction>;
  eventQueue: StreamEvent[];
  eventQueueNotify?: () => void;
  /** Client-reported UI state, updated with each message. Used by `get_ui_state` tool. */
  uiState?: UiState;
}

/** Mutable tool tracking state passed by reference into the event mapper. */
export interface ToolState {
  inTool: boolean;
  currentToolName: string;
  currentToolId: string;
  taskToolInput: string;
  inThinking: boolean;
  thinkingStartMs: number;
  /** Lookup table mapping tool_use block IDs to tool names for result correlation. */
  toolNameById: Map<string, string>;
  /** Tool IDs whose results were already delivered via tool_use_summary. */
  resolvedResultIds: Set<string>;
  /** Tool IDs that received at least one input_json_delta during streaming. */
  toolInputReceived: Set<string>;
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
  let inThinking = false;
  let thinkingStartMs = 0;
  const toolNameById = new Map<string, string>();
  const resolvedResultIds = new Set<string>();
  const toolInputReceived = new Set<string>();
  return {
    get inTool() {
      return inTool;
    },
    get currentToolName() {
      return currentToolName;
    },
    get currentToolId() {
      return currentToolId;
    },
    get taskToolInput() {
      return taskToolInput;
    },
    get inThinking() {
      return inThinking;
    },
    set inThinking(v: boolean) {
      inThinking = v;
    },
    get thinkingStartMs() {
      return thinkingStartMs;
    },
    set thinkingStartMs(v: number) {
      thinkingStartMs = v;
    },
    toolNameById,
    resolvedResultIds,
    toolInputReceived,
    appendTaskInput: (chunk: string) => {
      taskToolInput += chunk;
    },
    resetTaskInput: () => {
      taskToolInput = '';
    },
    setToolState: (tool: boolean, name: string, id: string) => {
      inTool = tool;
      currentToolName = name;
      currentToolId = id;
    },
  };
}
