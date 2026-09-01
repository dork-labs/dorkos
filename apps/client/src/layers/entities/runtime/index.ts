/**
 * Runtime entity — runtime capabilities, feature detection, and visual identity.
 *
 * Exposes hooks for querying which features the active agent backend supports,
 * enabling UI components to gate Claude-specific UI behind capability checks,
 * plus the {@link RuntimeDescriptor} registry that gives every runtime one
 * icon/label/accent identity across all badges, pickers, and session rows.
 *
 * @module entities/runtime
 */
export {
  useRuntimeCapabilities,
  useCapabilitiesForRuntime,
} from './model/use-runtime-capabilities';
export type { UseRuntimeCapabilitiesOptions } from './model/use-runtime-capabilities';
export {
  useRuntimeRequirements,
  useRuntimeReadiness,
  isRuntimeReady,
  selectUnsatisfiedDeps,
  selectRuntimeReadiness,
  selectExpiringSignIn,
  REQUIREMENTS_KEY,
} from './model/use-runtime-requirements';
export type { RuntimeReadiness, ExpiringSignIn } from './model/use-runtime-requirements';
export { useProvisionRuntime } from './model/use-provision-runtime';
export type { UseProvisionRuntime } from './model/use-provision-runtime';
export { useStoreRuntimeCredential, useDelegateRuntimeLogin } from './model/use-credential-connect';
export type {
  UseStoreRuntimeCredential,
  UseDelegateRuntimeLogin,
} from './model/use-credential-connect';
export {
  RUNTIME_DESCRIPTORS,
  PRIMARY_RUNTIME_TYPES,
  getRuntimeDescriptor,
} from './config/runtime-descriptors';
export type { RuntimeDescriptor, RuntimeSetupHint } from './config/runtime-descriptors';
export { RuntimeMark } from './ui/RuntimeMark';
export { RuntimeIdentity } from './ui/RuntimeIdentity';
export { formatRuntimeIdentity, formatModelLabel } from './lib/runtime-identity';
export type { RuntimeIdentityText } from './lib/runtime-identity';
export { settingsForRuntime } from './lib/settings-for-runtime';
export { listRuntimeTypes } from './lib/list-runtime-types';
export { DependencyInstallHint } from './ui/DependencyInstallHint';
export { CommandTransparencyNote } from './ui/CommandTransparencyNote';
export { RuntimeSetupDialog, RuntimeSetupPanel } from './ui/RuntimeSetupDialog';
export type {
  RuntimeConnectSlot,
  RuntimeConnectSlotProps,
  RuntimeConnectSuccess,
} from './ui/RuntimeSetupDialog';
