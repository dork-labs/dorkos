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
export { useUpdateConfig } from './model/use-update-config';
export { HEARTBEAT_PAYLOAD_EXAMPLE } from './lib/telemetry-payload';
export {
  useSidebarPrefs,
  useUpdateSidebarPrefs,
  pinPath,
  unpinPath,
  moveToGroup,
  createGroup,
  renameGroup,
  deleteGroup,
  reorderGroup,
  reorderWithinGroup,
  reorderPinned,
  setGroupSortMode,
  setGroupCollapsed,
  setUngroupedCollapsed,
  setRecentsCollapsed,
  setUngroupedSortMode,
  setGroupsHintDismissed,
} from './model/use-sidebar-prefs';
export type { UpdateSidebarPrefs } from './model/use-sidebar-prefs';
