/**
 * Plan-bound launch journal initialization and resume checks.
 *
 * @module commands/community-deploy/resume
 */
import { LaunchJournalSchema, type LaunchJournal } from './journal.js';
import { hashLaunchPlan, type LaunchPlan } from './plan.js';

/** Stable refusal when a saved run no longer matches the requested plan. */
export class CommunityLaunchPlanDriftError extends Error {
  /** Create a secret-free plan drift refusal. */
  constructor() {
    super('The saved Community launch does not match this plan');
    this.name = 'CommunityLaunchPlanDriftError';
  }
}

/**
 * Create the revision-zero non-secret journal for one consented launch.
 *
 * @param runId - Fresh UUID selected before the first durable write.
 * @param plan - Immutable consented plan.
 * @param now - Current ISO timestamp.
 * @returns Validated initial journal.
 */
export function createInitialCommunityLaunchJournal(
  runId: string,
  plan: LaunchPlan,
  now: string
): LaunchJournal {
  return LaunchJournalSchema.parse({
    schemaVersion: 1,
    runId,
    revision: 0,
    planHash: hashLaunchPlan(plan),
    releaseDigest: plan.imageDigest,
    state: 'planned',
    pendingIntent: null,
    resources: {},
    secretDigests: {},
    verifiedBindings: [],
    completedSteps: ['planned'],
    lastSafeError: null,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Fail before another write when a resume request changes any plan field or release digest.
 *
 * @param journal - Latest validated saved journal.
 * @param plan - Newly resolved and planned request.
 */
export function assertCommunityLaunchPlanUnchanged(journal: LaunchJournal, plan: LaunchPlan): void {
  if (journal.planHash !== hashLaunchPlan(plan) || journal.releaseDigest !== plan.imageDigest) {
    throw new CommunityLaunchPlanDriftError();
  }
}
