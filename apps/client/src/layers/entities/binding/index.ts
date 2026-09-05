/**
 * Binding entity — the one home for the records that say which agent answers
 * which chat: lifecycle hooks, the dialog's shared form model, and the display
 * helpers (preview sentence, session-strategy labels) used across every surface
 * that manages them.
 *
 * The claim feed lives here too rather than in an entity of its own. An
 * unclaimed chat is a binding that does not exist yet: claiming one creates a
 * binding through the same uniqueness-checked path as any other create, so the
 * two share a cache that FSD forbids a sibling entity from reaching.
 *
 * @module entities/binding
 */
export { useBindings, BINDINGS_QUERY_KEY } from './model/use-bindings';
export { useBindingsSync } from './model/use-bindings-sync';
export { useCreateBinding } from './model/use-create-binding';
export { useDeleteBinding } from './model/use-delete-binding';
export { useTestBinding } from './model/use-test-binding';
export { useUpdateBinding } from './model/use-update-binding';
export { useMoveBinding } from './model/use-move-binding';
export {
  useUnclaimedChats,
  useUnclaimedChatsSync,
  useClaimUnclaimedChat,
  useIgnoreUnclaimedChat,
  useBlockUnclaimedChat,
  useLeaveUnclaimedChat,
  UNCLAIMED_CHATS_QUERY_KEY,
  unclaimedChatsKey,
} from './model/use-unclaimed-chats';

export { BindingDialog, type BindingDialogProps } from './ui/BindingDialog';
export { MoveChatDialog, readChatConflict, type ChatConflict } from './ui/MoveChatDialog';
export {
  type BindingFormValues,
  type BindingDefaultsOptions,
  toCreateBindingRequest,
  toUpdateBindingRequest,
  buildDefaultValues,
  hasNonDefaultAdvanced,
} from './model/binding-form';
export {
  buildPreviewSentence,
  chatTypeLabel,
  CHAT_TYPE_OPTIONS,
  SELECT_ANY,
} from './lib/build-preview-sentence';
export { SESSION_STRATEGY_LABELS, sessionStrategyLabel } from './lib/session-strategy-labels';
