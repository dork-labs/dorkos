/**
 * Status feature — bottom status bar with git info, model, and session indicators.
 *
 * @module features/status
 */
export { StatusLine } from './ui/StatusLine';
export { CwdItem } from './ui/CwdItem';
export { GitStatusItem } from './ui/GitStatusItem';
export { PermissionModeItem } from './ui/PermissionModeItem';
export { ModelItem } from './ui/ModelItem';
export { CostItem } from './ui/CostItem';
export { ContextItem } from './ui/ContextItem';
export { NotificationSoundItem } from './ui/NotificationSoundItem';
export { SyncItem } from './ui/SyncItem';
export { PollingItem } from './ui/PollingItem';
export { TunnelItem } from './ui/TunnelItem';
export { ClientsItem } from './ui/ClientsItem';
export { ConnectionItem } from './ui/ConnectionItem';
export { SubagentsItem } from './ui/SubagentsItem';
export { StatusBarConfigureContent } from './ui/StatusBarConfigureContent';
export { StatusBarConfigurePopover } from './ui/StatusBarConfigurePopover';
export type { StatusBarConfigurePopoverProps } from './ui/StatusBarConfigurePopover';
export { useGitStatus } from './model/use-git-status';
export { isNewer, isFeatureUpdate } from './lib/version-compare';
export {
  STATUS_BAR_REGISTRY,
  GROUP_LABELS,
  getGroupedRegistryItems,
  useStatusBarVisibility,
  resetStatusBarPreferences,
} from './model/status-bar-registry';
export type {
  StatusBarItemKey,
  StatusBarItemGroup,
  StatusBarItemConfig,
} from './model/status-bar-registry';
