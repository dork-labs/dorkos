/**
 * The permission surfaces (spec `agent-permissions`): the list of areas with
 * their three-way switches, which renders both the default layer and one
 * agent's layer, the exceptions chip, the apply-to-overrides dialog, and the
 * read-only history.
 *
 * @module features/permissions
 */
export { PermissionList, type PermissionListProps } from './ui/PermissionList';
export { PermissionRow, type PermissionRowProps } from './ui/PermissionRow';
export { ExceptionsChip, type ExceptionsChipProps } from './ui/ExceptionsChip';
export {
  ApplyToOverridesDialog,
  type ApplyToOverridesDialogProps,
} from './ui/ApplyToOverridesDialog';
export { PermissionHistory, type PermissionHistoryProps } from './ui/PermissionHistory';
export { BLOCKED_IS_NOT_A_SANDBOX, PRESET_LABEL } from './lib/permission-copy';
