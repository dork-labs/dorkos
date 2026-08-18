/**
 * Chat status display — the composer's own status line, and the two notices
 * that sit around it.
 *
 * The inference status strip that used to live here is gone: what a session is
 * doing is said by `Conversation.LiveLane`, in the one reserved line every
 * conversation surface draws. `ChatStatusSection` is NOT that line and did not
 * move — it is the composer card's model / permission-mode / git / runtime
 * readout, and it becomes `Conversation.Footer` unchanged in P4.
 *
 * @module features/chat/ui/status
 */
export { ChatStatusSection } from './ChatStatusSection';
export { TerminalReasonChip } from './TerminalReasonChip';
export { TurnFailedNotice } from './TurnFailedNotice';
