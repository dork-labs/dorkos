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
// **`uiDomain` is deliberately NOT re-exported here.** It is reached by its own
// path, from the one place that composes it (`core/self-description/dorkos-registry.ts`).
// Putting it on this barrel widens the graph of everything that imports this
// barrel — and `services/session/index.ts` re-exports from here, which
// `core/approvals/approval-verdict-delivery.ts` imports, which the harness's
// auto-projection reaches. That pulled `lib/version.ts` (a module-scope
// `readFileSync`) into a suite that mocks `node:fs`, and the whole file failed
// to load. One domain, one import path.
export { uiTurnFacts, type UiRoomTurn } from './ui-turn-facts.js';
export {
  createRecordingHandlers,
  NOTHING_RECORDING_NOTE,
  RECORDING_ALREADY_RUNNING_NOTE,
  RECORDING_STOP_TIMEOUT_NOTE,
  type RecordingDeps,
  type RecordingHandlers,
  type RecordingStore,
} from './recording.js';
