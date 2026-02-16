/**
 * Type re-exports — all types derived from Zod schemas in `schemas.ts`.
 *
 * Import types from this module (`@dorkos/shared/types`) for consuming code.
 * Import schemas from `@dorkos/shared/schemas` when you need runtime validation.
 *
 * @module shared/types
 */
export type {
  PermissionMode,
  Session,
  CreateSessionRequest,
  UpdateSessionRequest,
  SendMessageRequest,
  StreamEventType,
  StreamEvent,
  TextDelta,
  ToolCallEvent,
  ApprovalEvent,
  QuestionOption,
  QuestionItem,
  QuestionPromptEvent,
  ErrorEvent,
  DoneEvent,
  SessionStatusEvent,
  TextPart,
  ToolCallPart,
  MessagePart,
  MessageType,
  HistoryMessage,
  HistoryToolCall,
  TaskStatus,
  TaskItem,
  TaskUpdateEvent,
  BrowseDirectoryResponse,
  DirectoryEntry,
  CommandEntry,
  CommandRegistry,
  FileListQuery,
  FileListResponse,
  HealthResponse,
  TunnelStatus,
  ServerConfig,
  GitStatusResponse,
  GitStatusError,
  SessionLockedError,
  ConfigPatchRequest,
  ConfigPatchResponse,
} from './schemas.js';
