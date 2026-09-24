/**
 * The permission surfaces (spec `agent-permissions`): the list of areas with
 * their three-way switches, which renders both the default layer and one
 * agent's layer (with its exceptions chip and apply-to-overrides dialog), and the
 * read-only history.
 *
 * @module features/permissions
 */
export { PermissionList, type PermissionListProps } from './ui/PermissionList';
export { PermissionHistory, type PermissionHistoryProps } from './ui/PermissionHistory';
export { BLOCKED_IS_NOT_A_SANDBOX, PRESET_LABEL } from './lib/permission-copy';
