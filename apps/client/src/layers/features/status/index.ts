/**
 * Status feature — bottom status bar with git info, model, and session indicators.
 *
 * @module features/status
 */
export { StatusLine } from './ui/StatusLine';
export { VersionItem } from './ui/VersionItem';
export { useGitStatus } from './model/use-git-status';
export { TunnelItem } from './ui/TunnelItem';
export { isNewer, isFeatureUpdate } from './lib/version-compare';
