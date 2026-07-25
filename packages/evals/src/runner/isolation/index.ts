/**
 * The isolation seam barrel: the launcher interface (`types.ts`) and its two
 * implementations — the default child-process tier and the hardened `docker`
 * tier, which landed as a second implementation of {@link IsolationLauncher}
 * with no change above the seam.
 *
 * @module evals/runner/isolation
 */
export * from './types.js';
export * from './child-process-launcher.js';
export * from './docker-launcher.js';
export * from './netns-proxy.js';
