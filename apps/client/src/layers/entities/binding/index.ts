/**
 * Binding entity — the one home for adapter↔agent binding (channel) records:
 * lifecycle hooks, the dialog's shared form model, and the display helpers
 * (preview sentence, session-strategy labels) used across every surface that
 * manages bindings.
 *
 * @module entities/binding
 */
export { useBindings } from './model/use-bindings';
export { useBindingsSync } from './model/use-bindings-sync';
export { useCreateBinding } from './model/use-create-binding';
export { useDeleteBinding } from './model/use-delete-binding';
export { useTestBinding } from './model/use-test-binding';
export { useUpdateBinding } from './model/use-update-binding';

export { BindingDialog, type BindingDialogProps } from './ui/BindingDialog';
export {
  type BindingFormValues,
  toCreateBindingRequest,
  toUpdateBindingRequest,
  buildDefaultValues,
  hasNonDefaultAdvanced,
} from './model/binding-form';
export { buildPreviewSentence, SELECT_ANY } from './lib/build-preview-sentence';
export { SESSION_STRATEGY_LABELS, sessionStrategyLabel } from './lib/session-strategy-labels';
