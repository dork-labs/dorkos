/**
 * The one account advisor an extension may register (spec `claude-account-fleet`
 * §6 X3, ADR 260926-141756): routing policy lives in the extension (the Flow
 * extension), and core only asks it.
 *
 * - **One advisor at a time.** A second registration replaces the first and
 *   logs a warning naming both owners, because two policies answering one
 *   limit have no good merge. The unregister function an owner holds removes
 *   only its own advisor, so a stale one cannot remove its replacement.
 * - **Every call is bounded.** {@link callAdvisor} gives the advisor
 *   {@link ADVISOR_TIMEOUT_MS} and answers `undefined` on a throw, a timeout or
 *   a missing method; the caller then uses core's default (or refuses, for an
 *   agent's or a relay message's account pick).
 * - **Every answer is validated.** The advisor is extension code running
 *   in-process, so its answers are checked here before core acts on them:
 *   rankings keep only known ids, delays are clamped, and oversized seeds are
 *   refused.
 *
 * @module services/core/usage/account-advisor
 */
import { z } from 'zod';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import type {
  AccountAdvisor,
  AccountUsage as ExtensionAccountUsage,
  AdvisorRanking,
  CarryOverSeed,
  LimitedPlan,
} from '@dorkos/extension-api/server';
import { SEED_CONTEXT_MAX_LENGTH } from '@dorkos/shared/schemas';
import { logger } from '../../../lib/logger.js';

/** The longest `reason` an advisor's ranking row may carry; longer ones are cut to fit. */
export const MAX_RANKING_REASON_LENGTH = 200;

/** How long core waits for any advisor call before using its default. */
export const ADVISOR_TIMEOUT_MS = 2_000;

/** The longest delay an `auto` plan may ask for before moving a session (one hour). */
export const MAX_AUTO_DELAY_SECONDS = 3_600;

/** The advisor methods core may call. */
export type AdvisorMethod = keyof AccountAdvisor;

/**
 * Methods that resolve to nothing; their only answer is whether they succeeded
 * ({@link invokeAdvisor}). Read off {@link AccountAdvisor} itself, so a new
 * method that returns `void | Promise<void>` joins this set without an edit.
 */
export type VoidAdvisorMethod = {
  [M in AdvisorMethod]-?: NonNullable<AccountAdvisor[M]> extends (...args: never[]) => infer R
    ? [Awaited<R>] extends [void]
      ? M
      : never
    : never;
}[AdvisorMethod];

/** Methods that answer something core then validates ({@link callAdvisor}). */
export type AnsweringAdvisorMethod = Exclude<AdvisorMethod, VoidAdvisorMethod>;

interface Registration {
  ownerId: string;
  advisor: AccountAdvisor;
}

let current: Registration | undefined;

/** Called with the owner's id whenever an advisor is registered. */
type RegistrationListener = (ownerId: string) => void;

const registrationListeners = new Set<RegistrationListener>();

/**
 * Be told whenever an advisor is registered (a first one, or one replacing
 * another), for work that must be asked of each new advisor once, such as the
 * out-of-usage flow's claims (spec `claude-account-fleet` X). The listener runs
 * after the registration took effect; a throw is logged and ignored.
 *
 * @param listener - Receives the new advisor's owner id.
 * @returns A function that stops listening.
 */
export function onAccountAdvisorRegistered(listener: RegistrationListener): () => void {
  registrationListeners.add(listener);
  return () => {
    registrationListeners.delete(listener);
  };
}

/**
 * Register the account advisor on behalf of `ownerId` (an extension id).
 *
 * @param ownerId - Who registered it, named in the replacement warning.
 * @param advisor - The advisor; it must have a `rank` function.
 * @returns A function that removes this advisor, and only this one.
 * @throws {TypeError} When `advisor.rank` is not a function.
 */
export function registerAccountAdvisor(ownerId: string, advisor: AccountAdvisor): () => void {
  if (typeof advisor?.rank !== 'function') {
    throw new TypeError('An account advisor needs a rank(candidates, ctx) function.');
  }
  if (current) {
    logger.warn(
      `[account-advisor] ${ownerId} replaced the account advisor ${current.ownerId} registered`
    );
  }
  const registration: Registration = { ownerId, advisor };
  current = registration;
  logger.info(`[account-advisor] ${ownerId} registered the account advisor`);
  for (const listener of registrationListeners) {
    try {
      listener(ownerId);
    } catch (err) {
      logger.warn('[account-advisor] a registration listener failed', { err: String(err) });
    }
  }
  return () => {
    if (current !== registration) return;
    current = undefined;
    logger.info(`[account-advisor] ${ownerId} removed the account advisor`);
  };
}

