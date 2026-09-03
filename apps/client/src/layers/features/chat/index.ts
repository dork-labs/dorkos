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
export { buildListRows, messageRowKey } from './lib/build-list-rows';
export type { ListRow } from './lib/build-list-rows';
export { buildFileEntries } from './lib/build-file-entries';
export { resolveTransportRetryText } from './lib/resolve-retry-text';
export { resolveSigninResumeText } from './model/signin-resume/resolve-signin-resume';
export type { SigninResumeState } from './model/signin-resume/resolve-signin-resume';
export { useSigninResumeClaim } from './model/signin-resume/use-signin-resume-claim';
export type { SigninResumeClaim } from './model/signin-resume/use-signin-resume-claim';

export { ChatEmptyState } from './ui/ChatEmptyState';
export { BirthCertificate } from './ui/BirthCertificate';
export { CelebrationOverlay } from './ui/CelebrationOverlay';
export { FirstLight } from './ui/FirstLight';
export { TypingDots } from './ui/primitives';
// The blocks the session's body renderer draws, and the context they read —
// the row and the renderer themselves are `widgets/session`'s. `StreamingText`
// is exported for a second reader as well: `features/onboarding` draws its
// scripted narration with it, so a story line and a real reply are styled by
// one component rather than two.
export {
  AssistantMessageContent,
  ErrorMessageBlock,
  MessageProvider,
  StagedContextNote,
  StreamingText,
  UserMessageContent,
} from './ui/message';
export type { InteractiveToolHandle } from './ui/message';
export { TaskListPanel } from './ui/tasks/TaskListPanel';
export { BackgroundTaskBar } from './ui/tasks/BackgroundTaskBar';
export { QueuePanel } from './ui/input/QueuePanel';
export { StopConfirmDialog } from './ui/input/StopConfirmDialog';
export { AnimatedPlaceholder } from './ui/input/AnimatedPlaceholder';
export { ChatStatusSection } from './ui/status';
export { default as placeholderHints } from './config/placeholder-hints.json';
export type { InteractionProps, SyncPresenceProps } from './ui/input/composer-slots';
export { TerminalReasonChip, TurnFailedNotice } from './ui/status';

export { useChatSession } from './model/use-chat-session';
export type { StopOutcome } from './model/use-session-submit';
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
export { useBackgroundTasks } from './model/use-background-tasks';
export { useChatQueue } from './model/use-chat-queue';
export { useRotatingPlaceholder } from './model/use-rotating-placeholder';
export { selectRenderedMessages } from './model/stream/derive-rendered-state';
export { selectWaitingQueue } from './lib/queue-chips';
export { sessionContextKey } from './lib/session-context-key';
export type { NativeCommandResult } from './model/native-commands';
export { useStreamingAnnouncer } from './model/stream/use-streaming-announcer';
