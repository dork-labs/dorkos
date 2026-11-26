/**
 * How the marketplace's reads refuse over HTTP once the capability mount
 * serves them (DOR-4978): the codes and sentences the hand routes answered
 * with.
 *
 * A capability refuses with a `CapabilityToolError`, whose problem comes from
 * a fixed table (`routes/capability-refusals.ts`, ADR 261123-170831), never the
 * handler's own words. So each refusal is one tool code here with its fixed
 * sentence. A marketplace error the hand routes mapped through
 * `mapErrorToProblem` keeps that mapping's code and sentence: one tool code per
 * problem code, listing every sentence the mapping says under it. The two
 * sentences that point at a field the mount never sends (`errors`,
 * `conflicts`) get their own shorter wording.
 *
 * @module services/marketplace/doors/marketplace-refusals
 */
import type { ProblemCode } from '@dorkos/shared/problem';

import { CapabilityToolError } from '../../core/capabilities/capability-definition.js';
import { marketplaceProblemOf } from '../lib/error-problem.js';

/** One refusal: its problem code, its fixed sentence, and any other sentence it may say. */
export interface MarketplaceToolRefusal {
  /** The problem code. */
  readonly code: ProblemCode;
  /** The sentence sent for this refusal. */
  readonly detail: string;
  /** Other sentences this refusal may say, each sent as it is. */
  readonly alsoSays?: readonly string[];
}

/** The marketplace reads' entries in the refusal table, keyed by tool code. */
export const MARKETPLACE_TOOL_REFUSALS = {
  MARKETPLACE_SOURCES_UNLISTED: {
    code: 'internal_error',
    detail: 'Couldn’t list the marketplace sources.',
  },
  MARKETPLACE_CACHE_UNREADABLE: {
    code: 'internal_error',
    detail: "Couldn't read the cache status. Try again.",
  },
  MARKETPLACE_INSTALLED_UNLISTED: {
    code: 'internal_error',
    detail: "Couldn't list installed packages. Try again.",
  },
  MARKETPLACE_INSTALLED_UNREADABLE: {
    code: 'internal_error',
    detail: "Couldn't read that installed package. Try again.",
  },
  MARKETPLACE_HELD_BACK_UNLISTED: {
    code: 'internal_error',
    detail: "Couldn't list held-back packages. Try again.",
  },
  MARKETPLACE_DEV_LINKS_UNAVAILABLE: {
    code: 'temporarily_unavailable',
    detail: "Dev links aren't available on this server right now.",
  },
  MARKETPLACE_DEV_LINKS_UNLISTED: {
    code: 'internal_error',
    detail: "Couldn't list dev links. Try again.",
  },
  MARKETPLACE_PROJECT_PATH_REPEATED: {
    code: 'invalid_request',
    detail: 'Send `projectPath` only once.',
  },
  MARKETPLACE_PROJECT_PATH_OUTSIDE: {
    code: 'outside_boundary',
    detail: '`projectPath` is outside the folders DorkOS may use.',
  },
  // What `mapErrorToProblem` (`../lib/error-problem.ts`) answers, by code.
  MARKETPLACE_INVALID_REQUEST: {
    code: 'invalid_request',
    // The mount sends no `errors`, so it says less than the hand routes' sentence.
    detail: "That package isn't valid.",
    alsoSays: [
      'That path resolves outside its own folder. Nothing was changed.',
      "That package or marketplace name can't be used. Pick another.",
      "This package ships files DorkOS can't install. Nothing was written.",
      "DorkOS can't fetch from that address. Use an https:// or file:// address.",
    ],
  },
  MARKETPLACE_OUTSIDE_BOUNDARY: {
    code: 'outside_boundary',
    detail: 'Pick a folder DorkOS may use.',
  },
  MARKETPLACE_CONFLICT: {
    code: 'conflict',
    // The mount sends no `conflicts`, so it says less than the hand routes' sentence.
    detail: 'Installing would clash with what is already here.',
    alsoSays: [
      'An app with that name is already connected. Remove or rename it, then install again.',
    ],
  },
  MARKETPLACE_PRECONDITION_FAILED: {
    code: 'precondition_failed',
    detail: 'This package changed what it runs since you looked. Review it again.',
  },
  MARKETPLACE_NOT_FOUND: {
    code: 'not_found',
    detail: "That package isn't installed here.",
    alsoSays: [
      "Some of those packages aren't installed here.",
      'No configured marketplace lists that package.',
      "That marketplace isn't configured. Add it first.",
      "That version isn't in the package's repository.",
    ],
  },
  MARKETPLACE_UPSTREAM_UNAVAILABLE: {
    code: 'upstream_unavailable',
    detail: "Couldn't reach the package's repository. Try again.",
  },
  MARKETPLACE_INTERNAL_ERROR: {
    code: 'internal_error',
    detail: 'Something went wrong on the DorkOS side. Try again.',
  },
} as const satisfies Readonly<Record<string, MarketplaceToolRefusal>>;

/** A tool code of {@link MARKETPLACE_TOOL_REFUSALS}. */
export type MarketplaceRefusalCode = keyof typeof MARKETPLACE_TOOL_REFUSALS;

/** Whether `code` is a tool code of {@link MARKETPLACE_TOOL_REFUSALS}. */
function isMarketplaceRefusalCode(code: string): code is MarketplaceRefusalCode {
  return Object.hasOwn(MARKETPLACE_TOOL_REFUSALS, code);
}

/**
 * A marketplace refusal, as a handler throws it.
 *
 * @param code - The tool code.
 * @param error - The sentence, when the entry lists more than one; else its own.
 */
export function marketplaceRefusal(
  code: MarketplaceRefusalCode,
  error?: string
): CapabilityToolError {
  return new CapabilityToolError({
    code,
    error: error ?? MARKETPLACE_TOOL_REFUSALS[code].detail,
  });
}

/**
 * What a marketplace error the hand routes answered through `mapErrorToProblem`
 * throws on the mount: the same code and sentence, and the same log line. The
 * problem's extension members (`errors`, `conflicts`) do not ride along.
 *
 * @param err - What the marketplace threw.
 */
export function marketplaceFailure(err: unknown): CapabilityToolError {
  const problem = marketplaceProblemOf(err);
  const code = `MARKETPLACE_${problem.code.toUpperCase()}`;
  return isMarketplaceRefusalCode(code)
    ? marketplaceRefusal(code, problem.detail)
    : marketplaceRefusal('MARKETPLACE_INTERNAL_ERROR');
}
