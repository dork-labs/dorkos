/**
 * Session services — transcript reading/parsing, session broadcasting,
 * locking, and task state management.
 *
 * @module services/session
 */
export { TASK_TOOL_NAMES, buildTaskEvent } from './build-task-event.js';
export { SessionBroadcaster } from './session-broadcaster.js';
export { SessionLockManager } from './session-lock.js';
export { parseTasks } from './task-reader.js';
export {
  extractToolResultContent,
  extractTextContent,
  extractCommandMeta,
  stripSystemTags,
  mapSdkAnswersToIndices,
  parseQuestionAnswers,
  parseTranscript,
} from './transcript-parser.js';
export type { TranscriptLine, ContentBlock } from './transcript-parser.js';
export { TranscriptReader, transcriptReader } from './transcript-reader.js';
export type { HistoryMessage, HistoryToolCall } from './transcript-reader.js';
