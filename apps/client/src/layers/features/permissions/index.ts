/**
 * The permission surfaces (spec `agent-permissions`): the preset picker, the
 * list of areas with their three-way switches and individual actions, which
 * renders both the default layer and one agent's layer (with its exceptions chip
 * and apply-to-overrides dialog), the Files & commands rows, and the read-only
 * history.
 *
 * @module features/permissions
 */
export { PermissionList, type PermissionListProps } from './ui/PermissionList';
export { PermissionHistory, type PermissionHistoryProps } from './ui/PermissionHistory';
export { NewAgentRecordNotice } from './ui/NewAgentRecordNotice';
export { PresetPicker, type PresetPickerProps } from './ui/PresetPicker';
export {
  DefaultFilesAndCommandsRow,
  type DefaultFilesAndCommandsRowProps,
} from './ui/FilesAndCommandsRow';
export { BLOCKED_IS_NOT_A_SANDBOX, PRESET_LABEL, STATE_LABEL } from './lib/permission-copy';