/** The extension id of the registered advisor, or `undefined` when none is registered. */
export function accountAdvisorOwner(): string | undefined {
  return current?.ownerId;
}

/** Whether an account advisor is registered. */
export function hasAccountAdvisor(): boolean {
  return current !== undefined;
}

type AdvisorFn<M extends AdvisorMethod> =
  NonNullable<AccountAdvisor[M]> extends (...args: infer A) => infer R
    ? { args: A; result: Awaited<R> }
    : never;

const TIMED_OUT = Symbol('advisor-timed-out');

type Settled<T> = { ok: true; value: T } | { ok: false };

/** Run one advisor method within the bound; `ok: false` on no advisor, no method, a throw or a timeout. */
async function settleAdvisor<M extends AdvisorMethod>(
  method: M,
  args: AdvisorFn<M>['args']
): Promise<Settled<AdvisorFn<M>['result']>> {
  const registration = current;
  const fn = registration?.advisor[method] as ((...a: AdvisorFn<M>['args']) => unknown) | undefined;
  if (!registration || typeof fn !== 'function') return { ok: false };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ADVISOR_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const answer = await Promise.race([
      Promise.resolve().then(() => fn.apply(registration.advisor, args)),
      timeout,
    ]);
    if (answer === TIMED_OUT) {
      logger.warn(
        `[account-advisor] ${registration.ownerId}'s ${method} took longer than ${ADVISOR_TIMEOUT_MS} ms; using the default`
      );
      return { ok: false };
    }
    return { ok: true, value: answer as AdvisorFn<M>['result'] };
  } catch (err) {
    logger.warn(`[account-advisor] ${registration.ownerId}'s ${method} failed; using the default`, {
      err: String(err),
    });
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call one advisor method that ANSWERS something (`rank`, `onLimited`,
 * `modelFallback`, `carryOver`, `claims`), bounded at {@link ADVISOR_TIMEOUT_MS}.
 *
 * @param method - The method to call.
 * @param args - Its arguments.
 * @returns The advisor's (unvalidated) answer, or `undefined` when no advisor
 *   is registered, it lacks the method, it throws, or it takes too long.
 */
export async function callAdvisor<M extends AnsweringAdvisorMethod>(
  method: M,
  ...args: AdvisorFn<M>['args']
): Promise<AdvisorFn<M>['result'] | undefined> {
  const settled = await settleAdvisor(method, args);
  return settled.ok ? settled.value : undefined;
}

/**
 * Call one advisor method whose only answer is whether it succeeded (`move`,
 * `cancelAuto`, `wait` resolve to nothing), bounded at {@link ADVISOR_TIMEOUT_MS}.
 * {@link callAdvisor} cannot tell those apart, since success and failure would
 * both read as `undefined`.
 *
 * @param method - The method to call.
 * @param args - Its arguments.
 * @returns True when it resolved within the bound; false when no advisor is
 *   registered, it lacks the method, it throws, or it takes too long.
 */
export async function invokeAdvisor<M extends VoidAdvisorMethod>(
  method: M,
  ...args: AdvisorFn<M>['args']
): Promise<boolean> {
  return (await settleAdvisor(method, args)).ok;
}

/**
 * An account's usage as an extension may see it: without `path`, so no
 * account's config folder leaves the server through the extension API.
 *
 * @param usage - The store's reading.
 */
export function toExtensionAccountUsage(usage: AccountUsage): ExtensionAccountUsage {
  const { path: _path, ...rest } = usage;
  return rest;
}

// === Validation ===

const RankingRowSchema = z.object({
  runtime: z.string().min(1).optional(),
  id: z.string().min(1),
  eligible: z.boolean(),
  reason: z.string().trim().min(1),
  badge: z.enum(['recommended', 'reserved']).optional(),
});

const RankingSchema = z.object({
  accounts: z.array(z.unknown()),
  recommendedId: z.string().nullable(),
});

/** One row of a validated ranking; `runtime` is always filled in. */
export type ValidRankingRow = AdvisorRanking['accounts'][number] & { runtime: string };

/**
 * Validate an advisor's ranking: keep only well-formed rows naming a known
 * account (the first of any duplicate), fill in each row's runtime, cut a
 * `reason` longer than {@link MAX_RANKING_REASON_LENGTH} to fit (it is shown to
 * a person), and keep `recommendedId` only when it names a kept ELIGIBLE row of
 * `opts.runtime` (never an ineligible account or another runtime's).
 *
 * @param ranking - The advisor's answer.
 * @param opts.runtime - The runtime a row without one belongs to.
 * @param opts.isKnown - Whether `(runtime, id)` is an account core may offer.
 * @returns The validated ranking, or `null` when the answer is not a ranking at all.
 */
export function validateAdvisorRanking(
  ranking: unknown,
  opts: { runtime: string; isKnown: (runtime: string, id: string) => boolean }
): { accounts: ValidRankingRow[]; recommendedId: string | null } | null {
  const parsed = RankingSchema.safeParse(ranking);
  if (!parsed.success) return null;
  const seen = new Set<string>();
  const accounts: ValidRankingRow[] = [];
  for (const raw of parsed.data.accounts) {
    const row = RankingRowSchema.safeParse(raw);
    if (!row.success) continue;
    const runtime = row.data.runtime ?? opts.runtime;
    const key = `${runtime}\u0000${row.data.id}`;
    if (seen.has(key) || !opts.isKnown(runtime, row.data.id)) continue;
    seen.add(key);
    let reason = row.data.reason;
    // Measured and cut in code points, so an emoji is never split into a lone surrogate.
    const codePoints = Array.from(reason);
    if (codePoints.length > MAX_RANKING_REASON_LENGTH) {
      logger.warn(
        `[account-advisor] a ranking reason for ${runtime}/${row.data.id} was ${codePoints.length} characters; cut to ${MAX_RANKING_REASON_LENGTH}`
      );
      reason = `${codePoints
        .slice(0, MAX_RANKING_REASON_LENGTH - 1)
        .join('')
        .trimEnd()}\u2026`;
    }
    accounts.push({ ...row.data, reason, runtime });
  }
  const recommended = parsed.data.recommendedId;
  const recommendedId = accounts.some(
    (a) => a.id === recommended && a.runtime === opts.runtime && a.eligible
  )
    ? recommended
    : null;
  return { accounts, recommendedId };
}

const LimitedPlanSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto'), target: z.string().min(1), delaySeconds: z.number() }),
  z.object({ mode: z.literal('wait'), resumeAt: z.iso.datetime({ offset: true }).optional() }),
  z.object({ mode: z.literal('ask') }),
]);

