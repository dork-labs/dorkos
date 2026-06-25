/**
 * The production-gate decision for scheduled-task firing (ADR-285, spec #261).
 *
 * Centralizes "may THIS process/environment fire scheduled tasks?" in one pure
 * function so the forward-compatible deployment-environment seam is a
 * one-function change. Firing defaults OFF for every non-production
 * environment; `DORKOS_TASKS_ENABLED` is an explicit override in both
 * directions. This gate suppresses only *firing* — task discovery/display is
 * not gated here (the scheduler still registers crons so next-run displays).
 *
 * @module services/tasks/resolve-firing
 */

/** The env + config signals that gate scheduled-task firing. */
export interface FiringInput {
  /** `NODE_ENV` — distinguishes the production build from dev/test. */
  nodeEnv: 'development' | 'production' | 'test';
  /**
   * `DORKOS_TASKS_ENABLED` when the env key is present, else `undefined`. The
   * presence check distinguishes "unset" (use the default) from "explicitly
   * false". When set it wins in both directions (force-on in dev, force-off in
   * a production build).
   */
  explicitOverride: boolean | undefined;
  /** The user's master switch (`scheduler.enabled` in config). */
  schedulerEnabled: boolean;
  /**
   * Forward-compatibility seam: a future named deployment environment (e.g.
   * `DORKOS_DEPLOY_ENV` or a platform var). Any non-`'production'` value
   * defaults firing OFF without the deploy needing to opt out. `undefined`
   * today — no hosted non-production DorkOS server exists yet.
   */
  deployEnv?: string;
}

/** The firing decision plus a human-readable reason for the startup log. */
export interface FiringDecision {
  /** Whether this environment is authorized to fire scheduled tasks. */
  mayFire: boolean;
  /** Why — surfaced once at scheduler `start()`. */
  reason: string;
}

/**
 * Decide whether scheduled tasks may fire in this environment. Defaults OFF for
 * every non-production environment; the explicit `DORKOS_TASKS_ENABLED`
 * override wins in both directions.
 *
 * @param input - The env + config signals.
 * @returns The firing decision and its reason.
 */
export function resolveTasksFiring(input: FiringInput): FiringDecision {
  if (input.explicitOverride !== undefined) {
    return {
      mayFire: input.explicitOverride,
      reason: `DORKOS_TASKS_ENABLED override (${input.explicitOverride})`,
    };
  }
  if (input.deployEnv && input.deployEnv !== 'production') {
    return { mayFire: false, reason: `non-production deployEnv "${input.deployEnv}"` };
  }
  const mayFire = input.nodeEnv === 'production' && input.schedulerEnabled;
  return {
    mayFire,
    reason: `nodeEnv=${input.nodeEnv} schedulerEnabled=${input.schedulerEnabled}`,
  };
}
