/**
 * A space's Settings tab (DOR-3005): its settings, who is in it and its rules, read through the
 * app's own pairing with the space, and the private space's own short version on a hub.
 * Read-only for now; every change continues on the space's web settings.
 *
 * @module features/space-settings
 */
export { SpaceSettingsPanel } from './ui/SpaceSettingsPanel';
export type { SpaceSettingsPanelProps } from './ui/SpaceSettingsPanel';
export { PrivateSpaceSettings } from './ui/PrivateSpaceSettings';