/**
 * Validate an advisor's plan for a limited session: `delaySeconds` is clamped
 * to 0..{@link MAX_AUTO_DELAY_SECONDS}, and an `auto` plan is refused when its
 * target is not a registered account or is the account that ran out.
 *
 * @param plan - The advisor's answer.
 * @param opts.limitedAccountId - The account that ran out.
 * @param opts.isRegistered - Whether an id names a registered account.
 * @returns The plan to use, or `null` to use core's default.
 */
export function validateLimitedPlan(
  plan: unknown,
  opts: { limitedAccountId: string | null; isRegistered: (id: string) => boolean }
): LimitedPlan | null {
  const parsed = LimitedPlanSchema.safeParse(plan);
  if (!parsed.success) return null;
  const answer = parsed.data;
  if (answer.mode !== 'auto') return answer;
  if (answer.target === opts.limitedAccountId || !opts.isRegistered(answer.target)) return null;
  const delay = Number.isFinite(answer.delaySeconds) ? answer.delaySeconds : 0;
  return {
    mode: 'auto',
    target: answer.target,
    delaySeconds: Math.min(MAX_AUTO_DELAY_SECONDS, Math.max(0, delay)),
  };
}

const CarryOverSeedSchema = z.object({
  seedContext: z.string().min(1).max(SEED_CONTEXT_MAX_LENGTH),
  prompt: z.string().min(1).optional(),
});

/**
 * Validate an advisor's carry-over seed: refused when its `seedContext` is
 * empty or longer than `SEED_CONTEXT_MAX_LENGTH`.
 *
 * @param seed - The advisor's answer.
 * @returns The seed, or `null` to use core's default summary.
 */
export function validateCarryOverSeed(seed: unknown): CarryOverSeed | null {
  const parsed = CarryOverSeedSchema.safeParse(seed);
  return parsed.success ? parsed.data : null;
}

/**
 * Reset the registry. Tests only.
 *
 * @internal
 */
export function __resetAccountAdvisorForTests(): void {
  current = undefined;
  registrationListeners.clear();
}
