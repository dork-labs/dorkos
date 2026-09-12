/**
 * The `ui` capability domain and the browser driver seat: which window a
 * command reaches, what it is allowed to name, and what comes back (spec
 * `canvas-agent-seat` §2 and §5).
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
  type SessionEventEmitter,
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
export { parseScreenshotDataUrl, type DevtoolsReadStore } from './devtools-reads.js';
export { emitToSession } from './session-reach.js';
export { reachesPastTheScreen, uiActionRefusalMessage } from './ui-surface-consent.js';
export { uiDomain } from './ui-capabilities.js';
export {
  uiTurnFacts,
  UiTurnFactStore,
  type UiRoomTurn,
  type UiTurnBinding,
  type UiTurnFacts,
} from './ui-turn-facts.js';
