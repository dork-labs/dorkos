/**
 * Config entity — domain hooks for reading and patching the persisted server
 * configuration. Wraps the `/config` Transport endpoints in TanStack Query so
 * any feature can subscribe to live config state and mutate it without each
 * callsite re-implementing the query/key/invalidation plumbing.
 *
 * @module entities/config
 */

export { configKeys } from './api/query-keys';
export { useConfig } from './model/use-config';
export { useEngagedWindow } from './model/use-engaged-window';
export { useDefaultAgentSession, resolveDefaultAgentDir } from './model/use-default-agent-session';
export type { DefaultAgentSession, DefaultAgentIdentity } from './model/use-default-agent-session';
export { useUpdateConfig } from './model/use-update-config';
export { usePromoDismissals, resetLegacyPromoImportForTests } from './model/use-promo-dismissals';
export type { PromoDismissals } from './model/use-promo-dismissals';
export { useAutonomyAcknowledgement } from './model/use-autonomy-acknowledgement';
export { useWelcomeBack } from './model/use-welcome-back';
export type { WelcomeBackSetting } from './model/use-welcome-back';
export { useStatusBarPrefs, useUpdateStatusBarPrefs } from './model/use-status-bar-prefs';
export { useComposerRichText, useUpdateComposerPrefs } from './model/use-composer-prefs';
export { TelemetryPayloadBlock } from './ui/TelemetryPayloadBlock';
export { TelemetryPayloadDisclosure } from './ui/TelemetryPayloadDisclosure';
export { TelemetryPayloadToggle } from './ui/TelemetryPayloadToggle';
export {
  useSidebarPrefs,
  useUpdateSidebarPrefs,
  pinItem,
  unpinItem,
  moveToGroup,
  createGroup,
  createSmartGroup,
  convertSmartGroupToManual,
  renameGroup,
  deleteGroup,
  reorderGroup,
  reorderWithinGroup,
  reorderPinned,
  setGroupSortMode,
  setGroupCollapsed,
  isSectionCollapsed,
  sectionSortMode,
  sectionDisplayFilter,
  setSectionCollapsed,
  setSectionSortMode,
  setSectionDisplayFilter,
  GROUPS_HINT_SUGGESTION_ID,
  isSuggestionRetired,
  retireSuggestion,
  markDigestShown,
  setGroupDisplayFilter,
  setGroupMuted,
  setGroupRules,
  muteItem,
  unmuteItem,
  mutedRoomIds,
} from './model/use-sidebar-prefs';
export type { UpdateSidebarPrefs } from './model/use-sidebar-prefs';
export { toSidebarModelPrefs } from './model/sidebar-model-prefs';
export type { SidebarModelPrefs } from './model/sidebar-model-prefs';
