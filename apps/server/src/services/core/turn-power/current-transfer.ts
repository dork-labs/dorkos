/**
 * What a durable hand-off carries from the drafting turn, read as it is admitted (DOR-3816).
 *
 * Its own module because it reads both `turn-levels` and `chat-outside-words`, and
 * `chat-outside-words` already imports `turn-levels`: living in either one would close an import
 * cycle, which hands a test's mock of `turn-levels` to only some of its readers.
 *
 * @module services/core/turn-power/current-transfer
 */
import { primaryOf } from '../../session/resolution/session-key-registry.js';
import { chatReadOutsideWords } from './chat-outside-words.js';
import { captureTransfer } from './handoff-transfer-capture.js';
import { sessionReadOutsideText } from './live-outsider-turns.js';
import { recordedTurnOf } from './turn-levels.js';
import { NO_MARKS } from './turn-marks.js';

/**
 * Current transferable marks, never a native/billing or tool-caller authority grant.
 *
 * @param sessionId - The drafting chat, from the verified caller.
 * @param expectedCurrentSerial - The turn serial the caller's tool call ran in.
 */
export function captureCurrentTransfer(sessionId: string, expectedCurrentSerial: number) {
  return captureTransfer(
    recordedTurnOf(sessionId),
    sessionId,
    expectedCurrentSerial,
    sessionReadOutsideText(primaryOf(sessionId)) ? { outsider: true } : NO_MARKS,
    chatReadOutsideWords(sessionId)
  );
}
