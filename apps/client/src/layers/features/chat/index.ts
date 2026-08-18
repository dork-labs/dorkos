/**
 * Chat feature — the session's own machinery: the streaming model, the message
 * parts, the composer's pieces and the status line.
 *
 * **The session's HOST is not here.** `ChatPanel`, the transcript, the row and
 * the body renderer live in `widgets/session`, because a conversation's host is
 * a widget and only a widget may compose one from a feature. What is left here
 * is everything that host is built out of, which is why this barrel is wide:
 * the widget above it is the only consumer, and a feature that exported half of
 * itself would have the widget reaching into internals instead.
 *
 * @module features/chat
 */
export { resolveMessageAuthor } from './lib/resolve-message-author';
export type { MessageAuthorAgent, MessageAuthorContext } from './lib/resolve-message-author';
export { buildListRows } from './lib/build-list-rows';
export type { ListRow, TranscriptMessageRow } from './lib/build-list-rows';
export { buildFileEntries } from './lib/build-file-entries';
export { resolveTransportRetryText } from './lib/resolve-retry-text';

export { ChatEmptyState } from './ui/ChatEmptyState';
export { BirthCertificate } from './ui/BirthCertificate';
export { CelebrationOverlay } from './ui/CelebrationOverlay';
export { FirstLight } from './ui/FirstLight';
export { TypingDots } from './ui/primitives';
export { MessageProvider } from './ui/message/MessageContext';
// The transcript's ROW, and its renderer's blocks. The row is a feature export
// rather than the host widget's own because `features/onboarding` renders real
// session rows for its scripted narration — see `render-session-body.tsx`.
export { ErrorMessageBlock, SessionMessage, StagedContextNote } from './ui/message';
export type { InteractiveToolHandle } from './ui/message';
export { renderSessionBody } from './ui/render-session-body';
export { ChatInputContainer } from './ui/input/ChatInputContainer';
export { TaskListPanel } from './ui/tasks/TaskListPanel';
export { TerminalReasonChip, TurnFailedNotice } from './ui/status';

export { useChatSession } from './model/use-chat-session';
export { useCelebrations } from './model/use-celebrations';
export { useTaskState } from './model/use-task-state';
export { useToolShortcuts } from './model/use-tool-shortcuts';
export { useInputAutocomplete } from './model/use-input-autocomplete';
export { useChatStatusSync } from './model/use-chat-status-sync';
export { useFileUpload } from './model/use-file-upload';
export { buildPaletteCommands, compactComposerGate } from './model/build-palette-commands';
export { useLaunchPrompt } from './model/launch/use-launch-prompt';
export { useDorkBotSeed } from './model/launch/use-dorkbot-seed';
export { shouldShowTurnFailedNotice } from './model/stream/turn-failure';
export { useApprovalAnnouncer } from './model/stream/use-approval-announcer';
export { useStreamingAnnouncer } from './model/stream/use-streaming-announcer';
