/**
 * The first-run onboarding stages and their URL search-param schema.
 *
 * The overlay renders above whatever route is active (practically always `/` on
 * first run), so the stage is synced to a single `?onboarding=` search param
 * declared on the router's root route. That makes the three entry screens
 * browser-navigable (back/forward walk the stages) and refresh-safe without
 * turning the overlay into real routes.
 *
 * @module features/onboarding/model/onboarding-stage
 */
import { z } from 'zod';

/** The three ordered surfaces of first-run onboarding, in flow order. */
export const ONBOARDING_STAGES = ['welcome', 'requirements', 'conversation'] as const;

/** One of the first-run onboarding stages. */
export type OnboardingStage = (typeof ONBOARDING_STAGES)[number];

/**
 * Root-route search schema contributing the optional `onboarding` stage param.
 *
 * Declared on the router root so the overlay can read and write it from over any
 * route. An invalid or absent value simply means "no stage pinned"; the overlay
 * normalizes it to {@link ONBOARDING_STAGES}[0] on mount.
 */
export const onboardingStageSearchSchema = z.object({
  onboarding: z.enum(ONBOARDING_STAGES).optional(),
});

/** Narrow an unknown search value to a valid {@link OnboardingStage}. */
export function isOnboardingStage(value: unknown): value is OnboardingStage {
  return typeof value === 'string' && (ONBOARDING_STAGES as readonly string[]).includes(value);
}
