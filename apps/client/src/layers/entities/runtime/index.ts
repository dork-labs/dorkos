/**
 * Runtime entity — runtime capabilities and feature detection.
 *
 * Exposes hooks for querying which features the active agent backend supports,
 * enabling UI components to gate Claude-specific UI behind capability checks.
 *
 * @module entities/runtime
 */
export {
  useRuntimeCapabilities,
  useDefaultCapabilities,
  useActiveCapabilities,
} from './model/use-runtime-capabilities';
