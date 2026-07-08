/**
 * Lightweight mesh feature state registry.
 *
 * Mesh is always enabled (ADR-0062). The `isMeshEnabled()` function returns `true`
 * unconditionally. Init error tracking is preserved so the config route can
 * report runtime failures.
 *
 * @module services/mesh/mesh-state
 */
import { createFeatureFlag } from '../../lib/feature-flag.js';

const meshFlag = createFeatureFlag();

/** Mesh is always enabled (ADR-0062). */
export const isMeshEnabled = (): boolean => true;

/** Record why Mesh failed to initialize. */
export const setMeshInitError = meshFlag.setInitError;

/** Return the initialization error message, if any. */
export const getMeshInitError = meshFlag.getInitError;
