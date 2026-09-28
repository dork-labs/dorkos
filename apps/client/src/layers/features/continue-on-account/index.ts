/**
 * Continue on another account: the picker a limited session opens to carry
 * its work over to another account (spec `claude-account-ui` §6.6).
 *
 * @module features/continue-on-account
 */
export { ContinueOnAccountDialog } from './ui/ContinueOnAccountDialog';
export type { ContinueOnAccountDialogProps } from './ui/ContinueOnAccountDialog';
export { canOpenPicker, isSelectable } from './lib/continue-picker';
export { useContinueOptions } from './model/use-continue-options';
export { useContinueSession, useCancelAutoContinue } from './model/use-continue-session';
export type { ContinueTarget } from './model/use-continue-session';
