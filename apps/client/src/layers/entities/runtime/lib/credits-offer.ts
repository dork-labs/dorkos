/**
 * Whether a surface offers DorkOS credits first for a runtime — the decision
 * behind the default-first pattern (spec `dorkos-account-by-default` §3, D2).
 *
 * Pure, so every surface that hits a gap (a runtime's connect step, the
 * onboarding connect step, the sign-in banner, the chat's auth-error card)
 * decides it the same way. It reads only what the server reports: where the
 * runtime's own sign-in stands, and which runtimes credits are wired for. A
 * runtime that joins the wired set (Codex, OpenCode) is offered credits with no
 * change here.
 *
 * @module entities/runtime/lib/credits-offer
 */
import {
  deriveRuntimeSignIn,
  type RuntimeSignInState,
  type SystemRequirements,
} from '@dorkos/shared/agent-runtime';
import type { CloudCreditsStatus } from '@dorkos/shared/cloud-schemas';
import { selectRuntimeReadiness } from '../model/use-runtime-requirements';

/**
 * What a surface shows for one runtime:
 *
 * - `lead` — nothing works yet and credits can reach it: "Use DorkOS credits"
 *   first, its own sign-in and a key as visible rows under it.
 * - `on-credits` — its new work already runs on credits: "You're ready", no
 *   card.
 * - `none` — no credits card. A working sign-in is ready on its own; one that
 *   expired or ran out leads with signing in again, never with credits; and a
 *   runtime credits cannot reach is offered only its own ways.
 */
export type RuntimeCreditsOffer = 'lead' | 'on-credits' | 'none';

/**
 * Whether the server reports DorkOS credits wired for a runtime and not
 * switched off on this computer. Linking is not required: a signed-out person
 * is offered credits too, and choosing them starts the link.
 *
 * @param credits - `GET /api/cloud/credits`, or `undefined` while it loads.
 * @param type - The runtime type.
 */
export function creditsWiredFor(credits: CloudCreditsStatus | undefined, type: string): boolean {
  if (!credits || credits.killed) return false;
  return (credits.runtimes as Record<string, string | undefined>)[type] === 'wired';
}

/**
 * Whether a runtime's new work runs on DorkOS credits right now: wired, this
 * computer linked with credits on, and the runtime's recorded default credits.
 *
 * @param credits - `GET /api/cloud/credits`, or `undefined` while it loads.
 * @param type - The runtime type.
 */
export function runsOnCredits(credits: CloudCreditsStatus | undefined, type: string): boolean {
  return (
    creditsWiredFor(credits, type) &&
    credits?.enabled === true &&
    credits.defaults?.[type]?.runsOn === 'credits'
  );
}

/**
 * Where a runtime's own sign-in stands, read off the requirements every
 * runtime surface already holds, or `undefined` while they load or when the
 * server does not report the runtime at all.
 *
 * @param requirements - `GET /api/system/requirements`, or `undefined` while it loads.
 * @param type - The runtime type.
 */
export function selectRuntimeSignIn(
  requirements: SystemRequirements | undefined,
  type: string
): RuntimeSignInState | undefined {
  const entry = requirements?.runtimes[type];
  if (!entry) return undefined;
  if (selectRuntimeReadiness(requirements, type).state === 'ready') return 'working';
  return deriveRuntimeSignIn(type, entry.dependencies);
}

/**
 * Decide what a surface shows for one runtime. See {@link RuntimeCreditsOffer}.
 *
 * A working sign-in wins over everything: the person's own setup is never
 * second to an offer. Credits lead only for a runtime with no sign-in at all —
 * never for one whose sign-in expired or ran out, which needs signing in again.
 *
 * @param signIn - Where the runtime's own sign-in stands, or `undefined` if unknown.
 * @param credits - `GET /api/cloud/credits`, or `undefined` while it loads.
 * @param type - The runtime type.
 */
export function creditsOfferFor(
  signIn: RuntimeSignInState | undefined,
  credits: CloudCreditsStatus | undefined,
  type: string
): RuntimeCreditsOffer {
  if (signIn === 'working') return 'none';
  if (runsOnCredits(credits, type)) return 'on-credits';
  if (signIn === 'none' && creditsWiredFor(credits, type)) return 'lead';
  return 'none';
}
