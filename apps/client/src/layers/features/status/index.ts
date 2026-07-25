/**
 * Status feature — the composer status line and the Session panel behind its `⋯`.
 *
 * @module features/status
 */
export { StatusLine } from './ui/StatusLine';
export { CwdItem } from './ui/CwdItem';
export { GitStatusItem } from './ui/GitStatusItem';
export { PermissionModeItem } from './ui/PermissionModeItem';
export { RuntimeItem } from './ui/RuntimeItem';
export { AutoModeConfirmDialog } from './ui/AutoModeConfirmDialog';
export { ModelConfigPopover } from './ui/ModelConfigPopover';
export { ContextItem } from './ui/ContextItem';
export type { ContextCompactAction } from './ui/ContextItem';
export { UsageStatusItem, hasRenderableUsage } from './ui/UsageStatusItem';
export { UsageRevealPopover } from './ui/UsageRevealPopover';
export { ConnectionItem } from './ui/ConnectionItem';
export { SubagentsItem } from './ui/SubagentsItem';
export { SessionPopover } from './ui/SessionPopover';
export { useGitStatus, isGitStatusOk } from './model/use-git-status';
export { useSessionPopoverShortcut } from './model/use-session-popover-shortcut';
export { isNewer, isFeatureUpdate } from './lib/version-compare';
// `lib/status-labels` is deliberately NOT re-exported: like `lib/model-menu-tiers`,
// it is the slice's own presentation rule, consumed only by the items in this
// folder. Publishing it would invite a caller outside the line to bound a value
// that has nothing to do with the line's width.
export { gitPromotionState, useStatusBarPins } from './model/status-bar-registry';
export type { StatusBarItemKey, StatusPromotionContext } from './model/status-bar-registry';
export { selectPromotedItems } from './model/promoted-items';
export type { PromotedStatusItem } from './model/promoted-items';
export { applyStatusBudget } from './model/status-budget';
export type { StatusDensity } from './model/status-budget';
export { useStatusBudget } from './model/use-status-budget';
export type { SessionDiagnostics } from './model/session-diagnostics';
