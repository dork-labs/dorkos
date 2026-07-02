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
  useDefaultCapabilities,
  useActiveCapabilities,
} from './model/use-runtime-capabilities';
export { RUNTIME_DESCRIPTORS, getRuntimeDescriptor } from './config/runtime-descriptors';
export type { RuntimeDescriptor } from './config/runtime-descriptors';
export { RuntimeMark } from './ui/RuntimeMark';
