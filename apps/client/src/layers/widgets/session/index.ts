/**
 * Session widget — the agent session's conversation and the page that routes to
 * it.
 *
 * The HOST of a session conversation, which is what makes it a widget: it
 * composes `features/conversation`'s compound with `features/chat`'s model, and
 * only a widget may compose two features. P4 moved `ChatPanel` up here from
 * `features/chat`, and the capability table came with it; DOR-1353 brought the
 * transcript's row and its body renderer up after them, once onboarding stopped
 * borrowing the row for its narration.
 *
 * @module widgets/session
 */
export { SessionPage } from './ui/SessionPage';
export { ChatPanel } from './ui/ChatPanel';
export { SessionTranscript } from './ui/SessionTranscript';
export { SessionComposer } from './ui/SessionComposer';
/**
 * One row of a session transcript. Exported for the Dev Playground, which
 * benches the real row; the transcript itself reaches it directly.
 */
export { SessionMessage } from './ui/SessionMessage';
export { useSessionTarget } from './model/session-target';
/**
 * What an agent session's conversation can do — the one table that says how
 * this surface differs from a channel's.
 */
export { SESSION_CAPABILITIES } from './model/session-capabilities';
