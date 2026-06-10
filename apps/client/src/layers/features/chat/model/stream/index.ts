/**
 * Stream event handling — SSE message parsing, history reconstruction, and error classification.
 *
 * @module features/chat/model/stream
 */
export { createStreamEventHandler } from './stream-event-handler';
export type {
  StreamEventDeps,
  StreamingTextPart,
  StreamHandlerHelpers,
} from './stream-event-types';
export { createStreamHelpers, deriveFromParts } from './stream-event-helpers';
export { mapHistoryMessage, reconcileTaggedMessages } from './stream-history-helpers';
export { StreamManager, streamManager } from './stream-manager';
export type { StartStreamOptions } from './stream-manager';
export {
  handleToolCallStart,
  handleToolCallDelta,
  handleToolProgress,
  handleToolCallEnd,
  handleToolResult,
  handleApprovalRequired,
  handleQuestionPrompt,
  handleElicitationPrompt,
  handleElicitationComplete,
  handleSubagentStarted,
  handleSubagentProgress,
  handleSubagentDone,
  handleHookStarted,
  handleHookProgress,
  handleHookResponse,
} from './stream-tool-handlers';
export { classifyTransportError } from './classify-transport-error';
