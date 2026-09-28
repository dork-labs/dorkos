/**
 * Continue on another account: the picker a limited session opens to carry
 * its work over to another account (spec `claude-account-ui` §6.6), and the
 * out-of-usage banner and transcript marker that follow a session's usage
 * limit (§6.7).
 *
 * @module features/continue-on-account
 */
export { ContinueOnAccountDialog } from './ui/ContinueOnAccountDialog';
export type { ContinueOnAccountDialogProps } from './ui/ContinueOnAccountDialog';
export { AccountLimitBanner } from './ui/AccountLimitBanner';
export type { AccountLimitBannerProps } from './ui/AccountLimitBanner';
export { AccountLimitMarker, AccountLimitMarkerLine } from './ui/AccountLimitMarker';
export type { AccountLimitMarkerProps, AccountLimitMarkerLineProps } from './ui/AccountLimitMarker';
export { canOpenPicker, isSelectable } from './lib/continue-picker';
export { useContinueOptions } from './model/use-continue-options';
export { useContinueSession, useCancelAutoContinue } from './model/use-continue-session';
export type { ContinueTarget } from './model/use-continue-session';
export type { LimitBannerAccount } from './model/use-limit-banner';
export { useLimitComposer, useSessionHasLimit } from './model/use-limit-composer';
