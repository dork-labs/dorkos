/**
 * Status feature — the composer status line and the Session panel behind its `⋯`.
 *
 * @module features/status
 */
export { StatusLine } from './ui/StatusLine';
export { CwdItem } from './ui/CwdItem';
export { GitStatusItem } from './ui/GitStatusItem';
export { PermissionModeItem } from './ui/PermissionModeItem';
export { MakeDefaultStopLine } from './ui/MakeDefaultStopLine';
export { useMakeDefaultStop } from './model/use-make-default-stop';
export type { MakeDefaultStop } from './model/use-make-default-stop';
export type { MakeDefaultStopLineProps } from './ui/MakeDefaultStopLine';
export { PlanModeItem } from './ui/PlanModeItem';
export type { PlanModeItemProps } from './ui/PlanModeItem';
export { RuntimeItem } from './ui/RuntimeItem';
export { AutoModeConfirmDialog } from './ui/AutoModeConfirmDialog';
export { AutonomyConfirmDialog } from './ui/AutonomyConfirmDialog';
export { ModelConfigPopover } from './ui/ModelConfigPopover';
export { UnverifiedCatalogNotice } from './ui/ModelSelectionList';
export { ContextItem } from './ui/ContextItem';
export type { ContextCompactAction } from './ui/ContextItem';
export { UsageStatusItem, hasRenderableUsage } from './ui/UsageStatusItem';
export { UsageRevealPopover } from './ui/UsageRevealPopover';
export { ConnectionItem } from './ui/ConnectionItem';
export { SubagentsItem } from './ui/SubagentsItem';
export { SessionPopover } from './ui/SessionPopover';
export { useGitStatus, isGitStatusOk } from './model/use-git-status';
export { useRuntimeChip, useResolvedSessionRuntime } from './model/use-runtime-chip';
export type { RuntimeChipState, ResolvedSessionRuntime } from './model/use-runtime-chip';
export { useSessionPopoverShortcut } from './model/use-session-popover-shortcut';
// Exported because "running" is a distinction every reader of a fold has to make
// before it may say the word — the fold keeps terminal rows on purpose. The
// composer needs it to decide whether the subagents item has anything to say.
export { partitionSubagents } from './lib/fold-active-subagents';
// `lib/status-labels` is deliberately NOT re-exported: like `lib/model-menu-tiers`,
// it is the slice's own presentation rule, consumed only by the items in this
// folder. Publishing it would invite a caller outside the line to bound a value
// that has nothing to do with the line's width.
export { gitPromotionState, useStatusBarPins } from './model/status-bar-registry';
export type { StatusBarItemKey, StatusPromotionContext } from './model/status-bar-registry';
export { selectPromotedItems } from './model/promoted-items';
export { applyStatusBudget, resolveStatusBudget } from './model/status-budget';
export type { StatusDensity, StatusBudget } from './model/status-budget';
export { useStatusBudget } from './model/use-status-budget';
export { SessionInspector, SessionReadout } from './ui/SessionInspector';
export { useSessionDiagnostics } from './model/use-session-diagnostics';
export { formatDiagnostics } from './model/session-diagnostics';
export type { SessionDiagnostics, ActiveSubagent } from './model/session-diagnostics';
