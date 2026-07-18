/**
 * The isolation seam barrel: the launcher interface (`types.ts`) and the
 * child-process implementation. A future `docker` launcher lands here as a
 * second implementation of {@link IsolationLauncher} with no change above the
 * seam.
 *
 * @module evals/runner/isolation
 */
export * from './types.js';
export * from './child-process-launcher.js';
