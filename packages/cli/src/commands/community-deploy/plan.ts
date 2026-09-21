/**
 * Immutable, non-secret plan for one Community launch.
 *
 * @module commands/community-deploy/plan
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

const SafeIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const DisplayNameSchema = z.string().trim().min(1).max(128);
const RegionSchema = SafeIdentifierSchema.max(64);
const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** Input accepted when building an immutable launch plan. */
export const LaunchPlanInputSchema = z
  .object({
    dorkosVersion: z.string().trim().min(1).max(64),
    imageDigest: Sha256DigestSchema,
    fly: z
      .object({
        organizationId: SafeIdentifierSchema,
        organizationName: DisplayNameSchema,
        appName: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/),
        region: RegionSchema,
        machineSize: SafeIdentifierSchema,
      })
      .strict(),
    neon: z
      .object({
        organizationId: SafeIdentifierSchema,
        organizationName: DisplayNameSchema,
        projectName: SafeIdentifierSchema,
        region: RegionSchema,
      })
      .strict(),
    tigris: z
      .object({
        bucketName: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/),
        private: z.literal(true),
      })
      .strict(),
  })
  .strict();

/** Immutable, validated launch plan persisted by hash rather than by credentials. */
export type LaunchPlan = Readonly<z.infer<typeof LaunchPlanInputSchema>>;

/**
 * Validate and deeply freeze a Community launch plan.
 *
 * @param input - Candidate non-secret plan fields from read-only preflight.
 * @returns A deeply frozen plan with normalized strings.
 */
export function createLaunchPlan(input: z.input<typeof LaunchPlanInputSchema>): LaunchPlan {
  const parsed = LaunchPlanInputSchema.parse(input);
  Object.freeze(parsed.fly);
  Object.freeze(parsed.neon);
  Object.freeze(parsed.tigris);
  return Object.freeze(parsed);
}

/**
 * Hash a validated plan using a fixed key order.
 *
 * @param plan - The validated plan.
 * @returns Lowercase SHA-256 hex for journal identity and drift detection.
 */
export function hashLaunchPlan(plan: LaunchPlan): string {
  const canonical = JSON.stringify({
    dorkosVersion: plan.dorkosVersion,
    imageDigest: plan.imageDigest,
    fly: {
      organizationId: plan.fly.organizationId,
      organizationName: plan.fly.organizationName,
      appName: plan.fly.appName,
      region: plan.fly.region,
      machineSize: plan.fly.machineSize,
    },
    neon: {
      organizationId: plan.neon.organizationId,
      organizationName: plan.neon.organizationName,
      projectName: plan.neon.projectName,
      region: plan.neon.region,
    },
    tigris: {
      bucketName: plan.tigris.bucketName,
      private: plan.tigris.private,
    },
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
