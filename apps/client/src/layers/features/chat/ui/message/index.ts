/**
 * Message sub-component module — the blocks the session's body renderer draws,
 * and the context they read.
 *
 * The ROW that hosts them, and the renderer that picks between them, live in
 * `widgets/session`: a conversation's host is a widget. These are what that
 * host is built out of.
 *
 * @module features/chat/ui/message
 */
export type { InteractiveToolHandle } from './types';
export { MessageProvider } from './MessageContext';
export { StreamingText } from './StreamingText';
export { ThinkingBlock } from './ThinkingBlock';
export { MemoryRecallBlock } from './MemoryRecallBlock';
export { CompactBoundaryRow } from './CompactBoundaryRow';
export { MessageImage } from './MessageImage';
export { StagedContextNote } from './StagedContextNote';
export { SubagentBlock } from './SubagentBlock';
export { OutputRenderer } from './OutputRenderer';
export { ErrorMessageBlock } from './ErrorMessageBlock';
export { PermissionDeniedChip } from './PermissionDeniedChip';
export { AssistantMessageContent } from './AssistantMessageContent';
export { UserMessageContent } from './UserMessageContent';
