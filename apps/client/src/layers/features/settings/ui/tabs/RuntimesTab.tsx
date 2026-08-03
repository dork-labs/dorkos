/**
 * The Runtimes tab's old address.
 *
 * The tab itself now lives with the components it composes, in
 * `features/settings/ui/runtimes/` (spec §E). This file is the one-release
 * bridge so the Settings dialog keeps resolving the tab while the retirement of
 * the five-component stack lands; it goes away with that retirement, when
 * `SettingsDialog` points at the new module directly.
 *
 * @module features/settings/ui/tabs/RuntimesTab
 */
export { RuntimesTab } from '../runtimes/RuntimesTab';
