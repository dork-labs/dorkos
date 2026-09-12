/**
 * The browser driver seat: which window a driving command reaches, what it is
 * allowed to name, and what comes back (spec `canvas-agent-seat` §2).
 *
 * @module services/session/browser-seat
 */
export {
  DRIVING_SAFETY_SENTENCE,
  drivingTimeoutNote,
  NO_DRIVER_NOTE,
  NO_PREVIEW_NOTE,
  NOT_INSTRUMENTED_NOTE,
  UNKNOWN_DOCUMENT_NOTE,
  type SessionEventSink,
} from './act-protocol.js';
export {
  DOCUMENT_INPUT,
  TARGET_INPUT,
  TARGET_INPUT_NO_TEXT,
  resolveTargetInput,
  targetIsEmpty,
  type TargetInput,
  type TargetResolution,
} from './target.js';
export {
  createBrowserSeatHandlers,
  type BrowserSeatDeps,
  type BrowserSeatHandlers,
  type BrowserSeatSessionResolver,
  type BrowserSeatStore,
  type ClickInput,
  type DocumentInput,
  type DrivingAnswer,
  type PressInput,
  type ReadPageInput,
  type ScrollInput,
  type TypeInput,
  type WaitForInput,
} from './handlers.js';
